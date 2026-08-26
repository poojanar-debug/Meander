"""Wire contract for /api/routes.

Geometry on the wire is GeoJSON ``[lon, lat]``. Internally it is always
``LatLon``. The conversion happens in routing.py and nowhere else.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .geometry import LatLon, haversine_m

Mode = Literal["auto", "foot", "bike", "car"]
EffectiveMode = Literal["foot", "bike", "car"]
RouteId = Literal["fastest", "scenic", "accessible", "quiet", "shade", "air"]

# `scenic` was called `nature` until 2026-08-12. The rename fixed a construct
# mismatch the codebase had already written down — `scoring.py`'s active prompt
# pair is "a beautiful place" / "an ugly place", which measures visual appeal,
# of which greenery is one source and landmarks, beaches and architecture are
# others.
#
# **Accepted on the way in, never emitted.** `objectives` travels in the URL, so
# a strict rename would break every link anyone has shared: `writeUrl` puts the
# ids in the query string and `decodeState` reads them back on load. A shared
# permalink is a promise, and one that 422s a year later is a broken one.
#
# One direction only. Nothing in this codebase writes `nature` to the wire, no
# response carries it, and `Scores` has no such field — so an alias here cannot
# leak the old name back into anything that stores or renders it.
DEPRECATED_OBJECTIVE_ALIASES: dict[str, str] = {"nature": "scenic"}
ScoringMethod = Literal["clip", "geometry_only", "placeholder"]
RouteStatus = Literal["ok", "blocked"]

MIN_MINUTES = 20
MAX_MINUTES = 360

# The three the spec requires, and the three the app asks for when nobody has
# chosen. All six route for real; these are the default because they answer
# three different questions — how fast, how pleasant, can I use it at all —
# where the other three are all variations on "what is this route like".
DEFAULT_OBJECTIVES: tuple[RouteId, ...] = ("fastest", "scenic", "accessible")

ROUTE_LABELS: dict[str, str] = {
    "fastest": "Fastest",
    "scenic": "Scenic",
    "accessible": "Accessible",
    "quiet": "Quiet",
    "shade": "Shade",
    "air": "Clean air",
}


class Point(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]

    def to_latlon(self) -> LatLon:
        return LatLon(self.lat, self.lon)


class RouteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    origin: Point
    destination: Point | None = None
    minutes: Annotated[int, Field(ge=MIN_MINUTES, le=MAX_MINUTES)] = 35
    mode: Mode = "auto"
    depart_at: datetime | None = None
    objectives: list[RouteId] | None = None

    @field_validator("objectives", mode="before")
    @classmethod
    def _accept_deprecated_names(cls, v: list[str] | None) -> list[str] | None:
        """Map retired objective ids to their current names, before validation.

        `mode="before"` is load-bearing: `objectives` is typed `list[RouteId]`,
        a Literal that no longer contains "nature", so an after-validator would
        never run — the request would already have been rejected with a 422.
        Every permalink shared before the rename carries `nature` in its query
        string.
        """
        if not isinstance(v, list):
            return v
        return [DEPRECATED_OBJECTIVE_ALIASES.get(item, item) if isinstance(item, str) else item
                for item in v]

    @field_validator("objectives")
    @classmethod
    def _at_most_three_unique(cls, v: list[str] | None) -> list[str] | None:
        if v is None:
            return None
        seen: list[str] = []
        for item in v:
            if item not in seen:
                seen.append(item)
        if not seen:
            raise ValueError(
                "objectives must not be empty; omit the field to use the default three"
            )
        if len(seen) > 3:
            raise ValueError("at most three objectives")
        return seen

    def resolved_objectives(self) -> tuple[str, ...]:
        return tuple(self.objectives) if self.objectives else DEFAULT_OBJECTIVES

    def is_loop(self) -> bool:
        return self.destination is None

    def budget_minutes(self) -> int | None:
        """The time budget, or ``None`` when the trip has a destination.

        ``minutes`` is always populated — it has a default, and the dial always
        sends one — so every consumer that reads ``req.minutes`` directly is
        reading a number that is meaningless for a point-to-point trip. Going
        through here makes "there is no budget" the shape of the value rather
        than a rule each caller has to remember.
        """
        return None if self.destination is not None else self.minutes

    def straight_line_m(self) -> float | None:
        """Crow-flight origin→destination, or ``None`` for a loop."""
        if self.destination is None:
            return None
        return haversine_m(self.origin.to_latlon(), self.destination.to_latlon())


class Scores(BaseModel):
    """Each score is null when it has not been computed.

    Null rather than zero, deliberately: zero shade is a claim about a place,
    and "we did not measure this" is not the same claim. The frontend renders
    null as "not measured".
    """

    scenic: float | None = None
    air: float | None = None
    shade: float | None = None
    # Added with the quiet preset. Every score here is reported on every route
    # whatever objective produced it, so a fastest route says how quiet it
    # happens to be and the comparison against the quiet one is the reader's to
    # make. That is the same arrangement `scenic` and `air` have always had.
    quiet: float | None = None


class RestStop(BaseModel):
    lat: float
    lon: float
    type: str
    at_m: float


class ElevationProfile(BaseModel):
    """The route's shape, for drawing. Null when the router returned no elevation.

    Null rather than an empty profile: "no elevation data" and "this route is
    flat" are different statements, and a flat line drawn for the first makes
    the second's claim.
    """

    distances_m: list[float]
    elevations_m: list[float]
    ascent_m: float
    descent_m: float
    max_gradient_pct: float
    # [start, end) index pairs into the arrays above, for stretches over
    # limit_pct. The limit is the same MAX_INCLINE_PCT the accessibility engine
    # rejects on, so the drawing and the verdict cannot disagree.
    steep_spans: list[list[int]]
    limit_pct: float


class Blocker(BaseModel):
    type: str
    lat: float
    lon: float
    description: str


class Step(BaseModel):
    """One turn instruction from the router.

    Added for the turn-by-turn step list. The frontend writes these as sentences
    in the narration's voice; the raw fields are carried so it can, and
    ``interval`` lets it highlight the matching stretch of the line and place a
    barrier inside the step where a walker would meet it.
    """

    text: str
    distance_m: float
    duration_min: float
    street_name: str | None = None
    sign: int = 0
    interval: list[int] = Field(default_factory=list)


class Route(BaseModel):
    id: str
    label: str
    status: RouteStatus
    geometry: list[list[float]]  # [[lon, lat], ...]
    duration_min: float
    distance_m: float
    mode: EffectiveMode
    scores: Scores
    scoring_method: ScoringMethod
    confidence: float
    # **Null when nobody could look.** A list — including an empty one — means
    # Overpass answered and this is what it found. The two are different claims
    # and the difference is the whole discipline of this project, so the type
    # carries it rather than a note in the README saying it does.
    #
    # It used to be `list[RestStop]` defaulting to `[]`, which made "we could
    # not look" unrepresentable: an unreachable Overpass and a route with no
    # benches on it produced the same wire value, and README.md documented a
    # `null` the model could never emit.
    rest_stops: list[RestStop] | None = None
    blockers: list[Blocker] = Field(default_factory=list)
    # Turn-by-turn directions. Empty when the router gave none — which is
    # different from a route with no turns, but the UI says "no directions"
    # either way rather than implying the route is a straight line, and never
    # synthesises a turn from the geometry.
    steps: list[Step] = Field(default_factory=list)
    elevation: ElevationProfile | None = None
    narration: str | None = None

    # Not in the original spec. Present because a route built from a hand-made
    # fixture must never be mistaken for a measurement — see BLOCKED.md #1.
    synthetic_upstream: bool = False
    # Human-readable statement of how much of the route accessibility data
    # actually covers. Rendered verbatim by the frontend.
    confidence_note: str | None = None
    # Why a blocked route is blocked, when the reason is not a geographic
    # blocker — "no route of this kind exists" has nowhere else to live in the
    # contract, and the UI has to be able to say it.
    status_note: str | None = None

    # True on the first of two passes: the geometry and duration are final, but
    # air, shade, rest stops and the barrier half of the accessibility check
    # have not been fetched yet, and a second `route` event with the same id
    # will follow. The verdict itself can move on that second event — a gate
    # found on the route blocks it — which is why "the assessment is final
    # here" is no longer part of this comment.
    #
    # `rest_stops` is null on this pass for the reason this flag was invented:
    # an empty list means "we looked and found none", and the whole project
    # turns on absence of data never being reported as a finding. The flag still
    # earns its place now that the field can say that itself — air and shade are
    # scalars, so null on them does not distinguish "not yet" from "could not".
    #
    # The UI must not render rest stops or the air and shade scores as measured
    # while this is true.
    enrichment_pending: bool = False


class CacheInfo(BaseModel):
    segments_scored: int
    hit_rate: float


class RoutesResponse(BaseModel):
    routes: list[Route]
    best_departure: str | None = None
    reason: str | None = None
    cache: CacheInfo


class GeocodeResult(BaseModel):
    name: str
    lat: float
    lon: float


class GeocodeResponse(BaseModel):
    results: list[GeocodeResult]


class BarrierReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    lat: Annotated[float, Field(ge=-90, le=90)]
    lon: Annotated[float, Field(ge=-180, le=180)]
    type: str = Field(max_length=40)
    description: str = Field(max_length=500)


def derive_mode(minutes: int) -> EffectiveMode:
    """The auto-mode ladder for a loop. Must match ``deriveMode`` in the frontend exactly."""
    if minutes <= 45:
        return "foot"
    if minutes <= 120:
        return "bike"
    return "car"


# The straight-line distances the ladder above implies, so the two rungs cannot
# drift apart: each is the distance that mode covers in the minutes its rung
# allows, at the loop speeds in routing.py (foot 75 m/min, bike 220 m/min).
#
# Divided by a circuity factor because the input is a *straight line* and the
# ladder's thresholds are route lengths. A real street network makes the route
# longer than the crow flight; 1.3 is the usual urban figure. Without it the
# ladder reads a 3.3 km straight line as a 45-minute walk when the walk is
# closer to an hour, and picks foot for a trip nobody would walk.
STRAIGHT_LINE_CIRCUITY = 1.3
FOOT_MAX_STRAIGHT_M = 75.0 * 45 / STRAIGHT_LINE_CIRCUITY    # ~2,596 m
BIKE_MAX_STRAIGHT_M = 220.0 * 120 / STRAIGHT_LINE_CIRCUITY  # ~20,308 m


def derive_mode_for_distance(straight_line_m: float) -> EffectiveMode:
    """The auto-mode ladder for a trip that has a destination.

    A point-to-point trip has no time budget to read — its length is set by
    where the user is going, not by how long they said they had. Reading
    ``minutes`` here made the mode depend on a number that means nothing for
    this shape of request: the dial's default of 35 put every trip on foot,
    including a 40 km one, and nudging the dial to 46 turned that same trip into
    a bike ride without the destination moving.

    Must match ``deriveModeForDistance`` in the frontend exactly.
    """
    if straight_line_m <= FOOT_MAX_STRAIGHT_M:
        return "foot"
    if straight_line_m <= BIKE_MAX_STRAIGHT_M:
        return "bike"
    return "car"


def effective_mode(mode: Mode, minutes: int, straight_line_m: float | None = None) -> EffectiveMode:
    """Resolve ``auto`` against whichever input actually describes the trip.

    ``straight_line_m`` is passed when the request has a destination, and is the
    only thing consulted then. ``minutes`` is for loops, where the time budget
    *is* the request.
    """
    if mode != "auto":
        return mode
    if straight_line_m is not None:
        return derive_mode_for_distance(straight_line_m)
    return derive_mode(minutes)


# ---------------------------------------------------------------------------
# route photos
# ---------------------------------------------------------------------------
#
# Appended rather than woven into the models above, because a photo is not part
# of a route: /api/routes never carries one. The frontend asks for photos in a
# second call once the user has picked a route, so that a slow or unreachable
# image host cannot delay the thing the user actually asked for.

PhotoSource = Literal["wikimedia_commons", "mapillary"]

# How the hero photo was picked. This is a claim about *method*, and it exists
# because the alternative is a caption that makes a claim about the world.
#
# The distinction is the whole of the accessibility-tagging discipline applied
# to imagery. "The greenest point on this route" is a measurement, and nothing
# in this codebase measures greenery point by point: `Scores` is one number for
# a whole route, and the per-way tag spans that produce it are consumed inside
# `main._scored_route` and never reach `Route`. So that caption cannot be
# written honestly, and the type refuses to let anyone write it by accident.
#
#   first_barrier      The first obstruction on the route, by distance along
#                      it. Measured: `Route.blockers` carries real coordinates
#                      from the Overpass barrier query.
#   midpoint           Halfway along the route by distance. Measured, in the
#                      sense that a midpoint is arithmetic rather than a claim.
#   most_photographed  The anchor point that Wikimedia Commons holds the most
#                      photographs near. A measurement of Commons, not of the
#                      route, and the copy says so.
#   sampled            An evenly spaced point with no property behind the
#                      choice. The honest fallback.
#   none               No photo was found at all.
HeroBasis = Literal["first_barrier", "midpoint", "most_photographed", "sampled", "none"]

# Upper bound on the geometry a photo request may carry. A 6-hour drive can run
# to several thousand vertices, and this endpoint only needs the *shape* of the
# route in order to place a handful of anchor points on it, so the frontend is
# free to thin the line before sending it. 800 vertices is roughly 18 KB of
# JSON, comfortably inside main.MAX_BODY_BYTES.
MAX_PHOTO_GEOMETRY_POINTS = 800


class Photo(BaseModel):
    """One image, with everything needed to display it lawfully.

    ``licence`` is not optional and has no default. Both source licences
    (CC BY-SA for Mapillary, whatever `extmetadata` reports for Commons)
    require attribution, so an image whose licence could not be determined is
    dropped in photos.py rather than shown uncredited. Making the field
    required is what stops a later refactor reintroducing that: there is no
    way to construct a Photo that does not say what it is licensed under.
    """

    # Opaque and origin-relative. See `url`.
    id: str
    # **A path on this service, never an upstream URL.** The reason the backend
    # proxies at all is that the image host must see this server and not the
    # user, and returning a upload.wikimedia.org or scontent-*.xx.fbcdn.net URL
    # here would hand the browser the job of contacting it, which is precisely
    # what was being avoided. It is `/api/photo/<ref>`, where ref is a signed
    # reference that only /api/photo can decode.
    url: str
    source: PhotoSource
    # Where the photograph is, when the source says. Wikimedia Commons carries
    # a coordinate per file and Mapillary carries one per frame, so this is
    # normally the picture's own position. It falls back to the anchor point on
    # the route when a file has no coordinate of its own, which for a Commons
    # geosearch result is rare but possible: geosearch can match on a coordinate
    # the API then declines to return.
    lat: float
    lon: float
    # Distance along the route, in metres, of the anchor point this photo was
    # found near. The strip is ordered by it.
    at_m: float
    width: int | None = None
    height: int | None = None
    title: str | None = None
    licence: str
    licence_url: str | None = None
    author: str | None = None
    # The credit line, already assembled. Rendered verbatim, so the frontend
    # cannot get the attribution wrong by reassembling the parts differently.
    attribution: str
    # Where a reader can go to check the licence and the author for themselves.
    # An attribution nobody can verify is decoration.
    source_page: str | None = None
    captured_at: str | None = None


class PhotosRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # GeoJSON order, `[[lon, lat], ...]`, exactly as `Route.geometry` carries
    # it. The frontend can therefore pass a route's geometry straight through
    # without a conversion, and there is no second place in the codebase where
    # the lon/lat ordering can be got wrong.
    geometry: list[list[float]]
    # Which route this is. It decides the hero, and nothing else.
    objective: RouteId = "fastest"
    # Passed through from `Route.blockers` so that the `accessible` hero can be
    # a photo of the thing that actually blocks the route.
    #
    # Optional, and the difference between empty and absent is not modelled
    # here on purpose: this endpoint never reports "no barriers on this route",
    # it only picks a photo, so an empty list simply means it has no barrier to
    # aim at and falls back to an evenly spaced point.
    blockers: list[Blocker] = Field(default_factory=list)

    @field_validator("geometry")
    @classmethod
    def _usable_line(cls, v: list[list[float]]) -> list[list[float]]:
        if len(v) < 2:
            raise ValueError("geometry needs at least two points")
        if len(v) > MAX_PHOTO_GEOMETRY_POINTS:
            raise ValueError(
                f"geometry has more than {MAX_PHOTO_GEOMETRY_POINTS} points; "
                "thin the line before sending it"
            )
        for pair in v:
            if len(pair) != 2:
                raise ValueError("each geometry entry must be [lon, lat]")
            lon, lat = pair
            if not (-180.0 <= lon <= 180.0) or not (-90.0 <= lat <= 90.0):
                raise ValueError("each geometry entry must be [lon, lat] in degrees")
        return v


class PhotosResponse(BaseModel):
    """Photos along one route.

    Every field that could be mistaken for a measurement is paired with one
    that says whether it is. ``hero_basis`` and ``objective_measured`` are that
    pair, and they are the reason this response is honest about the fact that
    per-segment greenery, shade and quiet do not exist anywhere in this
    codebase to choose a hero from.
    """

    # Null when nothing was found or every source was unreachable. The two are
    # distinguished by `sources_used`: empty means nobody answered.
    hero: Photo | None = None
    # Three to five more, ordered by distance along the route.
    strip: list[Photo] = Field(default_factory=list)
    hero_basis: HeroBasis = "none"
    # One sentence, rendered verbatim as the hero's caption. It states the
    # method, never a property of the place.
    hero_reason: str = ""
    # **True only when the hero was chosen by something that measures what this
    # route was optimised for.** False for scenic, shade, quiet and air, which
    # have no per-segment data behind them. The UI must not present the hero as
    # "the shadiest spot" when this is false.
    objective_measured: bool = False
    # Which sources actually answered. An empty list means neither did, which is
    # a different thing from both answering with nothing.
    sources_used: list[PhotoSource] = Field(default_factory=list)
    # False when MAPILLARY_TOKEN is unset. Commons-only results are the normal
    # keyless configuration, not a failure, and this says so without the
    # frontend having to guess from an empty `sources_used`.
    mapillary_enabled: bool = False
    # Said out loud when something is worth saying, null otherwise. Rendered
    # verbatim.
    note: str | None = None
