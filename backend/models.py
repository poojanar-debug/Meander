"""Wire contract for /api/routes.

Geometry on the wire is GeoJSON ``[lon, lat]``. Internally it is always
``LatLon``. The conversion happens in routing.py and nowhere else.
"""

from __future__ import annotations

from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .geometry import LatLon

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
    # Empty when the router returned no instructions. The frontend says so
    # rather than inventing directions.
    steps: list[Step] = Field(default_factory=list)
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
    """The auto-mode ladder. Must match ``deriveMode`` in the frontend exactly."""
    if minutes <= 45:
        return "foot"
    if minutes <= 120:
        return "bike"
    return "car"


def effective_mode(mode: Mode, minutes: int) -> EffectiveMode:
    return derive_mode(minutes) if mode == "auto" else mode
