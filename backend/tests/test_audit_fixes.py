"""Part 9 findings that have no other natural home.

Each test names the sentence or the status code a user would see, because that
is what has to keep not happening. The mechanism is what changes.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend import main as main_mod
from backend.accessibility import RouteAccessibility, Verdict

# ---------------------------------------------------------------------------
# 9b — reporting the result of a check that did not run
# ---------------------------------------------------------------------------


def _access(*, coverage: float, barriers_checked: bool) -> RouteAccessibility:
    return RouteAccessibility(
        verdict=Verdict.UNKNOWN,
        coverage=coverage,
        barriers_checked=barriers_checked,
    )


def test_a_route_does_not_report_a_barrier_check_that_never_ran() -> None:
    """One route object used to carry both claims and contradict itself.

    `_status_note` said "No barriers were found" on coverage alone, without
    consulting `barriers_checked` — while `access.sentence()`, two paragraphs
    away on the same route, said "Gates and stiles were not checked."

    It is the ordinary path, not an exotic one: the first pass always calls
    `_assess(raw)` with `osm_tags=None`, and when Overpass is unreachable the
    reassessment is skipped entirely.
    """
    note = main_mod._status_note(
        "accessible", False, _access(coverage=0.1, barriers_checked=False)
    )

    assert note is not None
    assert "no barriers were found" not in note.lower()
    assert "could not be checked" in note.lower()


def test_a_route_whose_barriers_were_checked_still_says_so() -> None:
    """The other branch. Nothing found *is* evidence when somebody looked."""
    note = main_mod._status_note(
        "accessible", False, _access(coverage=0.1, barriers_checked=True)
    )

    assert note is not None
    assert "No barriers were found" in note


# ---------------------------------------------------------------------------
# 9h — the 500 envelope no cross-origin browser could read
# ---------------------------------------------------------------------------


def test_an_unhandled_500_carries_the_cors_header(monkeypatch: pytest.MonkeyPatch) -> None:
    """Starlette routes `Exception` handlers through `ServerErrorMiddleware`,
    which sits **outside every user middleware** — so the catch-all 500 was
    produced above CORSMiddleware and never got a header. Measured with
    `Origin:` set: 413 present, 422 present, 429 present, **500 None**.

    A browser reports that to the page as a generic network failure, so the
    envelope the handler exists to guarantee was unreadable by the only client
    that would ever see it. This deployment is cross-origin by construction.

    It is the same defect the 413 was fixed for, arriving by a different route.
    """
    from fastapi.testclient import TestClient

    from backend.config import settings

    origin = settings.allowed_origins[0] if settings.allowed_origins else None
    if origin is None:
        pytest.skip("no allowed origin configured in this environment")

    # An async *generator*, matching what the handler iterates, so the failure
    # arrives the way a real one would rather than as a never-awaited coroutine.
    async def boom(*a, **k):
        raise RuntimeError("nobody anticipated this")
        yield  # pragma: no cover — unreachable, and what makes this a generator

    monkeypatch.setattr(main_mod, "route_events_with_deadline", boom)

    with TestClient(main_mod.app, raise_server_exceptions=False) as client:
        response = client.post(
            "/api/routes",
            json={"origin": {"lat": 51.5, "lon": -0.16}, "minutes": 30},
            headers={"Origin": origin},
        )

    assert response.status_code == 500
    assert response.headers.get("access-control-allow-origin") == origin
    assert response.json()["error"]["kind"] == "internal"


def test_the_cors_reflection_does_not_widen_the_allowlist() -> None:
    """Reflected only for an origin already permitted, so this adds no access."""
    from starlette.requests import Request

    def request_from(origin: str | None) -> Request:
        headers = [(b"origin", origin.encode())] if origin else []
        return Request({"type": "http", "headers": headers, "method": "POST", "path": "/"})

    assert main_mod._reflected_cors(request_from(None)) == {}
    assert main_mod._reflected_cors(request_from("https://evil.example")) == {}


# ---------------------------------------------------------------------------
# 9e — a truncated answer cached for six hours
# ---------------------------------------------------------------------------


def test_a_deadline_truncated_answer_is_tagged_so_it_is_never_cached() -> None:
    """The payload carries `enrichment_pending: True`, `rest_stops: None`, null
    air and shade, `segments_scored: 0` and a sentence telling the reader to try
    again for the full picture. Written with the full 21600s TTL, every later
    user behind that key was served it — and invited to retry into the same
    cached answer.

    A flag on the event rather than a short TTL, because the answer is not
    merely stale: it is incomplete, and a complete one is one request away.
    """
    source = Path(main_mod.__file__).read_text(encoding="utf-8")
    assert '"partial": True' in source
    assert 'if not event.get("partial")' in source
    assert "if not partial_answer:" in source
