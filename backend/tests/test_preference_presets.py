"""The three presets that shipped after fastest, scenic and accessible.

`quiet`, `shade` and `air` were in `RouteId` and in `ROUTE_LABELS` from the
start and in `PRESETS` from nowhere: the request path turned each of them into a
blocked route reading "not implemented yet". These are the tests that came with
the implementation.

Two of them are worth reading before the rest, because they guard failure modes
that are silent rather than loud:

* `test_custom_models_only_name_values_graphhopper_knows` catches the mistake
  routing.py:54-60 warns about in prose. A custom model naming an encoded value
  the graph does not have fails the **whole request**, not the rule, and the
  vocabulary is not the OSM one: `surface=earth` is valid OSM and invalid here.
* `test_every_preset_disables_contraction_hierarchies` catches the one
  CONTRIBUTING.md calls out by name. Without `ch.disable`, GraphHopper ignores
  the custom model in silence and returns the fastest route under another
  label, which is a preset that looks like it works.
"""

from __future__ import annotations

import asyncio
import re

import pytest

from backend.config import TEST_LOCATIONS_BY_SLUG
from backend.geometry import (
    ROAD_CLASS_AIR_PROXY,
    ROAD_CLASS_CANOPY_PROXY,
    ROAD_CLASS_QUIET_PROXY,
    ROAD_ENVIRONMENT_COVER,
    SURFACE_CANOPY_PROXY,
    SURFACE_QUIET,
    LatLon,
    score_geometry,
)
from backend.main import _blend_shade
from backend.models import ROUTE_LABELS, RouteId
from backend.routing import (
    GH_ROAD_CLASS_VALUES,
    GH_ROAD_ENVIRONMENT_VALUES,
    GH_SMOOTHNESS_VALUES,
    GH_SURFACE_VALUES,
    PRESET_NOTES,
    PRESETS,
    accessible_custom_model,
    air_custom_model,
    build_request_body,
    quiet_custom_model,
    scenic_custom_model,
    shade_custom_model,
)

PREFERENCE_PRESETS = ("quiet", "shade", "air")

# Every custom model in the codebase, by the name the request body calls it.
# accessible is taken with smoothness on: that is the self-hosted shape, and the
# shape with the extra encoded value in it is the one worth checking.
ALL_MODELS = {
    "scenic": scenic_custom_model(20),
    "accessible": accessible_custom_model(with_smoothness=True),
    "quiet": quiet_custom_model(),
    "shade": shade_custom_model(),
    "air": air_custom_model(),
}

VALUE_SETS = {
    "road_class": GH_ROAD_CLASS_VALUES,
    "surface": GH_SURFACE_VALUES,
    "road_environment": GH_ROAD_ENVIRONMENT_VALUES,
    "smoothness": GH_SMOOTHNESS_VALUES,
}

# `<encoded_value> == VALUE`, which is the only comparison any model here uses.
COMPARISON = re.compile(r"(\w+)\s*==\s*(\w+)")


def _comparisons(model: dict) -> list[tuple[str, str]]:
    return [
        match
        for rule in model["priority"]
        for match in COMPARISON.findall(str(rule.get("if", "")))
    ]


def _effective_multiplier(model: dict, encoded_value: str, value: str) -> float:
    """What the model does to an edge carrying exactly this one tag.

    Rules multiply, and every rule that does not mention ``encoded_value`` is
    skipped rather than assumed false, so this is the priority of an edge whose
    other tags are all unremarkable. That is the comparison the ordering test
    wants: two road classes on otherwise identical ways.
    """
    priority = 1.0
    for rule in model["priority"]:
        condition = str(rule.get("if", ""))
        names = {name for name, _ in COMPARISON.findall(condition)}
        if names != {encoded_value}:
            continue
        if (encoded_value, value) in COMPARISON.findall(condition):
            priority *= float(rule["multiply_by"])
    return priority


# --- the contract ----------------------------------------------------------


def test_every_declared_objective_has_a_preset() -> None:
    """`RouteId` is the promise and `PRESETS` is the delivery.

    They drifted apart for the whole of the project's first eleven phases, and
    the drift was invisible from the type: a request for `quiet` validated
    cleanly and came back blocked. This is the assertion that would have said so.
    """
    declared = set(RouteId.__args__)

    assert declared == set(PRESETS)
    assert declared == set(ROUTE_LABELS)


def test_preference_presets_each_have_a_note() -> None:
    assert set(PRESET_NOTES) == set(PREFERENCE_PRESETS)


@pytest.mark.parametrize("preset", PREFERENCE_PRESETS)
def test_every_preset_disables_contraction_hierarchies(preset: str) -> None:
    body = build_request_body(LatLon(51.5074, -0.1278), None, 35, "foot", preset)

    assert body["custom_model"]
    assert body["ch.disable"] is True


# --- the models ------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(ALL_MODELS))
def test_custom_models_only_name_values_graphhopper_knows(name: str) -> None:
    for encoded_value, value in _comparisons(ALL_MODELS[name]):
        assert encoded_value in VALUE_SETS, f"{name} steers on unknown {encoded_value!r}"
        assert value in VALUE_SETS[encoded_value], f"{name}: {encoded_value} == {value}"


@pytest.mark.parametrize("name", sorted(ALL_MODELS))
def test_custom_model_multipliers_are_in_range(name: str) -> None:
    for rule in ALL_MODELS[name]["priority"]:
        assert 0.0 <= float(rule["multiply_by"]) <= 1.0


def test_no_two_presets_send_the_same_custom_model() -> None:
    """Two labels over one route is the failure route_scenic's docstring names.

    Distinct models do not guarantee distinct routes — a graph with no tunnels
    in it will answer `air` and `quiet` identically, and honestly so. What this
    rules out is the version where they could never differ.
    """
    seen: dict[str, str] = {}
    for name, model in ALL_MODELS.items():
        key = repr(sorted(model["priority"], key=repr)) + repr(model["distance_influence"])
        assert key not in seen, f"{name} sends the same model as {seen.get(key)}"
        seen[key] = name


def test_air_and_shade_disagree_about_being_under_something() -> None:
    """The divergence both docstrings claim, asserted rather than described.

    A tunnel is the worst place on a route for the air you breathe and among the
    best for staying out of the sun. A bridge deck is the reverse. If these two
    ever agreed, one of the presets would have stopped being its own answer.
    """
    air, shade = ALL_MODELS["air"], ALL_MODELS["shade"]

    assert _effective_multiplier(air, "road_environment", "TUNNEL") < 0.1
    assert _effective_multiplier(shade, "road_environment", "TUNNEL") == 1.0
    assert _effective_multiplier(shade, "road_environment", "BRIDGE") < 0.5
    assert _effective_multiplier(air, "road_environment", "BRIDGE") == 1.0


def test_quiet_penalises_ordinary_streets_where_scenic_does_not() -> None:
    """The difference between "away from arterials" and "away from engines".

    scenic_custom_model leaves RESIDENTIAL, SERVICE and UNCLASSIFIED alone, so
    it only ever steers off main roads. A residential street still carries cars.
    """
    for road_class in ("RESIDENTIAL", "SERVICE", "UNCLASSIFIED"):
        assert _effective_multiplier(ALL_MODELS["scenic"], "road_class", road_class) == 1.0
        assert _effective_multiplier(ALL_MODELS["quiet"], "road_class", road_class) < 1.0


@pytest.mark.parametrize(
    ("preset", "table"),
    [
        ("quiet", ROAD_CLASS_QUIET_PROXY),
        ("shade", ROAD_CLASS_CANOPY_PROXY),
        ("air", ROAD_CLASS_AIR_PROXY),
    ],
)
def test_each_model_and_the_table_that_scores_it_agree_on_ordering(
    preset: str, table: dict[str, float]
) -> None:
    """The claim each of the three docstrings makes, enforced rather than described.

    The model picks the route and the table scores it. If they disagreed about
    which road class is better, a route chosen for an objective could score
    worse on that objective than the route that ignored it, which is the
    label-with-nothing-behind-it failure this project keeps writing tests about.

    Ordering only. The model sorts classes into a handful of bands and the table
    resolves further, so two classes sharing a multiplier may differ in the
    table; what is forbidden is the two disagreeing on direction.

    This caught a real one on the way in. `shade_custom_model` did not mention
    STEPS at all, and an unmentioned class keeps priority 1.0 — so the model put
    a flight of steps in its top band while ROAD_CLASS_CANOPY_PROXY rated it
    below an ordinary footway. Nothing else in the suite could have seen that.
    """
    model = ALL_MODELS[preset]
    classes = sorted(table)
    for first in classes:
        for second in classes:
            if (_effective_multiplier(model, "road_class", first)
                    <= _effective_multiplier(model, "road_class", second)):
                continue
            assert table[first] >= table[second], (
                f"the {preset} model prefers {first} to {second} and its table does not"
            )


# --- the tables ------------------------------------------------------------


@pytest.mark.parametrize(
    ("table", "vocabulary"),
    [
        (ROAD_CLASS_QUIET_PROXY, GH_ROAD_CLASS_VALUES),
        (ROAD_CLASS_CANOPY_PROXY, GH_ROAD_CLASS_VALUES),
    ],
)
def test_road_class_tables_cover_every_class_the_router_can_return(
    table: dict[str, float], vocabulary: frozenset[str]
) -> None:
    """A class missing from a table is not scored as bad, it is not scored at all.

    `weighted_tag_score` drops a value it does not recognise into the coverage
    denominator and nowhere else, so a gap here reads to a user as "less of this
    route was measured" with no indication of why. OTHER is excluded because
    that is what the router says when it has nothing to say.
    """
    assert set(table) == vocabulary - {"OTHER"}


@pytest.mark.parametrize(
    "table",
    [ROAD_CLASS_QUIET_PROXY, SURFACE_QUIET, ROAD_CLASS_CANOPY_PROXY,
     SURFACE_CANOPY_PROXY, ROAD_ENVIRONMENT_COVER],
)
def test_proxy_tables_are_on_a_zero_to_one_scale(table: dict[str, float]) -> None:
    assert all(0.0 <= value <= 1.0 for value in table.values())


def test_the_quiet_surface_table_is_not_the_naturalness_one_rescaled() -> None:
    """The term that stops the quiet score being a re-scaling of the air proxy.

    Both read the same `road_class`, because it is the only proxy for motor
    traffic either has. Surface is where they part: cobbles are loud and no
    dirtier for it, asphalt is quiet and SURFACE_NATURALNESS rates it 0.15.
    """
    from backend.geometry import SURFACE_NATURALNESS

    assert SURFACE_QUIET["ASPHALT"] > SURFACE_QUIET["COBBLESTONE"]
    assert SURFACE_NATURALNESS["ASPHALT"] < SURFACE_NATURALNESS["COBBLESTONE"]


def test_the_canopy_tables_are_not_the_naturalness_ones_rescaled() -> None:
    """An open meadow and a beach are natural, and neither has any shade in it."""
    from backend.geometry import SURFACE_NATURALNESS

    assert SURFACE_NATURALNESS["GRASS"] > SURFACE_NATURALNESS["WOOD"]
    assert SURFACE_CANOPY_PROXY["GRASS"] < SURFACE_CANOPY_PROXY["WOOD"]
    assert SURFACE_NATURALNESS["SAND"] > SURFACE_NATURALNESS["COBBLESTONE"]
    assert SURFACE_CANOPY_PROXY["SAND"] < SURFACE_CANOPY_PROXY["COBBLESTONE"]


# --- the scores ------------------------------------------------------------


def _straight_line(points: int = 40, spacing_deg: float = 0.0004) -> list[LatLon]:
    return [LatLon(51.5 + i * spacing_deg, -0.12) for i in range(points)]


def _spans(points: int, value: str) -> list[tuple[int, int, str]]:
    return [(0, points - 1, value)]


def test_quiet_score_is_null_when_no_tag_supports_it() -> None:
    """The rule the whole project turns on, applied to a new field.

    Zero quiet is a claim about a street. Nobody looked is not.
    """
    points = _straight_line()
    scores = score_geometry(points, None, {"road_class": _spans(len(points), "MISSING")})

    assert scores.quiet is None
    assert scores.shade_cover is None


def test_quiet_score_separates_a_lane_from_a_trunk_road() -> None:
    points = _straight_line()
    lane = score_geometry(points, None, {"road_class": _spans(len(points), "LIVING_STREET")})
    trunk = score_geometry(points, None, {"road_class": _spans(len(points), "TRUNK")})

    assert lane.quiet is not None and trunk.quiet is not None
    assert lane.quiet > trunk.quiet + 0.5


def test_a_tunnel_raises_cover_over_the_length_it_covers() -> None:
    """The road_environment term is blended by length, not weighted as an opinion.

    Half a route under cover should move the number about half way. Weighting
    the tag against the proxy as two views of the whole route would let a short
    footbridge decide the shade of a long walk under trees.
    """
    points = _straight_line()
    n = len(points)
    base = score_geometry(points, None, {"road_class": _spans(n, "RESIDENTIAL")})
    half = score_geometry(points, None, {
        "road_class": _spans(n, "RESIDENTIAL"),
        "road_environment": [(0, (n - 1) // 2, "TUNNEL")],
    })

    assert base.shade_cover is not None and half.shade_cover is not None
    assert half.shade_cover > base.shade_cover
    midpoint = (base.shade_cover + 1.0) / 2

    assert half.shade_cover == pytest.approx(midpoint, abs=0.05)


def test_a_bridge_lowers_cover() -> None:
    points = _straight_line()
    n = len(points)
    plain = score_geometry(points, None, {"road_class": _spans(n, "FOOTWAY")})
    exposed = score_geometry(points, None, {
        "road_class": _spans(n, "FOOTWAY"),
        "road_environment": _spans(n, "BRIDGE"),
    })

    assert plain.shade_cover is not None and exposed.shade_cover is not None
    assert exposed.shade_cover < plain.shade_cover


# --- the shade blend -------------------------------------------------------


def test_shade_is_not_a_complaint_about_the_dark() -> None:
    """Need 0 means every route scores 1.0, whatever it is made of.

    At midnight, or under closed cloud, nobody is short of shade. A low score
    there would be the app inventing a problem.
    """
    assert _blend_shade(0.0, 0.0) == 1.0
    assert _blend_shade(0.0, 1.0) == 1.0


def test_under_a_clear_midday_sun_the_score_is_the_route_cover() -> None:
    assert _blend_shade(1.0, 0.42) == pytest.approx(0.42)


def test_shade_generalises_the_figure_enrichment_used_to_return_alone() -> None:
    """The old formula was this one with cover pinned to zero.

    enrich.py computed `1 - need` and stamped it on every route in the request,
    so no route could be shadier than any other and the Shade preset would have
    had nothing to say. Pinning cover back to 0 must reproduce it exactly.
    """
    for need in (0.0, 0.25, 0.5, 0.75, 1.0):
        assert _blend_shade(need, 0.0) == pytest.approx(1.0 - need)


@pytest.mark.parametrize(("need", "cover"), [(None, 0.5), (0.5, None), (None, None)])
def test_shade_is_null_when_either_half_is_missing(
    need: float | None, cover: float | None
) -> None:
    """A missing cover is the case worth naming.

    Answering "how much of your need is met" with no idea what the route
    provides means assuming it provides nothing, which is a claim about a place
    rather than an absence of one.
    """
    assert _blend_shade(need, cover) is None


# --- end to end, against the committed fixtures ----------------------------


@pytest.mark.parametrize(
    ("slug", "destination_slug", "minutes", "mode"),
    [
        ("hyde-park-london", None, 35, "foot"),
        ("euston-road-london", "hyde-park-london", 40, "foot"),
        ("amsterdam-vondelpark", None, 60, "bike"),
    ],
)
def test_each_preference_preset_beats_fastest_on_its_own_measure(
    slug: str, destination_slug: str | None, minutes: int, mode: str
) -> None:
    """The bar a preset has to clear to deserve its label.

    **Beats `fastest`, not "beats every other preset".** Scenic often wins on
    quietness and on air, and that is not a defect to be tuned away: a woodland
    path really is quiet and really is away from traffic. What would be a defect
    is a preference preset that steers for something and lands no closer to it
    than the route that ignored it entirely.

    Synthetic fixtures, so these are numbers about invented terrain. The
    arrangement they are testing is real: each model asks for a different thing
    and each score reads a different table.
    """
    origin_loc = TEST_LOCATIONS_BY_SLUG[slug]
    origin = LatLon(origin_loc.lat, origin_loc.lon)
    destination = None
    if destination_slug:
        d = TEST_LOCATIONS_BY_SLUG[destination_slug]
        destination = LatLon(d.lat, d.lon)

    async def measure(preset: str):
        route = await PRESETS[preset](origin, destination, minutes, mode)
        return score_geometry(route.points, route.elevations or None, route.details)

    async def run():
        return {
            preset: await measure(preset)
            for preset in ("fastest", *PREFERENCE_PRESETS)
        }

    scores = asyncio.run(run())
    baseline = scores["fastest"]

    assert scores["quiet"].quiet > baseline.quiet
    assert scores["air"].air > baseline.air
    assert scores["shade"].shade_cover > baseline.shade_cover


def test_each_preference_preset_returns_its_own_geometry() -> None:
    """Three labels over one line would be three answers to one question."""
    origin_loc = TEST_LOCATIONS_BY_SLUG["hyde-park-london"]
    origin = LatLon(origin_loc.lat, origin_loc.lon)

    async def run():
        return {p: await PRESETS[p](origin, None, 35, "foot") for p in PREFERENCE_PRESETS}

    routes = asyncio.run(run())
    shapes = {name: [(p.lat, p.lon) for p in route.points] for name, route in routes.items()}

    assert len({repr(shape) for shape in shapes.values()}) == len(PREFERENCE_PRESETS)


@pytest.mark.parametrize("preset", PREFERENCE_PRESETS)
def test_a_preference_route_says_what_it_inferred_its_objective_from(preset: str) -> None:
    """Carried on every route of these presets, not only when something failed.

    None of the three can be measured directly, and a bare number under the word
    "Shade" invites a reader to assume a survey that does not exist.
    """
    origin_loc = TEST_LOCATIONS_BY_SLUG["hyde-park-london"]
    origin = LatLon(origin_loc.lat, origin_loc.lon)
    route = asyncio.run(PRESETS[preset](origin, None, 35, "foot"))

    assert route.preset_note == PRESET_NOTES[preset]
