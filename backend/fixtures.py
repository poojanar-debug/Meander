"""Record-and-replay layer around the shared httpx client, plus a hard live-call budget.

Every outbound request in Meander goes through here. There are no exceptions,
and the test suite blocks sockets to keep it that way.

Why this exists: GraphHopper's free tier is 500 credits/day and one route
request costs about three. A development loop that calls the live service will
exhaust the day's quota in minutes, after which every call fails with an error
that looks exactly like a bug in the routing code. Recording the first response
for a request signature and replaying it forever after removes that failure mode
entirely.

Modes (``MEANDER_FIXTURES``):

``replay``  default. Never opens a socket. A signature with no fixture raises
            FixtureMissing.
``record``  replays a known signature; goes live for a new one and writes the
            fixture.
``live``    always goes live, and still writes the fixture.

Budgets are hard ceilings for the whole project, counted in ``fixtures/_budget.json``.
When a service hits its cap it is silently downgraded to replay-only and a
warning is logged once — the run continues rather than dying, and nothing
retries around the cap.

Provenance: every response carries an ``x-meander-provenance`` header of
``live``, ``recorded`` or ``synthetic``. A hand-built fixture is ``synthetic``
and callers must degrade any number derived from it — see routing.py, which
forces ``scoring_method: "placeholder"`` in that case.
"""

from __future__ import annotations

import hashlib
import json
import threading
import time
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import (
    FIXTURE_DIR,
    HTTP_CONNECT_TIMEOUT_S,
    HTTP_TIMEOUT_S,
    LIVE_CALL_BUDGET,
    SECRET_HEADERS,
    SECRET_QUERY_PARAMS,
    SERVICE_HOSTS,
    graphhopper_is_self_hosted,
    settings,
)
from .logging_setup import get_logger

log = get_logger(__name__)

PROVENANCE_HEADER = "x-meander-provenance"
PROVENANCE_LIVE = "live"
PROVENANCE_RECORDED = "recorded"
PROVENANCE_SYNTHETIC = "synthetic"

_REDACTED = "<redacted>"


class FixtureMissing(RuntimeError):
    """No fixture for this request, and the mode forbids going live."""

    def __init__(self, service: str, signature: str, url: str) -> None:
        self.service = service
        self.signature = signature
        super().__init__(
            f"No fixture for {service} request {signature} ({url}). "
            f"Run with MEANDER_FIXTURES=record to record it, or add a synthetic "
            f"fixture at {fixture_path(service, signature)}."
        )


# Generous against what these APIs actually return — the largest committed
# fixture is a few hundred KB — and small against a 1 GB container.
MAX_RESPONSE_BYTES = 32 * 1024 * 1024


def envelope_provenance(envelope: dict[str, Any]) -> str:
    """How a fixture came to exist, defaulting to synthetic when it does not say.

    ⚠ **One helper because there were two defaults, and they disagreed.** The
    loader defaulted a provenance-less envelope to `synthetic` — deliberately,
    because a hand-written fixture is exactly what `FixtureMissing`'s own
    message tells a developer to create, and calling invented data "recorded"
    is the substitution this project must never make. `fixture_inventory`
    defaulted the same envelope to `recorded`, so `/api/health` reported
    invented data as measured while the loader treated it as invented.

    Synthetic is the safe direction: it understates what is known.
    """
    value = envelope.get("_meander_provenance")
    return str(value) if value else PROVENANCE_SYNTHETIC


class ResponseTooLarge(RuntimeError):
    """An upstream sent more than MAX_RESPONSE_BYTES. Treated as a failure, not
    truncated: half a JSON document is not a smaller answer, it is not an answer.
    """


class BudgetExhausted(RuntimeError):
    """A service hit its hard live-call cap and has no fixture for this request."""


# ---------------------------------------------------------------------------
# service identification
# ---------------------------------------------------------------------------


def service_for_url(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    if host in SERVICE_HOSTS:
        return SERVICE_HOSTS[host]
    # Fall back to the registrable-looking suffix so an unknown host still gets
    # its own directory and its own (zero) budget rather than sharing one.
    return host.replace(".", "_") or "unknown"


# ---------------------------------------------------------------------------
# request signature
# ---------------------------------------------------------------------------


def _canonical(value: Any) -> Any:
    """Order-independent representation, so dict iteration order cannot change a hash."""
    if isinstance(value, Mapping):
        return {k: _canonical(value[k]) for k in sorted(value, key=str)}
    if isinstance(value, list | tuple):
        return [_canonical(v) for v in value]
    if isinstance(value, float) and value.is_integer():
        # 6.0 and 6 must not produce different fixtures.
        return int(value)
    return value


def _strip_secret_params(params: Mapping[str, Any] | None) -> dict[str, Any]:
    if not params:
        return {}
    return {k: v for k, v in params.items() if k.lower() not in SECRET_QUERY_PARAMS}


def _strip_secret_headers(headers: Mapping[str, Any] | None) -> dict[str, Any]:
    if not headers:
        return {}
    return {
        k.lower(): v
        for k, v in headers.items()
        # Content-type changes the body encoding, so it stays in the signature.
        # Everything else is transport noise or a secret.
        if k.lower() not in SECRET_HEADERS and k.lower() in {"content-type", "accept"}
    }


def signature(
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    json_body: Any = None,
    data: Mapping[str, Any] | None = None,
    content: str | bytes | None = None,
    headers: Mapping[str, Any] | None = None,
) -> str:
    """Stable hash of everything that changes the response.

    Secrets are excluded on purpose: two contributors with different API keys
    must produce the same signature, or fixtures would not be shareable.
    """
    split = urlsplit(url)
    if isinstance(content, bytes):
        content_repr: str | None = content.decode("utf-8", errors="replace")
    else:
        content_repr = content

    payload = {
        "method": method.upper(),
        "host": (split.hostname or "").lower(),
        "path": split.path,
        "params": _canonical(_strip_secret_params(params)),
        "json": _canonical(json_body),
        "data": _canonical(_strip_secret_params(data)),
        "content": content_repr,
        "headers": _canonical(_strip_secret_headers(headers)),
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def fixture_path(service: str, sig: str) -> Path:
    return FIXTURE_DIR / service / f"{sig}.json"


# ---------------------------------------------------------------------------
# live-call budget
# ---------------------------------------------------------------------------


def utc_day() -> str:
    """Today's UTC date. A seam, so the rollover can be tested without waiting."""
    return datetime.now(UTC).date().isoformat()


class LiveCallBudget:
    """Per-service ceiling on live calls, persisted across processes.

    **Per UTC day, not per lifetime.** It used to be a lifetime total with no
    reset anywhere — `reset()` existed but had no caller in production or in
    tests — so the only way to get more calls was to know that
    ``fixtures/_budget.json`` existed and delete it. Nobody should have to
    learn that.

    Single-process locking only. Two backends sharing one checkout could
    overshoot slightly; the caps have enough headroom that this does not matter.
    """

    def __init__(self, path: Path | None = None, caps: Mapping[str, int] | None = None) -> None:
        # Resolved at call time so tests can redirect FIXTURE_DIR.
        self.path = path if path is not None else FIXTURE_DIR / "_budget.json"
        self.caps = dict(caps if caps is not None else LIVE_CALL_BUDGET)
        self._lock = threading.Lock()
        self._warned: set[str] = set()
        self._day: str = utc_day()
        self._state: dict[str, int] = self._load()

    def _load(self) -> dict[str, int]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text())
        except (OSError, json.JSONDecodeError) as exc:
            log.warning("budget_file_unreadable", extra={"error": str(exc)})
            return {}
        # A file from a previous day is stale, not authoritative. Counters from
        # yesterday must not eat into today's allowance.
        if raw.get("day") != self._day:
            return {}
        counts = raw.get("live_calls", {})
        return {k: int(v) for k, v in counts.items() if isinstance(v, int | float)}

    def _roll_if_new_day(self) -> None:
        """Zero the counters when the UTC date has moved on. Caller holds the lock."""
        today = utc_day()
        if today != self._day:
            log.info("live_call_budget_rolled", extra={"from_day": self._day, "to_day": today})
            self._day = today
            self._state = {}
            self._warned = set()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "note": (
                "Machine-local live-call counters, per UTC day. Gitignored. "
                "Resets on its own at midnight UTC."
            ),
            "day": self._day,
            "updated_at": datetime.now(UTC).isoformat(),
            "caps": self.caps,
            "live_calls": self._state,
        }
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
        tmp.replace(self.path)

    def cap_for(self, service: str) -> int:
        # An unbudgeted service gets zero live calls rather than unlimited ones:
        # a typo in a hostname must not become an uncapped spend.
        return self.caps.get(service, 0)

    def spent(self, service: str) -> int:
        with self._lock:
            self._roll_if_new_day()
            return self._state.get(service, 0)

    def remaining(self, service: str) -> int:
        return max(0, self.cap_for(service) - self.spent(service))

    def try_spend(self, service: str, cost: int = 1) -> bool:
        """Reserve ``cost`` live calls. False means today's cap is reached."""
        with self._lock:
            self._roll_if_new_day()
            used = self._state.get(service, 0)
            if used + cost > self.cap_for(service):
                if service not in self._warned:
                    self._warned.add(service)
                    log.warning(
                        "live_call_cap_reached",
                        extra={
                            "service": service,
                            "cap": self.cap_for(service),
                            "spent": used,
                            "action": "downgraded to replay-only for the rest of this run",
                        },
                    )
                return False
            self._state[service] = used + cost
            self._save()
            return True

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            self._roll_if_new_day()
            return {
                "day": self._day,
                "services": {
                    service: {
                        "cap": cap,
                        "spent": self._state.get(service, 0),
                        "remaining": max(0, cap - self._state.get(service, 0)),
                    }
                    for service, cap in sorted(self.caps.items())
                },
            }

    def reset(self) -> None:
        with self._lock:
            self._day = utc_day()
            self._state = {}
            self._warned = set()
            self._save()


_budget: LiveCallBudget | None = None
_budget_lock = threading.Lock()


def get_budget() -> LiveCallBudget:
    global _budget
    if _budget is None:
        with _budget_lock:
            if _budget is None:
                _budget = LiveCallBudget()
    return _budget


def budget_snapshot() -> dict[str, Any]:
    return get_budget().snapshot()


def budget_applies(service: str) -> tuple[bool, str]:
    """Should the live-call budget be consulted for this request, and why not?

    The budget exists for exactly one job: stop a **development loop** quietly
    draining a 500-credit/day quota and then failing in a way that looks like a
    bug in the routing code. It was never a production control, but it behaved
    like one — ``fetch()`` skipped the fixture read in live mode and still
    called ``try_spend()``, so the cap applied to a deployed instance.

    Do the arithmetic that made this a launch blocker. ``_post_route`` passes
    ``cost=3``, and one round-trip request runs up to 6 scenic candidates plus
    fastest plus accessible: 8 x 3 = 24 units against an 80-unit cap. **Three
    route requests per container, ever**, and then 503 until someone deleted a
    file they had never heard of.

    Two exemptions, both structural rather than configured:

    * **live mode** — production. It is protected by the per-IP rate limiter and
      the daily route ceiling, which are per-day and reset. Setting five
      MEANDER_BUDGET_* variables was a workaround for this, and forgetting one
      produced a service that worked for three requests and then stopped.
    * **a self-hosted router** — there is no quota to protect. Metering a server
      you own and pay nothing to query at 3 credits a call is nonsense.
    """
    if current_mode() == "live":
        return False, "live_mode"
    if service == "graphhopper" and graphhopper_is_self_hosted():
        return False, "self_hosted_router"
    return True, "enforced"


def budget_regime() -> dict[str, Any]:
    """Which regime is in force, for /api/health."""
    applies, reason = budget_applies("graphhopper")
    return {
        "enforced": applies,
        "reason": reason,
        "note": (
            "Development guard rail only. Production is protected by the per-IP "
            "rate limiter and the daily route ceiling."
        ),
    }


def reset_budget_singleton() -> None:
    """Test hook."""
    global _budget
    with _budget_lock:
        _budget = None


# ---------------------------------------------------------------------------
# fixture read / write
# ---------------------------------------------------------------------------


def _redact(mapping: Mapping[str, Any] | None, banned: frozenset[str]) -> dict[str, Any]:
    if not mapping:
        return {}
    return {k: (_REDACTED if k.lower() in banned else v) for k, v in mapping.items()}


def read_fixture(service: str, sig: str) -> httpx.Response | None:
    path = fixture_path(service, sig)
    if not path.exists():
        return None
    try:
        envelope = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        log.error("fixture_unreadable", extra={"service": service, "sig": sig, "error": str(exc)})
        return None

    resp_spec = envelope.get("response", {})
    # Defaults to synthetic, not recorded. The missing key used to mean
    # "recorded", which fails open in the one direction this project cannot
    # afford: a file with no provenance is stamped as a real measurement, so
    # is_synthetic() is False, synthetic_upstream stays False, and
    # scoring_method is never forced to "placeholder" — invented terrain
    # shipped as a measurement, which is exactly what SYNTHETIC_NOTE exists to
    # prevent.
    #
    # It is reachable by the route FixtureMissing itself recommends: its message
    # tells a developer to "add a synthetic fixture at <path>", and a
    # hand-written file that omits the key is the obvious result. Every
    # committed fixture carries the key, so nothing changes for them.
    provenance = envelope_provenance(envelope)
    headers = dict(resp_spec.get("headers") or {})
    headers[PROVENANCE_HEADER] = provenance

    if "json" in resp_spec:
        content = json.dumps(resp_spec["json"]).encode("utf-8")
        headers.setdefault("content-type", "application/json")
    else:
        content = str(resp_spec.get("text", "")).encode("utf-8")

    # content-length from the recording will not match a re-encoded body.
    headers.pop("content-length", None)
    headers.pop("Content-Length", None)
    headers.pop("content-encoding", None)
    headers.pop("Content-Encoding", None)

    return httpx.Response(
        status_code=int(resp_spec.get("status", 200)),
        headers=headers,
        content=content,
        request=httpx.Request(
            envelope.get("request", {}).get("method", "GET"),
            envelope.get("request", {}).get("url", "https://replayed.invalid/"),
        ),
    )


def write_fixture(
    service: str,
    sig: str,
    *,
    method: str,
    url: str,
    params: Mapping[str, Any] | None,
    json_body: Any,
    data: Mapping[str, Any] | None,
    content: str | bytes | None,
    headers: Mapping[str, Any] | None,
    response: httpx.Response,
    provenance: str = PROVENANCE_RECORDED,
) -> Path:
    path = fixture_path(service, sig)
    path.parent.mkdir(parents=True, exist_ok=True)

    # The URL may embed a key as a query parameter; store the path only.
    split = urlsplit(url)
    safe_url = f"{split.scheme}://{split.netloc}{split.path}"

    body: dict[str, Any]
    try:
        body = {"json": response.json()}
    except (ValueError, json.JSONDecodeError):
        body = {"text": response.text}

    envelope: dict[str, Any] = {
        "_meander_provenance": provenance,
        "_meander_recorded_at": datetime.now(UTC).isoformat(),
        "_meander_note": (
            "Written by backend/fixtures.py. Secrets are redacted and excluded "
            "from the request signature."
        ),
        "request": {
            "method": method.upper(),
            "url": safe_url,
            "params": _redact(params, SECRET_QUERY_PARAMS),
            "json": json_body,
            "data": _redact(data, SECRET_QUERY_PARAMS),
            "content": (
                content.decode("utf-8", "replace") if isinstance(content, bytes) else content
            ),
            "headers": _redact(headers, SECRET_HEADERS),
        },
        "response": {
            "status": response.status_code,
            "headers": {
                k: v
                for k, v in response.headers.items()
                if k.lower() in {"content-type", "date", "x-ratelimit-remaining"}
            },
            **body,
        },
    }
    path.write_text(json.dumps(envelope, indent=2, sort_keys=False))
    return path


def _assert_no_secret_in_fixture(path: Path) -> None:
    """Backstop against a key reaching disk. Cheap, and the failure mode is severe."""
    text = path.read_text()
    for value in (
        settings.graphhopper_key,
        settings.mapillary_token,
        settings.anthropic_api_key,
        settings.osm_dev_token,
    ):
        if value and value in text:
            path.unlink(missing_ok=True)
            raise RuntimeError(
                f"A secret leaked into fixture {path.name}; the file has been deleted. "
                "This is a bug in the redaction list in config.py."
            )


# ---------------------------------------------------------------------------
# the shared client
# ---------------------------------------------------------------------------

_client: httpx.AsyncClient | None = None
_client_lock = threading.Lock()

USER_AGENT = "Meander/0.1 (+https://github.com/meander-routing/meander)"


def get_client() -> httpx.AsyncClient:
    """The one shared httpx client. Never construct another."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                _client = httpx.AsyncClient(
                    timeout=httpx.Timeout(HTTP_TIMEOUT_S, connect=HTTP_CONNECT_TIMEOUT_S),
                    headers={"User-Agent": USER_AGENT},
                    # None of the seven APIs this client talks to redirects.
                    # Following them meant this process would chase up to 20
                    # hops to any host a response named, from inside the
                    # container: `graphhopper:8989` and `:8990` are an
                    # unauthenticated Dropwizard admin interface on the same
                    # compose network, and the cloud IMDS is one hop away.
                    # /api/geocode reflects `display_name`, `lat` and `lon` from
                    # whatever came back, so it is a narrow read channel out.
                    #
                    # A redirect is now a response like any other. If one of
                    # these APIs ever starts issuing them, the call fails
                    # visibly rather than silently following.
                    follow_redirects=False,
                )
    return _client


async def aclose_client() -> None:
    global _client
    client = _client
    _client = None
    if client is not None:
        await client.aclose()


def current_mode() -> str:
    return settings.fixture_mode


# Provenance stamped on fixtures written by fetch(). Only the synthetic-fixture
# generator changes this, and only because a hand-built response must be
# labelled as one for its whole life.
_record_provenance = PROVENANCE_RECORDED


@contextmanager
def recording_as(provenance: str) -> Iterator[None]:
    global _record_provenance
    previous = _record_provenance
    _record_provenance = provenance
    try:
        yield
    finally:
        _record_provenance = previous


async def fetch(
    method: str,
    url: str,
    *,
    params: Mapping[str, Any] | None = None,
    json_body: Any = None,
    data: Mapping[str, Any] | None = None,
    content: str | bytes | None = None,
    headers: Mapping[str, Any] | None = None,
    cost: int = 1,
    service: str | None = None,
    persist: bool | None = None,
) -> httpx.Response:
    """Fetch through the record/replay layer.

    ``cost`` is how many live calls this request consumes from the service
    budget — GraphHopper charges roughly three credits per route request.

    ``persist`` decides whether a successful response is written to
    ``fixtures/``:

    ``None``   default — write only when the mode is ``record``. A deployed
               instance runs in ``live`` mode and must write nothing: it used to
               write a fixture **and read the file straight back** to assert no
               secret had leaked, so every upstream call cost two synchronous
               disk operations on a single-worker event loop, grew the disk
               without bound, and persisted third-party response bodies with no
               retention policy. Nothing ever read them — in live mode the read
               path was skipped on the happy path.
    ``False``  never write, even when recording. For binary payloads: committing
               megabytes of street imagery would bloat the repository, and those
               responses need no replaying because the expensive thing derived
               from them — the CLIP score — is persisted in data/cache.db.
    ``True``   always write. Only scripts/make_synthetic_fixtures.py, which
               forces ``live`` mode against a MockTransport precisely so it can
               regenerate fixtures that already exist. Writing is that script's
               entire purpose, so it says so at the call site.
    """
    service = service or service_for_url(url)
    sig = signature(
        method,
        url,
        params=params,
        json_body=json_body,
        data=data,
        content=content,
        headers=headers,
    )
    mode = current_mode()

    if mode != "live":
        cached = read_fixture(service, sig)
        if cached is not None:
            log.debug("fixture_hit", extra={"service": service, "sig": sig})
            return cached
        if mode == "replay":
            raise FixtureMissing(service, sig, url)

    metered, _ = budget_applies(service)
    if metered:
        # Only reachable in `record` mode, and only for a signature with no
        # fixture — the read above already returned for anything cached. So an
        # exhausted budget can never block a request that could have been
        # served from disk, and there is nothing left to retry here. (The
        # re-read that used to sit in this branch existed because live mode
        # skipped the first one; live mode no longer reaches the budget at all.)
        budget = get_budget()
        if not budget.try_spend(service, cost):
            raise BudgetExhausted(
                f"{service} live-call cap of {budget.cap_for(service)} reached for today "
                f"and no fixture exists for {sig}. This request is being skipped, not "
                f"retried. The cap resets at midnight UTC."
            )
        remaining: int | None = budget.remaining(service)
    else:
        # No counter is touched and no JSON is written — this is the production
        # path, and it used to do a synchronous disk write per upstream call.
        remaining = None

    client = get_client()
    started = time.monotonic()
    # Streamed rather than read whole, so the body can be capped as it arrives.
    #
    # httpx decompresses gzip and brotli transparently, so a declared
    # Content-Length is not a bound on what lands in memory — a small compressed
    # body can expand to an arbitrarily large one, in a container limited to
    # 1 GB. Counting decoded bytes as they arrive is the only cap that holds
    # against that, and it applies to every upstream rather than to the ones
    # that happen to be honest about their size.
    request = client.build_request(
        method.upper(),
        url,
        params=dict(params) if params else None,
        json=json_body,
        data=dict(data) if data else None,
        content=content,
        headers=dict(headers) if headers else None,
    )
    response = await client.send(request, stream=True)
    try:
        chunks: list[bytes] = []
        size = 0
        async for chunk in response.aiter_bytes():
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                await response.aclose()
                raise ResponseTooLarge(
                    f"{service_for_url(url)} sent more than "
                    f"{MAX_RESPONSE_BYTES // (1024 * 1024)} MB and was cut off."
                )
            chunks.append(chunk)
        body = b"".join(chunks)
    finally:
        await response.aclose()
    # The body is already read *and already decoded* — aiter_bytes() yields
    # decompressed bytes — so the hop-by-hop encoding headers must not travel
    # with it. Passing Content-Encoding through made httpx try to gunzip
    # plaintext on the way back out, and every live call failed with a
    # DecodingError that no offline test could see, because the offline suite
    # never goes live. Content-Length would be a lie for the same reason.
    passthrough = httpx.Headers(
        [
            (k, v)
            for k, v in response.headers.multi_items()
            if k.lower() not in {"content-encoding", "content-length", "transfer-encoding"}
        ]
    )
    response = httpx.Response(
        status_code=response.status_code,
        headers=passthrough,
        content=body,
        request=request,
    )
    # Logged after, with the duration, so "which upstream is slow" is answerable
    # from the logs rather than by guessing. This is how Overpass at 13.6 s
    # against GraphHopper at 0.024 s became visible in the first place.
    log.info(
        "live_call",
        extra={
            "service": service,
            "sig": sig,
            "cost": cost,
            "remaining": remaining,
            "status": response.status_code,
            "duration_ms": round((time.monotonic() - started) * 1000, 1),
        },
    )

    if response.status_code >= 400:
        # Recording a 4xx/5xx would permanently replay an outage or a bad key.
        log.warning(
            "live_call_error_not_recorded",
            extra={"service": service, "sig": sig, "status": response.status_code},
        )
    elif (mode == "record") if persist is None else persist:
        path = write_fixture(
            service,
            sig,
            method=method,
            url=url,
            params=params,
            json_body=json_body,
            data=data,
            content=content,
            headers=headers,
            response=response,
            provenance=_record_provenance,
        )
        _assert_no_secret_in_fixture(path)

    response.headers[PROVENANCE_HEADER] = (
        PROVENANCE_SYNTHETIC if _record_provenance == PROVENANCE_SYNTHETIC else PROVENANCE_LIVE
    )
    return response


def provenance_of(response: httpx.Response) -> str:
    return response.headers.get(PROVENANCE_HEADER, PROVENANCE_LIVE)


def is_synthetic(response: httpx.Response) -> bool:
    """True when this response came from a hand-built fixture, not a real service.

    Callers must degrade anything derived from it — a synthetic response is never
    allowed to produce a number the UI presents as measured.
    """
    return provenance_of(response) == PROVENANCE_SYNTHETIC


def fixture_inventory() -> dict[str, dict[str, int]]:
    """Counts per service, split by provenance. Surfaced on /api/health."""
    out: dict[str, dict[str, int]] = {}
    if not FIXTURE_DIR.exists():
        return out
    for service_dir in sorted(FIXTURE_DIR.iterdir()):
        if not service_dir.is_dir():
            continue
        counts = {"recorded": 0, "synthetic": 0}
        for f in service_dir.glob("*.json"):
            try:
                prov = envelope_provenance(json.loads(f.read_text()))
            except (OSError, json.JSONDecodeError):
                continue
            counts[prov] = counts.get(prov, 0) + 1
        if any(counts.values()):
            out[service_dir.name] = counts
    return out
