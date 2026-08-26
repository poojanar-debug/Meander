# 7 · Quiet, shade and air are proxies, and say so

**Accepted.** The decision a reviewer should question hardest in this project,
because it sits closest to the one rule the project refuses to bend.

## Context

`RouteId` promised six objectives from the first commit. Three of them —
`quiet`, `shade`, `air` — had a label, a colour, a dash pattern and a disabled
chip reading `· soon`, and no implementation: the request path turned each into
a blocked route reading "not implemented yet".

Building them ran straight into the rule in [0001](0001-unknown-is-not-accessible.md).
None of the three things they are named after exists in OpenStreetMap in a form
a router can steer on:

- **Noise.** No noise layer. Nothing on a way says how loud it is.
- **Canopy.** Trees are mapped as points and woodland as areas. Neither reaches
  an edge, which is the only thing a `custom_model` can read.
- **Pollution.** Open-Meteo has a real measurement and it covers a whole city.
  On its own it gives every route in that city the same number, which is why
  `_blend_air` already existed before any of this.

What is available is `road_class`, `surface` and `road_environment` — three tags
about the *kind* of way, from which all three objectives have to be inferred.

## Decision

Build the three presets on tag proxies, and **make every route from them state
its basis in a sentence a user reads**, not only in a comment a developer reads.

`routing.PRESET_NOTES` holds one sentence per preset. It travels on `preset_note`
and arrives as `status_note` on **every** route of that preset, including
successful ones. The shade note names the missing data outright: "OpenStreetMap
maps trees as points and woods as areas, and neither reaches the streets you
walk on."

Two supporting decisions fall out of it:

- **`Scores.shade` became per-route.** It used to be one number computed at the
  midpoint of the longest route and stamped on all of them. Under three
  objectives nobody could tell. A Shade *preset* would have reported exactly the
  shade of the route that ignored shade, so the figure was split: enrichment
  supplies the demand, `score_geometry` supplies what each route offers, and
  `main._blend_shade` combines them.
- **`Scores.quiet` was added** rather than reusing `air`. The two share their
  dominant term and that is admitted in the table comments, but a preset with no
  number beside it cannot be checked by the person reading the card.

## Alternatives rejected

**Query Overpass for tree and woodland polygons.** The honest version of shade,
and the reason it is not here is measured rather than assumed. Overpass is
already the entire latency budget of a request — 13.6 s for a trivial bench
query on this project against 0.024 s for a whole self-hosted route — and
`overpass_barrier_query` records that one bbox over three Vondelpark routes
returns **more than 2,000 barrier nodes** and truncates. Trees are denser than
barriers. A truncated answer is a biased sample of the bbox, and a biased sample
cannot support a claim at all. Worth revisiting behind a cache; not worth
putting on the request path.

**Ship two presets instead of three, folding quiet into air.** Rejected on the
contract: `quiet` is in `RouteId`, in `ROUTE_LABELS`, in the dash table and in
the chip row, and shared permalinks carry objective ids. It is also wrong on the
merits — cobblestones are loud and no dirtier for it, which is the whole of
`SURFACE_QUIET`.

**Tune the numbers until each preset wins its own metric.** The synthetic
fixtures made this tempting: on the demo data `scenic` beats `air` on the air
proxy at two of three locations. It was not done, because it is true. A woodland
path really is quiet and really is away from traffic, and editing the committed
fixtures of a shipped preset to flatter a new one would be inventing a result.
The test asserts each preference preset beats **`fastest`** on its own measure,
which is the bar a label actually has to clear.

## Consequences

- Three presets ship on judgements rather than measurements, and every one of
  them says so on the card. The tables that encode those judgements are in
  `geometry.py` beside the constants, in the house style, and the weights are
  named rather than inlined.
- `test_preference_presets.py` holds the two guards that matter: that a custom
  model only names encoded values GraphHopper accepts (a wrong one fails the
  whole request, not the rule), and that each model and the table that scores
  its result agree on ordering. The second caught a real defect on the way in —
  `shade_custom_model` did not mention `STEPS`, and an unmentioned class keeps
  priority 1.0, so the model put a flight of steps in its top band while the
  canopy table rated it below a footway.
- Five of six presets now carry a custom model, so five need flexible mode. On a
  free hosted package the app answers with one route and five blocked ones.
  [0002](0002-self-host-graphhopper.md) got more load-bearing, not less.
- **A round trip is a candidate search, and the first version of this decision
  got that wrong.** The presets originally sent one request and returned what
  came back, on the reasoning that their `distance_influence` values (35, 45,
  55) are restrictive enough next to scenic's 20 that a cap could not be needed.
  The synthetic fixtures agreed: `shade` came back at 1.24x fastest. The first
  run against a real self-hosted graph did not. At Colombo Fort, 30 minutes on
  foot:

  | | one request | three candidates |
  |---|---|---|
  | `quiet` | 108.4 min | 18.0 min |
  | `shade` | 118.0 min | 17.5 min |
  | `air` | 114.7 min | 18.0 min |

  `distance_influence` never restrained it, because the loop's length comes from
  `round_trip.distance`. It is the same discontinuity `SCENIC_LOOP_CANDIDATES`
  documents — round_trip picks a *candidate loop*, and reweighting the graph
  sends it to a different one rather than a slower version of the same one.
  `PREFERENCE_LOOP_SCALES` is the smallest form of scenic's remedy: try three
  lengths, keep the best `_budget_fit`. No greenness floor and no baseline
  request, because the only question is whether it fits in thirty minutes.

  Colombo now undershoots instead (18 against 30), which is what that network
  offers — `scenic` returns 18.0 there too. The card says so, in the sentence
  scenic has always used for it.
- If a canopy layer ever becomes routable, the shade note is the thing that has
  to change first, and it is one dictionary.
