"""Hard accessibility constraints, blocker detection, and honest confidence.

**The rule this module exists to enforce: a missing OpenStreetMap tag means
UNKNOWN, never "accessible".** A false step-free claim can strand a real person
at the bottom of a flight of steps with no way back. Everything else in Meander
is negotiable; this is not.

That rule is enforced in the type system rather than by convention.
``Verdict`` has three members and deliberately raises on truthiness testing, so
``if verdict:`` — which would silently treat UNKNOWN as passable — is a
``TypeError`` at the first execution rather than a wrong answer in production.

Three outcomes, and they are genuinely different things:

``PASS``     the tags say this stretch is passable
``FAIL``     the tags say it is not — a hard constraint, so the route is blocked
``UNKNOWN``  nobody has tagged it. It lowers confidence. It never passes.

A route is blocked if any stretch FAILs. A route with no FAILs is *routable*,
not *verified*: its confidence is the fraction of its length with a definite
verdict, and below 0.3 the sentence it carries tells the reader not to rely on
it.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import numpy as np

from .geometry import LatLon, cumulative_distance_m, segment_lengths_m
from .logging_setup import get_logger

log = get_logger(__name__)


class Verdict(Enum):
    """Three-valued accessibility verdict.

    Not a bool, and deliberately not usable as one.
    """

    PASS = "pass"
    FAIL = "fail"
    UNKNOWN = "unknown"

    def __bool__(self) -> bool:
        raise TypeError(
            "A Verdict must be compared explicitly (verdict is Verdict.PASS). "
            "Truthiness testing would make UNKNOWN read as accessible, which is "
            "the one mistake this project must never make."
        )


# --- the hard constraints, as data ----------------------------------------
#
# Surfaces that are acceptable. Anything else that is *tagged* fails; anything
# *untagged* is UNKNOWN. The distinction is the whole point.
ACCEPTABLE_SURFACES = frozenset(
    {"PAVED", "ASPHALT", "CONCRETE", "PAVING_STONES", "COMPACTED"}
)

# Tagged surfaces that are known to be impassable for a wheelchair.
REJECTED_SURFACES = frozenset(
    {
        "GRAVEL", "FINE_GRAVEL", "GROUND", "DIRT", "EARTH", "GRASS", "SAND",
        "MUD", "WOOD", "COBBLESTONE", "SETT", "UNHEWN_COBBLESTONE", "PEBBLESTONE",
        "UNPAVED", "METAL_GRID", "WOODCHIPS", "SNOW", "ICE",
    }
)

REJECTED_SMOOTHNESS = frozenset(
    {"BAD", "VERY_BAD", "HORRIBLE", "VERY_HORRIBLE", "IMPASSABLE"}
)

REJECTED_BARRIERS = frozenset({"GATE", "STILE", "TURNSTILE", "KISSING_GATE"})

# Barrier values that mean "there is nothing in the way here". Named rather than
# inline in assess_barrier() so enrich.py can ask Overpass for exactly the values
# this module has an opinion about — see BARRIER_VALUES_WITH_A_VERDICT.
ACCEPTED_BARRIERS = frozenset({"NO", "NONE", "ENTRANCE"})

# Every barrier value that changes an answer. Anything outside this set assesses
# to UNKNOWN, and an UNKNOWN barrier span produces no finding and does not enter
# coverage — coverage is surface and smoothness only — so it has no effect on
# the response at all.
#
# That is what makes it safe for the Overpass query to ask only for these, and
# the reason the set is derived here rather than written out in a query string:
# adding a value to REJECTED_BARRIERS has to widen the question automatically,
# or the engine would start rejecting something nobody is fetching any more.
BARRIER_VALUES_WITH_A_VERDICT = REJECTED_BARRIERS | ACCEPTED_BARRIERS

# highway=steps, plus GraphHopper's road_class spelling of it.
REJECTED_ROAD_CLASSES = frozenset({"STEPS"})

# Values meaning "no one has said". Never PASS, never FAIL.
UNKNOWN_VALUES = frozenset({"", "MISSING", "UNKNOWN", "OTHER", "NONE", "NULL"})

# Gradient limits. A single steep step in the elevation profile is usually
# sensor noise, so the instantaneous limit is measured over a smoothing window
# rather than between adjacent vertices.
MAX_INCLINE_PCT = 8.0
SUSTAINED_INCLINE_PCT = 5.0
SUSTAINED_INCLINE_OVER_M = 50.0
INCLINE_SMOOTHING_WINDOW_M = 20.0

# Below this, a route's accessibility answer is not worth acting on and says so.
LOW_CONFIDENCE_THRESHOLD = 0.6
VERY_LOW_CONFIDENCE_THRESHOLD = 0.3


def normalise(value: Any) -> str:
    """OSM (`paving_stones`) and GraphHopper (`PAVING_STONES`) spell tags differently."""
    return str(value).strip().upper().replace("-", "_").replace(" ", "_")


def is_unknown(value: Any) -> bool:
    return value is None or normalise(value) in UNKNOWN_VALUES


@dataclass(frozen=True)
class Finding:
    """One reason a stretch of route fails, located on the ground."""

    type: str
    lat: float
    lon: float
    description: str
    at_m: float = 0.0


@dataclass(frozen=True)
class RouteAccessibility:
    verdict: Verdict
    findings: list[Finding] = field(default_factory=list)
    # Fraction of the route's length with a definite PASS or FAIL verdict.
    coverage: float = 0.0
    pass_fraction: float = 0.0
    fail_fraction: float = 0.0
    unknown_fraction: float = 1.0
    # Whether anything was actually asked about barriers. False means no source
    # was consulted — not that none were found. The two are different claims and
    # the sentence below has to make only the one that is true.
    barriers_checked: bool = False

    @property
    def is_blocked(self) -> bool:
        return self.verdict is Verdict.FAIL

    def sentence(self) -> str:
        """The confidence sentence, rendered verbatim by the frontend.

        The subject of the sentence is the honest part. "Accessibility data"
        names every dimension this engine has constraints for — surface,
        smoothness, steps, gradient and barriers — and claims a percentage of
        the route was checked against all of them. When no barrier data reached
        the assessment, that claim covers a dimension nothing looked at, and the
        one it hides is the one the project exists for: a gate or a stile stops
        a wheelchair dead where a rough surface only slows it.

        So the sentence narrows to what was measured, and says plainly what was
        not. Coverage itself is unaffected either way — it is computed from
        surface and smoothness alone, which is why "Surface data" is the honest
        subject for that number.
        """
        pct = round(self.coverage * 100)
        if self.coverage < VERY_LOW_CONFIDENCE_THRESHOLD:
            body = (
                f"{self._subject()} covers only {pct}% of this route. "
                "Most of it is unverified. Do not rely on it."
            )
        elif self.coverage < LOW_CONFIDENCE_THRESHOLD:
            body = (
                f"{self._subject()} covers {pct}% of this route; "
                "treat the remainder as unverified."
            )
        else:
            body = f"{self._subject()} covers {pct}% of this route."
        return body if self.barriers_checked else f"{body} Gates and stiles were not checked."

    def _subject(self) -> str:
        return "Accessibility data" if self.barriers_checked else "Surface data"


# --- per-value constraint checks ------------------------------------------


def assess_surface(value: Any) -> Verdict:
    if is_unknown(value):
        return Verdict.UNKNOWN
    key = normalise(value)
    if key in ACCEPTABLE_SURFACES:
        return Verdict.PASS
    if key in REJECTED_SURFACES:
        return Verdict.FAIL
    # A surface value nobody anticipated is not a licence to assume it is fine.
    log.info("unrecognised_surface", extra={"value": key})
    return Verdict.UNKNOWN


def assess_smoothness(value: Any) -> Verdict:
    if is_unknown(value):
        return Verdict.UNKNOWN
    key = normalise(value)
    if key in REJECTED_SMOOTHNESS:
        return Verdict.FAIL
    if key in {"EXCELLENT", "GOOD", "INTERMEDIATE"}:
        return Verdict.PASS
    log.info("unrecognised_smoothness", extra={"value": key})
    return Verdict.UNKNOWN


def assess_barrier(value: Any) -> Verdict:
    """A barrier tag only ever rejects. Its absence proves nothing."""
    if is_unknown(value):
        return Verdict.UNKNOWN
    key = normalise(value)
    if key in REJECTED_BARRIERS:
        return Verdict.FAIL
    if key in ACCEPTED_BARRIERS:
        return Verdict.PASS
    log.info("unrecognised_barrier", extra={"value": key})
    return Verdict.UNKNOWN


def assess_road_class(value: Any) -> Verdict:
    if is_unknown(value):
        return Verdict.UNKNOWN
    if normalise(value) in REJECTED_ROAD_CLASSES:
        return Verdict.FAIL
    # Not being steps does not make a way accessible — only its surface and
    # smoothness can say that. This is why road_class alone never returns PASS.
    return Verdict.UNKNOWN


# --- incline ---------------------------------------------------------------


def _resample_elevation(
    points: Sequence[LatLon], elevations: Sequence[float], spacing_m: float
) -> tuple[np.ndarray, np.ndarray]:
    cum = cumulative_distance_m(points)
    total = float(cum[-1]) if len(cum) else 0.0
    if total < spacing_m * 2:
        return np.zeros(0), np.zeros(0)
    grid = np.arange(0.0, total, spacing_m)
    return grid, np.interp(grid, cum, np.asarray(elevations, dtype=float))


def incline_findings(
    points: Sequence[LatLon], elevations: Sequence[float] | None
) -> list[Finding]:
    """Gradients that break the hard limits.

    Measured on an elevation profile resampled to a fixed spacing, because
    routers emit vertices at irregular intervals and a 2 m segment with 0.3 m of
    sensor noise reads as a 15% gradient that is not there.
    """
    if not elevations or len(elevations) != len(points) or len(points) < 3:
        return []

    grid, profile = _resample_elevation(points, elevations, INCLINE_SMOOTHING_WINDOW_M)
    if len(grid) < 3:
        return []

    gradients = np.diff(profile) / INCLINE_SMOOTHING_WINDOW_M * 100.0
    cum = cumulative_distance_m(points)
    findings: list[Finding] = []

    def point_at(distance_m: float) -> LatLon:
        idx = int(np.searchsorted(cum, distance_m))
        return points[min(idx, len(points) - 1)]

    steepest = int(np.argmax(np.abs(gradients))) if len(gradients) else -1
    if steepest >= 0 and abs(gradients[steepest]) > MAX_INCLINE_PCT:
        at_m = float(grid[steepest])
        findings.append(
            Finding(
                type="incline",
                lat=point_at(at_m).lat,
                lon=point_at(at_m).lon,
                at_m=round(at_m),
                # One decimal place, because rounding 8.4 to "8" makes the
                # sentence read "8%, steeper than the 8% limit".
                description=(
                    f"A gradient of {abs(gradients[steepest]):.1f}% "
                    f"{'up' if gradients[steepest] > 0 else 'down'}, "
                    f"steeper than the {MAX_INCLINE_PCT:.0f}% limit."
                ),
            )
        )

    # Sustained: any run of windows averaging over the sustained limit for at
    # least SUSTAINED_INCLINE_OVER_M. A long 6% ramp is impassable for many
    # wheelchair users even though no single metre of it is steep.
    window = max(2, int(SUSTAINED_INCLINE_OVER_M / INCLINE_SMOOTHING_WINDOW_M))
    if len(gradients) >= window:
        kernel = np.ones(window) / window
        rolling = np.convolve(gradients, kernel, mode="valid")
        worst = int(np.argmax(np.abs(rolling)))
        if abs(rolling[worst]) > SUSTAINED_INCLINE_PCT and not findings:
            at_m = float(grid[worst])
            findings.append(
                Finding(
                    type="incline",
                    lat=point_at(at_m).lat,
                    lon=point_at(at_m).lon,
                    at_m=round(at_m),
                    description=(
                        f"A sustained {abs(rolling[worst]):.1f}% gradient over "
                        f"{SUSTAINED_INCLINE_OVER_M:.0f} m or more."
                    ),
                )
            )
    return findings


# --- whole-route assessment -----------------------------------------------

_HUMAN_BLOCKER_TEXT = {
    "steps": "Steps with no recorded step-free alternative.",
    "surface": "Surface recorded as {value}, which is not passable.",
    "smoothness": "Surface condition recorded as {value}.",
    "barrier": "A {value} across the path.",
}


def _span_verdicts(
    points: Sequence[LatLon],
    spans: Sequence[tuple[int, int, Any]] | None,
    check,
    finding_type: str,
) -> tuple[list[tuple[float, Verdict]], list[Finding]]:
    """Apply one constraint across a set of path-detail spans."""
    lengths = segment_lengths_m(points)
    if not spans or len(lengths) == 0:
        return [], []

    weighted: list[tuple[float, Verdict]] = []
    findings: list[Finding] = []
    cum = cumulative_distance_m(points)

    for start, end, value in spans:
        lo = max(0, min(int(start), len(lengths)))
        hi = max(lo, min(int(end), len(lengths)))
        span_length = float(lengths[lo:hi].sum())
        if span_length <= 0:
            continue
        verdict = check(value)
        weighted.append((span_length, verdict))
        if verdict is Verdict.FAIL:
            at = points[min(lo, len(points) - 1)]
            template = _HUMAN_BLOCKER_TEXT.get(finding_type, "{value}")
            findings.append(
                Finding(
                    type="steps" if finding_type == "steps" else finding_type,
                    lat=at.lat,
                    lon=at.lon,
                    at_m=round(float(cum[min(lo, len(cum) - 1)])),
                    description=template.format(value=str(value).lower().replace("_", " ")),
                )
            )
    return weighted, findings


def assess_route(
    points: Sequence[LatLon],
    elevations: Sequence[float] | None = None,
    details: dict[str, Sequence[tuple[int, int, Any]]] | None = None,
    osm_tags: dict[str, Any] | None = None,
) -> RouteAccessibility:
    """Assess a whole route against the hard constraints.

    ``osm_tags`` carries anything Overpass found that the router did not report
    — barriers and smoothness, mainly. Its absence lowers coverage; it never
    grants a PASS.
    """
    details = details or {}
    # None means nobody looked; a list — including an empty one — means a source
    # was consulted and this is what it said. Only the second licenses the
    # sentence to stop disclaiming barriers.
    barrier_spans = (osm_tags or {}).get("barrier")
    barriers_checked = barrier_spans is not None

    lengths = segment_lengths_m(points)
    total = float(lengths.sum())
    if total <= 0 or len(points) < 2:
        return RouteAccessibility(Verdict.UNKNOWN, [], 0.0, 0.0, 0.0, 1.0, barriers_checked)

    findings: list[Finding] = []

    steps_weighted, steps_findings = _span_verdicts(
        points, details.get("road_class"), assess_road_class, "steps"
    )
    surface_weighted, surface_findings = _span_verdicts(
        points, details.get("surface"), assess_surface, "surface"
    )
    smooth_weighted, smooth_findings = _span_verdicts(
        points, details.get("smoothness"), assess_smoothness, "smoothness"
    )
    barrier_weighted, barrier_findings = _span_verdicts(
        points, barrier_spans, assess_barrier, "barrier"
    )
    findings.extend(steps_findings)
    findings.extend(surface_findings)
    findings.extend(smooth_findings)
    findings.extend(barrier_findings)
    findings.extend(incline_findings(points, elevations))

    # Coverage is driven by surface and smoothness: they are the tags that can
    # actually say a stretch is passable. road_class can only ever reject.
    definite = 0.0
    passed = 0.0
    failed = 0.0
    for length, verdict in surface_weighted + smooth_weighted:
        if verdict is Verdict.UNKNOWN:
            continue
        definite += length
        if verdict is Verdict.PASS:
            passed += length
        else:
            failed += length

    # surface and smoothness are two independent passes over the same route, so
    # normalise by however many of them actually contributed.
    sources = sum(1 for spans in (surface_weighted, smooth_weighted) if spans)
    denominator = total * max(1, sources)

    coverage = min(1.0, definite / denominator) if denominator > 0 else 0.0
    pass_fraction = min(1.0, passed / denominator) if denominator > 0 else 0.0
    fail_fraction = min(1.0, failed / denominator) if denominator > 0 else 0.0

    if findings:
        verdict = Verdict.FAIL
    elif coverage <= 0.0:
        verdict = Verdict.UNKNOWN
    else:
        verdict = Verdict.PASS

    return RouteAccessibility(
        verdict=verdict,
        findings=findings,
        coverage=round(coverage, 4),
        pass_fraction=round(pass_fraction, 4),
        fail_fraction=round(fail_fraction, 4),
        unknown_fraction=round(max(0.0, 1.0 - coverage), 4),
        barriers_checked=barriers_checked,
    )
