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
RouteId = Literal["fastest", "nature", "accessible", "quiet", "shade", "air"]
ScoringMethod = Literal["clip", "geometry_only", "placeholder"]
RouteStatus = Literal["ok", "blocked"]

MIN_MINUTES = 20
MAX_MINUTES = 360

# The three the spec requires. The frontend may request up to three of six.
DEFAULT_OBJECTIVES: tuple[RouteId, ...] = ("fastest", "nature", "accessible")

ROUTE_LABELS: dict[str, str] = {
    "fastest": "Fastest",
    "nature": "Nature",
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

    nature: float | None = None
    air: float | None = None
    shade: float | None = None


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
    rest_stops: list[RestStop] = Field(default_factory=list)
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

    # True on the first of two passes: the geometry, duration, accessibility
    # assessment and coverage are final, but air, shade and rest stops have not
    # been fetched yet and a second `route` event with the same id will follow.
    #
    # This exists because `rest_stops` cannot be null. An empty list means "we
    # looked and found none", which would be a false claim about a route we have
    # not looked at yet — and the whole project turns on absence of data never
    # being reported as a finding. The UI must not render rest stops or the air
    # and shade scores as measured while this is true.
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
