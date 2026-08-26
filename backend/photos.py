"""Photographs along a route, fetched by this server and served by this server.

Two decisions shape everything below, and neither is a preference.

**The image host must never see the user.** A route is a person's Tuesday
afternoon, and handing Wikimedia and Mapillary a browser request per photo hands
them the user's IP address alongside a set of coordinates that describes where
that person is about to walk. So the browser talks only to Meander: /api/photos
returns image URLs that point back at this service, and /api/photo/{ref} streams
the bytes. The alternative considered and rejected was returning upstream URLs
and naming the hosts in the frontend's Content-Security-Policy. It fails twice
over. It reintroduces exactly the disclosure the proxy exists to prevent, and
Mapillary's thumbnails come from rotating `scontent-*.xx.fbcdn.net` hostnames
that a strict CSP cannot enumerate, so the policy would have to be widened to
something like `*.fbcdn.net` or dropped for images altogether.

That makes this file a proxy, and a proxy that will fetch any URL it is given is
somebody else's open relay with our egress IP on it. Three things stop that, and
all three are here rather than in a deployment note:

1. `resolve_image_ref` refuses any host that is not one of exactly two
   upstreams, whatever the reference says.
2. The reference carries an HMAC, so a URL on those hosts cannot be swapped for
   a different one (a multi-gigabyte media file on upload.wikimedia.org is still
   on upload.wikimedia.org).
3. `PHOTO_MAX_IMAGE_BYTES` caps what is streamed back, and the shared client's
   timeout caps how long it is held open. `fixtures.get_client()` is also
   configured with `follow_redirects=False`, which matters more here than
   anywhere else in the codebase: a redirect is the standard way an allowlisted
   host is turned into a request to somewhere else.

**Nothing here may assert what nothing measured.** The hero photo is chosen by
what the route was optimised for, and for four of the six objectives *the data
to do that honestly does not exist*. `Route` carries one aggregate number per
score; the per-way tag spans that produce those numbers are consumed inside
`main._scored_route` and never reach the wire. So there is no greenest point, no
shadiest point and no quietest point to be found on a Route, and this module
does not invent one. It says so instead, in `PhotosResponse.note`, and sets
`objective_measured=False`. Two of the six are honest: `accessible` aims at the
first barrier, which `Route.blockers` really does carry, and `fastest` aims at
the midpoint, which is arithmetic.

Nothing in here may fail a request either. Every upstream call goes through
`_degrade`, and the worst outcome is an empty strip and a null hero.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import html
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

import httpx

from .config import (
    MAPILLARY_URL,
    PHOTO_MAX_ANCHORS,
    PHOTO_MAX_IMAGE_BYTES,
    PHOTO_SEARCH_RADIUS_M,
    PHOTO_SIGNING_KEY,
    WIKIMEDIA_COMMONS_API_URL,
    settings,
)
from .fixtures import BudgetExhausted, FixtureMissing, ResponseTooLarge, fetch, is_synthetic
from .geometry import LatLon, cumulative_distance_m, from_lonlat_pairs, haversine_m
from .logging_setup import get_logger
from .metrics import metrics
from .models import Blocker, HeroBasis, Photo, PhotosRequest, PhotosResponse

log = get_logger(__name__)

# ---------------------------------------------------------------------------
# what a proxy is allowed to fetch
# ---------------------------------------------------------------------------

# Wikimedia serves every file from one host, so this is an exact match and not
# a suffix rule. `*.wikimedia.org` would also cover the API hosts, the wikis and
# whatever Wikimedia stands up next, none of which this service should be
# fetching bytes from on a stranger's request.
COMMONS_IMAGE_HOST = "upload.wikimedia.org"

# Mapillary cannot be an exact match. Its thumbnails are served by Facebook's
# CDN from hostnames that rotate per edge and per session: `scontent-lhr8-1.xx`,
# `scontent-cdg4-2.xx`, and older `z-p3-scontent-...` forms have all been seen
# in `thumb_1024_url`. This is the narrowest rule that covers them:
#
#   * the registrable domain must be exactly fbcdn.net, matched on a leading dot
#     so `evil-fbcdn.net` does not pass, and
#   * the leftmost label must contain "scontent", which is the content-delivery
#     prefix rather than one of the many other things on fbcdn.net.
#
# It is deliberately not a general "any Facebook host" rule.
_FBCDN_SUFFIX = ".fbcdn.net"

# What the proxy will hand back. Anything else is not the thumbnail that was
# asked for, and passing an unexpected content type through a same-origin URL is
# how a proxy becomes an XSS vector: `text/html` streamed from /api/photo would
# execute in this API's origin. `X-Content-Type-Options: nosniff` goes on the
# response as well, so a browser cannot decide it knows better.
ALLOWED_IMAGE_CONTENT_TYPES = frozenset(
    {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}
)

# Longest reference the proxy will even look at. A signed reference for the
# longest Commons thumbnail URL seen is a little over 400 characters; this is
# generous room above that, and it exists so that a hostile path cannot make
# this process base64-decode a megabyte before rejecting it.
MAX_REF_CHARS = 1024


class PhotoProxyError(RuntimeError):
    """The image proxy refused or could not complete a request.

    Carries the status and the sentence the API should answer with, in the same
    shape `osm_report.BarrierReportError` uses, so main.py handles both the same
    way.
    """

    def __init__(self, human_message: str, status_code: int = 502) -> None:
        self.human_message = human_message
        self.status_code = status_code
        super().__init__(human_message)


def _image_service(host: str) -> str | None:
    """Which live-call budget line an image host is charged to, or None to refuse.

    Returning the service name and the allowlist decision from one function is
    deliberate. When they were two functions it was possible to allow a host and
    then charge it to a budget line that did not exist, which `cap_for` treats
    as a cap of zero, so the allowlist said yes and the budget said no with no
    obvious connection between the two.
    """
    if host == COMMONS_IMAGE_HOST:
        return "wikimedia_images"
    if host.endswith(_FBCDN_SUFFIX) and "scontent" in host.split(".", 1)[0]:
        return "mapillary_images"
    return None


# ---------------------------------------------------------------------------
# signed image references
# ---------------------------------------------------------------------------


def _b64(raw: bytes) -> str:
    """URL-safe base64 with the padding removed.

    The padding is stripped because the result travels in a URL *path segment*.
    `=` is legal there but is percent-encoded by some clients and not others, so
    leaving it in means the same reference arrives in two different spellings
    and the signature check fails for one of them.
    """
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def image_ref(url: str) -> str:
    """An opaque reference to one upstream image URL.

    The URL is carried inside the reference rather than in a server-side table
    on purpose: a table would have to be shared between workers and expired on
    some schedule, and getting either wrong shows up as photos that stop loading
    minutes after a page was opened. Statelessness costs a longer URL and
    nothing else.

    The HMAC is truncated to 128 bits. This is not a signature over a document
    that must resist a determined offline attack; it is a tamper check on a
    string that the host allowlist independently constrains, and 128 bits is far
    past the point where forging one is cheaper than simply requesting the image
    from Wikimedia directly, which anyone may do.
    """
    tag = hmac.new(PHOTO_SIGNING_KEY, url.encode("utf-8"), hashlib.sha256).digest()[:16]
    return f"{_b64(url.encode('utf-8'))}.{_b64(tag)}"


def resolve_image_ref(ref: str) -> tuple[str, str]:
    """Turn a reference back into an upstream URL and its budget service.

    Raises `PhotoProxyError` rather than returning None, because every failure
    here is a different sentence and the caller would otherwise have to guess
    which. All of them answer with the same status: a reference that does not
    verify, one that decodes to a host we do not fetch from, and one that has
    simply expired because the process restarted are indistinguishable from
    outside, and telling them apart for a caller would be telling an attacker
    which of their guesses was closer.
    """
    if not ref or len(ref) > MAX_REF_CHARS or "." not in ref:
        raise PhotoProxyError("That image reference is not one this server issued.", 404)

    payload, _, tag = ref.rpartition(".")
    try:
        url = _unb64(payload).decode("utf-8")
        expected = _unb64(tag)
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise PhotoProxyError(
            "That image reference is not one this server issued.", 404
        ) from None

    actual = hmac.new(PHOTO_SIGNING_KEY, url.encode("utf-8"), hashlib.sha256).digest()[:16]
    if not hmac.compare_digest(actual, expected):
        raise PhotoProxyError("That image reference is not one this server issued.", 404)

    split = urlsplit(url)
    host = (split.hostname or "").lower()
    service = _image_service(host)
    # Every clause here has been a real vulnerability in some proxy. `https`
    # only, so the reference cannot downgrade the hop to plaintext or name a
    # `file://` URL. No userinfo, because `https://upload.wikimedia.org@evil/`
    # has a hostname of `evil` to a URL parser and of `upload.wikimedia.org` to
    # a human reading the log line. No alternate port, because the allowlist is
    # a statement about a service and not about a machine.
    if split.scheme != "https" or split.username or split.password:
        raise PhotoProxyError("That image reference is not one this server issued.", 404)
    if split.port not in (None, 443):
        raise PhotoProxyError("That image reference is not one this server issued.", 404)
    if service is None:
        log.warning("photo_proxy_host_refused", extra={"host": host})
        raise PhotoProxyError("That image reference is not one this server issued.", 404)
    return url, service


# ---------------------------------------------------------------------------
# degrading
# ---------------------------------------------------------------------------


async def _degrade(stage: str, awaitable: Any) -> Any:
    """Await something optional, returning ``None`` if it fails for any reason.

    A deliberate near-copy of `enrich._degrade` rather than an import of it.
    Two reasons, and the second is the one that matters. It counts a different
    metric, so "enrichment is failing" and "the photo sources are failing" stay
    separable on a dashboard. And it would otherwise be a cross-module
    dependency on another file's underscore-prefixed name, which is exactly the
    kind of coupling that turns a refactor of enrichment into a broken photo
    strip with no test failure in between.

    ``None`` here means "could not look", and callers must keep that distinct
    from an empty list, which means "looked and found nothing". The difference
    decides whether a source appears in `PhotosResponse.sources_used`.
    """
    try:
        return await awaitable
    except Exception as exc:  # noqa: BLE001 - deliberate: no photo may fail a request
        log.warning("photo_source_degraded", extra={"stage": stage, "error": type(exc).__name__})
        metrics.incr("photo_source_failures_total")
        return None


# ---------------------------------------------------------------------------
# anchor points along the route
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Anchor:
    """One place along the route that the sources are asked about."""

    point: LatLon
    at_m: float
    # True for the anchor placed on a barrier rather than by even spacing. It is
    # the only anchor whose position is a measurement of the route rather than a
    # measurement of the route's length.
    is_barrier: bool = False


def _nearest_index(points: Sequence[LatLon], target: LatLon) -> int:
    return min(range(len(points)), key=lambda i: haversine_m(points[i], target))


def _even_anchors(points: Sequence[LatLon], count: int) -> list[Anchor]:
    """``count`` anchors spaced evenly along the route by distance travelled.

    Placed at (i + 0.5) / count rather than i / (count - 1), so no anchor sits
    on the origin. A photo of where the user is standing right now is the one
    photo they do not need, and on a loop the origin and the destination are the
    same place, which would spend two of the anchors on it.

    An odd `count` puts one anchor exactly halfway, which is what the `fastest`
    hero is. See the note on PHOTO_MAX_ANCHORS in config.py.
    """
    cumulative = cumulative_distance_m(points)
    total = float(cumulative[-1])
    if total <= 0 or count <= 0:
        return []

    anchors: list[Anchor] = []
    seen: set[int] = set()
    for i in range(count):
        target_m = total * (i + 0.5) / count
        # searchsorted would be faster and is wrong at the ends; this is at most
        # 800 vertices (MAX_PHOTO_GEOMETRY_POINTS) times five anchors.
        index = min(
            range(len(points)), key=lambda j: abs(float(cumulative[j]) - target_m)
        )
        if index in seen:
            # A route short enough that two anchors land on the same vertex asks
            # the same question twice and pays for it twice.
            continue
        seen.add(index)
        anchors.append(Anchor(points[index], round(float(cumulative[index]), 1)))
    return anchors


def _anchors_for(
    points: Sequence[LatLon], objective: str, blockers: Sequence[Blocker]
) -> list[Anchor]:
    """The places to ask about, with the barrier folded in for `accessible`.

    The barrier anchor *replaces* the last evenly spaced one rather than being
    added to them, so the number of upstream calls does not depend on whether a
    route happens to have a gate on it. A request whose cost varies with the
    data it is about is a request whose latency the frontend cannot plan around.
    """
    anchors = _even_anchors(points, PHOTO_MAX_ANCHORS)
    if objective != "accessible" or not blockers or not anchors:
        return anchors

    cumulative = cumulative_distance_m(points)
    first: Anchor | None = None
    for blocker in blockers:
        target = LatLon(blocker.lat, blocker.lon)
        index = _nearest_index(points, target)
        at_m = round(float(cumulative[index]), 1)
        if first is None or at_m < first.at_m:
            # The blocker's own coordinate, not the route vertex nearest to it.
            # A gate is a few metres off the line by definition, and a photo
            # search centred on the line rather than on the gate is centred on
            # the wrong thing by exactly the distance that matters.
            first = Anchor(target, at_m, is_barrier=True)

    if first is None:
        return anchors
    return [first, *anchors[:-1]]


# ---------------------------------------------------------------------------
# Wikimedia Commons
# ---------------------------------------------------------------------------

_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")

COMMONS_ATTRIBUTION_SUFFIX = "via Wikimedia Commons"
MAPILLARY_LICENCE = "CC BY-SA 4.0"
MAPILLARY_LICENCE_URL = "https://creativecommons.org/licenses/by-sa/4.0/"
MAPILLARY_AUTHOR = "Mapillary contributors"

# How many files to ask Commons for per anchor. Generous, because the drop rate
# is real: a file with no determinable licence is discarded, and geosearch
# happily returns maps, diagrams and scans of documents alongside photographs.
COMMONS_LIMIT_PER_ANCHOR = 8
COMMONS_THUMB_WIDTH = 640

# One bbox per anchor, half a side each way. Mapillary rejects a bbox of 0.01
# degrees or more outright (see the gotcha table in CONTRIBUTING.md), and
# scoring.py already lives with the same constraint; this file keeps its own
# constant rather than importing scoring's, because importing scoring pulls in
# the CLIP path and this module must stay importable with torch absent.
MAPILLARY_BBOX_HALF_DEG = 0.002
MAPILLARY_LIMIT_PER_ANCHOR = 6


def _plain_text(value: object, limit: int) -> str | None:
    """Commons `extmetadata` values are HTML. This is the only thing that reads them.

    `Artist` in particular is nearly always an anchor tag wrapping a user name,
    and `ImageDescription` can be a paragraph with links and markup in it. The
    tags are stripped rather than escaped because the value is going into a JSON
    field that the frontend renders as text: escaping would show a reader
    `&lt;a href=...&gt;` where their name should be.

    This is a sanitiser of last resort and not a security boundary. The security
    boundary is that the frontend renders these as text nodes. Stripping tags
    with a regular expression is not enough to make arbitrary HTML safe, and
    nothing here should ever be passed to `dangerouslySetInnerHTML`.
    """
    if not isinstance(value, str):
        return None
    text = html.unescape(_TAG_RE.sub(" ", value))
    text = _WHITESPACE_RE.sub(" ", text).strip()
    if not text:
        return None
    return text[:limit].strip() if len(text) > limit else text


def _extmeta(extmetadata: object, key: str) -> object:
    if not isinstance(extmetadata, dict):
        return None
    entry = extmetadata.get(key)
    if isinstance(entry, dict):
        return entry.get("value")
    return None


def _commons_title(page: dict[str, Any]) -> str | None:
    """A readable name for the file, from the page title.

    `File:Serpentine Bridge, Hyde Park - geograph.org.uk - 123.jpg` becomes
    `Serpentine Bridge, Hyde Park - geograph.org.uk - 123`. Deliberately crude:
    the alternative is `ImageDescription`, which is a free-text field that is
    frequently a paragraph, frequently in a language the user did not ask for,
    and occasionally the photographer's life story.
    """
    raw = page.get("title")
    if not isinstance(raw, str) or not raw:
        return None
    name = raw.split(":", 1)[1] if raw.startswith("File:") else raw
    name = name.rsplit(".", 1)[0].replace("_", " ").strip()
    return name[:160] or None


def _photo_from_commons_page(page: dict[str, Any], anchor: Anchor) -> Photo | None:
    """One Commons file, or None if it cannot be shown lawfully or at all.

    **The licence check is a hard drop, not a default.** Every image on Commons
    is under some free licence, but `extmetadata` does not always say which, and
    an image shown with the wrong credit or no credit is a copyright problem
    with a real person on the other end of it. There is no "unknown licence"
    rendering path and there should not be one, because a caption reading
    "licence unknown" is an admission published on the photographer's behalf.
    """
    infos = page.get("imageinfo")
    if not isinstance(infos, list) or not infos:
        return None
    info = infos[0]
    if not isinstance(info, dict):
        return None

    # `thumburl` is the 640 px rendering asked for with iiurlwidth. `url` is the
    # original, which for a Commons file can be a 60 megapixel TIFF, so falling
    # back to it is not an option: it would be a several-hundred-megabyte
    # download proxied through this service to fill a strip thumbnail.
    source_url = info.get("thumburl")
    if not isinstance(source_url, str) or not source_url:
        return None
    host = (urlsplit(source_url).hostname or "").lower()
    if _image_service(host) is None:
        # Commons answering with a host the proxy will not fetch from is not a
        # thing that should happen, and if it starts happening the log line is
        # how anyone finds out.
        log.warning("commons_thumb_host_refused", extra={"host": host})
        return None

    licence = _plain_text(_extmeta(info.get("extmetadata"), "LicenseShortName"), 80)
    if not licence:
        return None
    author = _plain_text(_extmeta(info.get("extmetadata"), "Artist"), 120)
    licence_url = _extmeta(info.get("extmetadata"), "LicenseUrl")

    lat, lon = anchor.point.lat, anchor.point.lon
    coordinates = page.get("coordinates")
    if isinstance(coordinates, list) and coordinates and isinstance(coordinates[0], dict):
        raw_lat, raw_lon = coordinates[0].get("lat"), coordinates[0].get("lon")
        if isinstance(raw_lat, int | float) and isinstance(raw_lon, int | float):
            lat, lon = float(raw_lat), float(raw_lon)

    credit = f"{author}, {licence}, {COMMONS_ATTRIBUTION_SUFFIX}" if author else (
        f"{licence}, {COMMONS_ATTRIBUTION_SUFFIX}"
    )
    description = info.get("descriptionurl")
    return Photo(
        id=hashlib.blake2b(source_url.encode("utf-8"), digest_size=8).hexdigest(),
        url=f"/api/photo/{image_ref(source_url)}",
        source="wikimedia_commons",
        lat=lat,
        lon=lon,
        at_m=anchor.at_m,
        width=info.get("thumbwidth") if isinstance(info.get("thumbwidth"), int) else None,
        height=info.get("thumbheight") if isinstance(info.get("thumbheight"), int) else None,
        title=_commons_title(page),
        licence=licence,
        licence_url=licence_url if isinstance(licence_url, str) and licence_url else None,
        author=author,
        attribution=credit,
        source_page=description if isinstance(description, str) and description else None,
    )


async def commons_photos_near(anchor: Anchor) -> list[Photo] | None:
    """Photographs *of places* near one anchor, or None if Commons could not be asked.

    `generator=geosearch` with `ggsnamespace=6` is the file namespace, so this
    returns media rather than articles. No key and no account is required, which
    is why this source is the one that always works and Mapillary is the one
    that is allowed to be absent.
    """
    params = {
        "action": "query",
        "generator": "geosearch",
        "ggscoord": f"{anchor.point.lat:.6f}|{anchor.point.lon:.6f}",
        "ggsradius": PHOTO_SEARCH_RADIUS_M,
        "ggslimit": COMMONS_LIMIT_PER_ANCHOR,
        "ggsnamespace": 6,
        # `coordinates` is not in the query the feature was specified with, and
        # is here because without it a photograph has no position of its own and
        # would have to be pinned at the anchor, up to PHOTO_SEARCH_RADIUS_M
        # from where it was taken. Everything downstream falls back to the
        # anchor when it is absent, so an API that stops returning it degrades
        # to the specified behaviour rather than breaking.
        "prop": "imageinfo|coordinates",
        "iiprop": "url|extmetadata",
        "iiurlwidth": COMMONS_THUMB_WIDTH,
        "format": "json",
        "formatversion": 2,
    }
    response = await fetch(
        "GET",
        WIKIMEDIA_COMMONS_API_URL,
        params=params,
        headers={"Accept": "application/json"},
        cost=1,
        service="wikimedia_commons",
    )
    if response.status_code >= 400:
        log.warning("commons_geosearch_error", extra={"status": response.status_code})
        return None
    if is_synthetic(response):
        # A hand-built fixture must never become a photograph attributed to a
        # real person under a licence the fixture author typed in.
        return None

    try:
        payload = response.json()
    except ValueError:
        log.warning("commons_geosearch_unparseable")
        return None

    query = payload.get("query") if isinstance(payload, dict) else None
    pages = query.get("pages") if isinstance(query, dict) else None
    if not isinstance(pages, list):
        # MediaWiki omits `query` entirely when a generator matched nothing.
        # That is an answer: Commons was reached and holds no geolocated file
        # near this point. Empty list, not None.
        return []

    found: list[Photo] = []
    for page in pages:
        if not isinstance(page, dict):
            continue
        photo = _photo_from_commons_page(page, anchor)
        if photo is not None:
            found.append(photo)
    return found


# ---------------------------------------------------------------------------
# Mapillary
# ---------------------------------------------------------------------------


def _bbox_for(point: LatLon, half_deg: float = MAPILLARY_BBOX_HALF_DEG) -> str:
    return (
        f"{point.lon - half_deg:.6f},{point.lat - half_deg:.6f},"
        f"{point.lon + half_deg:.6f},{point.lat + half_deg:.6f}"
    )


def _captured_at_iso(raw: object) -> str | None:
    """Mapillary reports capture time as epoch milliseconds. Sometimes as a string."""
    try:
        millis = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if millis <= 0:
        return None
    try:
        return datetime.fromtimestamp(millis / 1000.0, tz=UTC).isoformat()
    except (OverflowError, OSError, ValueError):
        return None


def _photo_from_mapillary(item: dict[str, Any], anchor: Anchor) -> Photo | None:
    source_url = item.get("thumb_1024_url")
    image_id = item.get("id")
    if not isinstance(source_url, str) or not source_url or image_id is None:
        return None
    host = (urlsplit(source_url).hostname or "").lower()
    if _image_service(host) is None:
        # The CDN hostname rule is the one piece of this file most likely to go
        # stale, because Mapillary does not promise the shape of these hosts.
        # When it does go stale this is the line that says so, and the feature
        # degrades to Commons-only rather than to broken images.
        log.warning("mapillary_thumb_host_refused", extra={"host": host})
        return None

    lat, lon = anchor.point.lat, anchor.point.lon
    geometry = item.get("computed_geometry")
    if isinstance(geometry, dict):
        coordinates = geometry.get("coordinates")
        # GeoJSON, so [lon, lat]. The one ordering mistake this codebase has a
        # named gotcha for.
        if (
            isinstance(coordinates, list)
            and len(coordinates) == 2
            and all(isinstance(v, int | float) for v in coordinates)
        ):
            lon, lat = float(coordinates[0]), float(coordinates[1])

    return Photo(
        id=hashlib.blake2b(source_url.encode("utf-8"), digest_size=8).hexdigest(),
        url=f"/api/photo/{image_ref(source_url)}",
        source="mapillary",
        lat=lat,
        lon=lon,
        at_m=anchor.at_m,
        title=None,
        licence=MAPILLARY_LICENCE,
        licence_url=MAPILLARY_LICENCE_URL,
        author=MAPILLARY_AUTHOR,
        attribution=f"{MAPILLARY_AUTHOR}, {MAPILLARY_LICENCE}",
        source_page=f"https://www.mapillary.com/app/?pKey={image_id}&focus=photo",
        captured_at=_captured_at_iso(item.get("captured_at")),
    )


async def mapillary_photos_near(anchor: Anchor) -> list[Photo] | None:
    """Street-level frames near one anchor, or None if Mapillary could not be asked.

    **Never called without a token.** `route_photos` checks
    `settings.mapillary_token` and simply does not schedule this, which is the
    shape `osm_report.submit_barrier` already uses for an optional credential:
    absent means a narrower result, never an error and never a broken feature.
    The distinction matters for honesty as well as uptime. Returning None here
    would put "we could not look" into `sources_used`, and the truth when no
    token is configured is that nobody looked, which `mapillary_enabled` says
    instead.
    """
    token = settings.mapillary_token
    if not token:
        return None
    response = await fetch(
        "GET",
        MAPILLARY_URL,
        params={
            "fields": "id,thumb_1024_url,computed_geometry,captured_at",
            "bbox": _bbox_for(anchor.point),
            "limit": MAPILLARY_LIMIT_PER_ANCHOR,
            "access_token": token,
        },
        cost=1,
        service="mapillary",
    )
    if response.status_code >= 400:
        # Not retried with a narrower bbox the way scoring.py does. That retry
        # exists because a missing CLIP score silently changes a published
        # number; a missing photograph changes nothing except that there is one
        # fewer photograph, and it is not worth tripling the spend on the
        # busiest streets to avoid.
        log.warning("mapillary_images_error", extra={"status": response.status_code})
        return None
    if is_synthetic(response):
        return None

    try:
        payload = response.json()
    except ValueError:
        log.warning("mapillary_images_unparseable")
        return None

    data = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(data, list):
        return []
    found: list[Photo] = []
    for item in data:
        if isinstance(item, dict):
            photo = _photo_from_mapillary(item, anchor)
            if photo is not None:
                found.append(photo)
    return found


# ---------------------------------------------------------------------------
# choosing the hero
# ---------------------------------------------------------------------------

# What each hero caption says. Method, never a property of the place.
HERO_REASONS: dict[str, str] = {
    "first_barrier": "The first barrier on this route, so you can see what blocks it.",
    "midpoint": "About halfway along this route.",
    "most_photographed": (
        "The most photographed place along this route, according to Wikimedia Commons."
    ),
    "sampled": "A place along this route.",
}

# Said out loud whenever the hero was not chosen by anything that measures what
# the route was optimised for.
#
# **These sentences are the feature's honesty, not its small print.** A photo
# captioned as the greenest, shadiest or quietest point on a route would be a
# measurement claim, and there is no per-segment greenery, canopy or quiet
# anywhere on a `Route` to support one. Rather than quietly picking a photo and
# letting the objective's name imply the claim, the response says which claim is
# not being made.
UNMEASURED_NOTES: dict[str, str] = {
    "scenic": (
        "This is the most photographed place near the route, not the prettiest part of "
        "it. Meander scores scenery for a whole route rather than point by point, so "
        "there is no greenest spot to show you."
    ),
    "shade": (
        "Meander scores shade for a whole route rather than point by point, so this is "
        "a place along the way, not the most sheltered one."
    ),
    "quiet": (
        "Meander scores quiet for a whole route rather than point by point, so this is "
        "a place along the way, not the furthest point from traffic."
    ),
    "air": (
        "Meander scores air quality for a whole route rather than point by point, so "
        "this is a place along the way, not the cleanest air on it."
    ),
}

NO_BARRIER_NOTE = (
    "No barrier was found on this route to show you, so this is a place along the way."
)

NO_PHOTOS_NOTE = "No photographs with a clear licence were found along this route."

MAPILLARY_ABSENT_NOTE = (
    "Street level imagery is switched off on this server, so these came from "
    "Wikimedia Commons only."
)

# How many photos the strip carries, and how many any one anchor may contribute
# to it. The per-anchor cap is what makes it a strip *along the route* rather
# than five views of whichever place happens to be best photographed.
STRIP_SIZE = 5
MAX_PER_ANCHOR = 2


def _pick_hero_anchor(
    objective: str,
    anchors: Sequence[Anchor],
    by_anchor: Sequence[list[Photo]],
    total_m: float,
) -> tuple[int, HeroBasis] | None:
    """Which anchor the hero comes from, and what justifies the choice.

    Anchors are addressed by position rather than by `at_m`, because a route
    with a repeated vertex can put two anchors at the same distance along it and
    a dict keyed on that silently merges them.

    Anchors with no photographs are never chosen. A hero slot that says "the
    first barrier on this route" and shows nothing is worse than a hero from
    somewhere else on the route, because the empty frame reads as "there is
    nothing there" rather than "nobody has photographed it".
    """
    usable = [i for i in range(len(anchors)) if by_anchor[i]]
    if not usable:
        return None

    if objective == "accessible":
        barrier = next((i for i in usable if anchors[i].is_barrier), None)
        if barrier is not None:
            return barrier, "first_barrier"

    if objective == "fastest":
        # Nearest usable anchor to halfway. With an odd PHOTO_MAX_ANCHORS one of
        # them is exactly halfway, so this is normally an exact answer and the
        # caption's "about" is covering the case where that anchor had no
        # photographs and the next one along is standing in.
        return min(usable, key=lambda i: abs(anchors[i].at_m - total_m / 2.0)), "midpoint"

    # Everything else. Commons coverage is the only per-place signal this module
    # actually has, and it is a measurement of Commons rather than of the route,
    # which is why `objective_measured` stays false for every objective that
    # lands here. Mapillary frames are excluded from the count on purpose: their
    # density measures how often a car with a camera drove past, which is close
    # to the opposite of what makes a place worth looking at.
    def commons_count(index: int) -> int:
        return sum(1 for p in by_anchor[index] if p.source == "wikimedia_commons")

    best = max(usable, key=commons_count)
    if commons_count(best) > 1:
        return best, "most_photographed"
    # Nothing to distinguish the anchors, so nothing is claimed about them.
    return usable[0], "sampled"


def _dedupe(photos: Sequence[Photo]) -> list[Photo]:
    """Same file found from two anchors is one photograph, kept at the earlier one."""
    seen: set[str] = set()
    out: list[Photo] = []
    for photo in sorted(photos, key=lambda p: p.at_m):
        if photo.id in seen:
            continue
        seen.add(photo.id)
        out.append(photo)
    return out


# ---------------------------------------------------------------------------
# the one call main.py makes
# ---------------------------------------------------------------------------


async def route_photos(req: PhotosRequest) -> PhotosResponse:
    """Photographs along one route. Never raises.

    Every upstream call is issued together and every one of them is wrapped in
    `_degrade`, so the slowest source sets the latency and a broken source costs
    its own results and nothing else.
    """
    points = from_lonlat_pairs(req.geometry)
    anchors = _anchors_for(points, req.objective, req.blockers)
    if not anchors:
        # A geometry with two identical points has no length to place an anchor
        # along. The validator cannot catch it, because it is about the values
        # rather than the shape.
        return PhotosResponse(
            hero_basis="none",
            mapillary_enabled=bool(settings.mapillary_token),
            note=NO_PHOTOS_NOTE,
        )

    total_m = float(cumulative_distance_m(points)[-1])
    mapillary_enabled = bool(settings.mapillary_token)

    tasks: list[tuple[str, int, Any]] = []
    for index, anchor in enumerate(anchors):
        tasks.append(("wikimedia_commons", index, commons_photos_near(anchor)))
        if mapillary_enabled:
            tasks.append(("mapillary", index, mapillary_photos_near(anchor)))

    results = await asyncio.gather(
        *(_degrade(f"{source}:{index}", coro) for source, index, coro in tasks)
    )

    by_anchor: list[list[Photo]] = [[] for _ in anchors]
    answered: list[str] = []
    for (source, index, _), found in zip(tasks, results, strict=True):
        if found is None:
            continue
        if source not in answered:
            answered.append(source)
        by_anchor[index].extend(found)

    by_anchor = [_dedupe(found) for found in by_anchor]

    chosen = _pick_hero_anchor(req.objective, anchors, by_anchor, total_m)
    if chosen is None:
        return PhotosResponse(
            hero_basis="none",
            objective_measured=False,
            sources_used=answered,  # type: ignore[arg-type]
            mapillary_enabled=mapillary_enabled,
            note=NO_PHOTOS_NOTE if answered else None,
        )

    hero_index, basis = chosen
    hero_candidates = by_anchor[hero_index]
    # A photograph *of* a place beats a frame taken *from* a road passing it, so
    # Commons leads wherever both sources answered for the same anchor. Within a
    # source the upstream's own order is kept: geosearch returns by distance
    # from the anchor, and Mapillary's is close enough to arbitrary that
    # imposing an order here would be inventing one.
    hero = next(
        (p for p in hero_candidates if p.source == "wikimedia_commons"), hero_candidates[0]
    )

    # Ordered by distance along the route, which is the order a walker meets
    # them. The anchor list is already in that order except for the barrier
    # anchor, which is pushed to the front so it can be found without a scan.
    strip: list[Photo] = []
    for index in sorted(range(len(anchors)), key=lambda i: anchors[i].at_m):
        taken = 0
        for photo in by_anchor[index]:
            if photo.id == hero.id or taken >= MAX_PER_ANCHOR:
                continue
            strip.append(photo)
            taken += 1
    strip = strip[:STRIP_SIZE]

    objective_measured = basis in ("first_barrier", "midpoint")
    note = UNMEASURED_NOTES.get(req.objective)
    if req.objective == "accessible" and basis != "first_barrier":
        note = NO_BARRIER_NOTE
    if note is None and not mapillary_enabled:
        # Only said when there is nothing more important to say. A user reading
        # a caption about what was not measured does not also need to know which
        # optional credential this deployment has.
        note = MAPILLARY_ABSENT_NOTE

    return PhotosResponse(
        hero=hero,
        strip=strip,
        hero_basis=basis,
        hero_reason=HERO_REASONS[basis],
        objective_measured=objective_measured,
        sources_used=answered,  # type: ignore[arg-type]
        mapillary_enabled=mapillary_enabled,
        note=note,
    )


# ---------------------------------------------------------------------------
# the image proxy
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProxiedImage:
    body: bytes
    content_type: str


async def proxied_image(ref: str) -> ProxiedImage:
    """Fetch one upstream image for /api/photo/{ref}. Raises `PhotoProxyError`.

    Goes through `fixtures.fetch` like every other upstream call in this
    codebase, and that is a deliberate choice with a visible cost: in `replay`
    mode there is no fixture for an image, so this raises and the offline demo
    shows no photographs at all. The alternative was to reach for the shared
    client directly and skip the record/replay layer for binary bodies, which
    would have made `MEANDER_FIXTURES=replay` open a socket. That guarantee is
    load-bearing for the whole test suite (CI runs it under `unshare -n`) and is
    worth more than photographs in the keyless demo.

    Image bytes are never persisted as fixtures (`persist=False`, exactly as
    `scoring.download_image` does): committing megabytes of street imagery would
    bloat the repository, and nothing about a photograph needs replaying because
    no number is derived from it.
    """
    url, service = resolve_image_ref(ref)
    try:
        response = await fetch("GET", url, cost=1, service=service, persist=False)
    except (FixtureMissing, BudgetExhausted) as exc:
        raise PhotoProxyError(
            "Photographs are not available on this server right now.", 503
        ) from exc
    except ResponseTooLarge as exc:
        raise PhotoProxyError("That image is too large to serve.", 502) from exc
    except httpx.HTTPError as exc:
        log.warning("photo_proxy_transport_error", extra={"error": type(exc).__name__})
        raise PhotoProxyError("Could not fetch that image.", 502) from exc

    if response.status_code >= 400:
        log.warning("photo_proxy_upstream_error", extra={"status": response.status_code})
        raise PhotoProxyError("Could not fetch that image.", 502)

    # `content-type: image/jpeg; charset=binary` is a real thing some CDNs send.
    content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_IMAGE_CONTENT_TYPES:
        log.warning("photo_proxy_content_type_refused", extra={"content_type": content_type})
        raise PhotoProxyError("That reference does not point at an image.", 502)

    body = response.content
    if len(body) > PHOTO_MAX_IMAGE_BYTES:
        # fixtures.MAX_RESPONSE_BYTES already refused anything absurd while it
        # was still arriving. This is the policy limit on top: a thumbnail this
        # large is not the thumbnail that was requested, and serving it would
        # make this endpoint a file transfer service.
        log.warning("photo_proxy_too_large", extra={"bytes": len(body)})
        raise PhotoProxyError("That image is too large to serve.", 502)

    metrics.incr("photos_proxied_total")
    return ProxiedImage(body=body, content_type=content_type)
