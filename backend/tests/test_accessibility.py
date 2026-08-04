"""The accessibility engine.

This is the most consequential file in the test suite. A silent bug here does
not produce a slightly worse route — it tells a wheelchair user that a flight of
steps is step-free.

The invariant every test below exists to defend: **a missing tag is UNKNOWN,
never PASS.**
"""

from __future__ import annotations

import math

import pytest

from backend.accessibility import (
    ACCEPTABLE_SURFACES,
    MAX_INCLINE_PCT,
    REJECTED_BARRIERS,
    REJECTED_SMOOTHNESS,
    REJECTED_SURFACES,
    SUSTAINED_INCLINE_PCT,
    Verdict,
    assess_barrier,
    assess_road_class,
    assess_route,
    assess_smoothness,
    assess_surface,
    incline_findings,
    is_unknown,
    normalise,
)
from backend.geometry import EARTH_RADIUS_M, LatLon

M_PER_DEG = math.pi * EARTH_RADIUS_M / 180.0
START = LatLon(51.5073, -0.1657)


def _line(metres: float, n: int = 61) -> list[LatLon]:
    return [LatLon(START.lat + (metres * i / (n - 1)) / M_PER_DEG, START.lon) for i in range(n)]


def _flat(n: int) -> list[float]:
    return [10.0] * n


def _ramp(n: int, metres: float, grade_pct: float) -> list[float]:
    return [10.0 + metres * (i / (n - 1)) * grade_pct / 100.0 for i in range(n)]


# ---------------------------------------------------------------------------
# the invariant: unknown is never accessible
# ---------------------------------------------------------------------------


def test_a_verdict_cannot_be_used_as_a_boolean() -> None:
    """`if verdict:` would make UNKNOWN read as accessible. It must not compile away
    into a silently wrong answer — it must raise."""
    with pytest.raises(TypeError, match="compared explicitly"):
        bool(Verdict.UNKNOWN)
    with pytest.raises(TypeError):
        # Written as an explicit truthiness test because that is the misuse
        # under test; ruff's SIM300/SIM103 rewrites would defeat the point.
        assert Verdict.PASS


@pytest.mark.parametrize("absent", [None, "", "missing", "MISSING", "unknown", "none"])
def test_an_absent_surface_tag_is_unknown_not_accessible(absent) -> None:
    assert assess_surface(absent) is Verdict.UNKNOWN
    assert assess_surface(absent) is not Verdict.PASS


@pytest.mark.parametrize("absent", [None, "", "missing", "unknown"])
def test_an_absent_smoothness_tag_is_unknown_not_accessible(absent) -> None:
    assert assess_smoothness(absent) is Verdict.UNKNOWN


@pytest.mark.parametrize("absent", [None, "", "missing", "unknown"])
def test_an_absent_barrier_tag_is_unknown_not_accessible(absent) -> None:
    """No barrier tag means nobody looked, not that there is no barrier."""
    assert assess_barrier(absent) is Verdict.UNKNOWN


def test_a_surface_value_nobody_anticipated_is_unknown_not_accessible() -> None:
    """New OSM values appear all the time. An unrecognised one is not a licence
    to assume the way is fine."""
    assert assess_surface("rubber_matting") is Verdict.UNKNOWN
    assert assess_smoothness("perfect") is Verdict.UNKNOWN
    assert assess_barrier("hedgehog_gate") is Verdict.UNKNOWN


def test_an_entirely_untagged_route_is_never_reported_as_accessible() -> None:
    """The headline case. No tags at all must not produce a PASS."""
    points = _line(1000)
    result = assess_route(points, _flat(len(points)), details={})

    assert result.verdict is Verdict.UNKNOWN
    assert result.verdict is not Verdict.PASS
    assert result.coverage == 0.0
    assert result.unknown_fraction == 1.0
    assert "do not rely on it" in result.sentence()


def test_a_route_tagged_only_with_road_class_is_not_accessible() -> None:
    """road_class can reject (steps) but can never grant a pass: a footway can
    still be cobbles."""
    points = _line(1000)
    result = assess_route(
        points, _flat(len(points)), details={"road_class": [(0, 60, "FOOTWAY")]}
    )

    assert result.verdict is Verdict.UNKNOWN
    assert result.coverage == 0.0


def test_road_class_alone_never_returns_pass() -> None:
    for value in ("FOOTWAY", "RESIDENTIAL", "PATH", "PRIMARY"):
        assert assess_road_class(value) is not Verdict.PASS


# ---------------------------------------------------------------------------
# hard constraint 1 — steps
# ---------------------------------------------------------------------------


def test_steps_are_rejected() -> None:
    assert assess_road_class("STEPS") is Verdict.FAIL
    assert assess_road_class("steps") is Verdict.FAIL


def test_a_route_with_steps_is_blocked_with_a_populated_blocker() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={
            "road_class": [(0, 25, "FOOTWAY"), (25, 30, "STEPS"), (30, 60, "FOOTWAY")],
            "surface": [(0, 60, "ASPHALT")],
        },
    )

    assert result.is_blocked
    assert result.verdict is Verdict.FAIL
    steps = [f for f in result.findings if f.type == "steps"]
    assert len(steps) == 1
    assert steps[0].description
    assert steps[0].lat != 0.0 and steps[0].lon != 0.0
    assert steps[0].at_m > 0


# ---------------------------------------------------------------------------
# hard constraint 2 — barriers
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("barrier", sorted(REJECTED_BARRIERS))
def test_every_rejected_barrier_type_fails(barrier: str) -> None:
    assert assess_barrier(barrier) is Verdict.FAIL
    assert assess_barrier(barrier.lower()) is Verdict.FAIL


def test_the_rejected_barrier_set_matches_the_specification() -> None:
    assert set(REJECTED_BARRIERS) == {"GATE", "STILE", "TURNSTILE", "KISSING_GATE"}


def test_a_barrier_found_by_overpass_blocks_the_route() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={"surface": [(0, 60, "ASPHALT")]},
        osm_tags={"barrier": [(28, 30, "kissing_gate")]},
    )

    assert result.is_blocked
    assert [f.type for f in result.findings] == ["barrier"]
    assert "kissing gate" in result.findings[0].description


def test_an_explicit_absence_of_a_barrier_passes() -> None:
    assert assess_barrier("no") is Verdict.PASS


# ---------------------------------------------------------------------------
# hard constraint 3 — incline
# ---------------------------------------------------------------------------


def test_a_flat_route_has_no_incline_findings() -> None:
    points = _line(600)
    assert incline_findings(points, _flat(len(points))) == []


def test_a_gradient_over_the_limit_is_rejected() -> None:
    points = _line(400, n=81)
    steep = _ramp(len(points), 400, MAX_INCLINE_PCT + 6)

    findings = incline_findings(points, steep)
    assert findings and findings[0].type == "incline"
    assert "%" in findings[0].description


def test_a_gradient_just_under_the_limit_is_accepted() -> None:
    points = _line(400, n=81)
    gentle = _ramp(len(points), 400, MAX_INCLINE_PCT - 5)

    assert [f for f in incline_findings(points, gentle) if "steeper" in f.description] == []


def test_a_sustained_moderate_gradient_is_rejected() -> None:
    """A long 6% ramp is impassable for many wheelchair users even though no
    single metre of it breaks the 8% limit."""
    points = _line(300, n=61)
    sustained = _ramp(len(points), 300, SUSTAINED_INCLINE_PCT + 1.5)

    findings = incline_findings(points, sustained)
    assert findings
    assert "sustained" in findings[0].description.lower()


def test_a_downhill_gradient_is_rejected_too() -> None:
    """Going down a 14% slope in a wheelchair is not safer than going up it."""
    points = _line(400, n=81)
    downhill = _ramp(len(points), 400, -(MAX_INCLINE_PCT + 6))

    findings = incline_findings(points, downhill)
    assert findings
    assert "down" in findings[0].description


def test_elevation_noise_does_not_invent_a_gradient() -> None:
    """Routers emit vertices at irregular spacing; 0.3 m of sensor noise across a
    2 m segment reads as 15% if you do not smooth."""
    points = _line(600, n=121)
    noisy = [10.0 + (0.3 if i % 2 else -0.3) for i in range(len(points))]

    assert incline_findings(points, noisy) == []


def test_missing_elevation_produces_no_incline_findings() -> None:
    points = _line(600)
    assert incline_findings(points, None) == []
    assert incline_findings(points, []) == []


def test_mismatched_elevation_length_is_ignored_rather_than_misread() -> None:
    points = _line(600)
    assert incline_findings(points, [10.0, 20.0]) == []


# ---------------------------------------------------------------------------
# hard constraint 4 — surface
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("surface", sorted(ACCEPTABLE_SURFACES))
def test_every_acceptable_surface_passes(surface: str) -> None:
    assert assess_surface(surface) is Verdict.PASS
    assert assess_surface(surface.lower()) is Verdict.PASS


def test_the_acceptable_surface_set_matches_the_specification() -> None:
    assert set(ACCEPTABLE_SURFACES) == {
        "PAVED", "ASPHALT", "CONCRETE", "PAVING_STONES", "COMPACTED"
    }


@pytest.mark.parametrize("surface", sorted(REJECTED_SURFACES))
def test_every_rejected_surface_fails(surface: str) -> None:
    assert assess_surface(surface) is Verdict.FAIL


def test_a_rejected_surface_blocks_the_route_with_a_located_finding() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={"surface": [(0, 40, "ASPHALT"), (40, 60, "COBBLESTONE")]},
    )

    assert result.is_blocked
    surface_findings = [f for f in result.findings if f.type == "surface"]
    assert len(surface_findings) == 1
    assert "cobblestone" in surface_findings[0].description


def test_osm_and_graphhopper_tag_spellings_agree() -> None:
    assert assess_surface("paving_stones") is assess_surface("PAVING_STONES")
    assert normalise("paving-stones") == "PAVING_STONES"
    assert normalise(" Asphalt ") == "ASPHALT"


# ---------------------------------------------------------------------------
# hard constraint 5 — smoothness
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("value", sorted(REJECTED_SMOOTHNESS))
def test_every_rejected_smoothness_fails(value: str) -> None:
    assert assess_smoothness(value) is Verdict.FAIL


def test_the_rejected_smoothness_set_matches_the_specification() -> None:
    assert set(REJECTED_SMOOTHNESS) == {
        "BAD", "VERY_BAD", "HORRIBLE", "VERY_HORRIBLE", "IMPASSABLE"
    }


@pytest.mark.parametrize("value", ["excellent", "good", "intermediate"])
def test_usable_smoothness_passes(value: str) -> None:
    assert assess_smoothness(value) is Verdict.PASS


def test_bad_smoothness_blocks_the_route() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={
            "surface": [(0, 60, "ASPHALT")],
            "smoothness": [(0, 30, "good"), (30, 60, "very_bad")],
        },
    )

    assert result.is_blocked
    assert any(f.type == "smoothness" for f in result.findings)


# ---------------------------------------------------------------------------
# coverage and confidence
# ---------------------------------------------------------------------------


def test_a_fully_tagged_passable_route_passes_with_full_coverage() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={
            "surface": [(0, 60, "ASPHALT")],
            "smoothness": [(0, 60, "good")],
        },
    )

    assert result.verdict is Verdict.PASS
    assert result.coverage == pytest.approx(1.0, abs=0.02)
    assert result.unknown_fraction == pytest.approx(0.0, abs=0.02)
    assert result.sentence() == "Accessibility data covers 100% of this route."


def test_partial_tagging_produces_partial_coverage() -> None:
    points = _line(1000)
    result = assess_route(
        points, _flat(len(points)), details={"surface": [(0, 30, "ASPHALT")]}
    )

    assert result.coverage == pytest.approx(0.5, abs=0.05)
    assert "treat the remainder as unverified" in result.sentence()


def test_the_confidence_sentence_escalates_as_coverage_falls() -> None:
    points = _line(1000)

    high = assess_route(points, _flat(len(points)),
                        details={"surface": [(0, 50, "ASPHALT")]})
    low = assess_route(points, _flat(len(points)),
                       details={"surface": [(0, 12, "ASPHALT")]})

    assert high.sentence().endswith("of this route.")
    assert "do not rely on it" in low.sentence()
    assert "only" in low.sentence()


def test_coverage_is_never_above_one() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _flat(len(points)),
        details={"surface": [(0, 60, "ASPHALT")], "smoothness": [(0, 60, "good")]},
    )
    assert result.coverage <= 1.0


def test_a_degenerate_route_is_unknown_not_passable() -> None:
    assert assess_route([START], None, {}).verdict is Verdict.UNKNOWN
    assert assess_route([], None, {}).verdict is Verdict.UNKNOWN


def test_findings_always_carry_a_position_and_a_sentence() -> None:
    points = _line(1000)
    result = assess_route(
        points,
        _ramp(len(points), 1000, 12),
        details={
            "road_class": [(0, 20, "STEPS")],
            "surface": [(20, 60, "GRAVEL")],
        },
    )

    assert len(result.findings) >= 2
    for finding in result.findings:
        assert finding.description.strip().endswith(".")
        assert -90 <= finding.lat <= 90
        assert -180 <= finding.lon <= 180
        assert finding.at_m >= 0


def test_is_unknown_helper() -> None:
    assert is_unknown(None) and is_unknown("") and is_unknown("MISSING")
    assert not is_unknown("asphalt")


def test_the_incline_message_is_never_self_contradictory() -> None:
    """Rounding 8.4 to "8" produced "8%, steeper than the 8% limit"."""
    points = _line(400, n=81)
    findings = incline_findings(points, _ramp(len(points), 400, MAX_INCLINE_PCT + 0.4))

    assert findings
    reported = float(findings[0].description.split("%")[0].split()[-1])
    assert reported > MAX_INCLINE_PCT
