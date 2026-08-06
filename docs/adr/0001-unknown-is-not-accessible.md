# 1 · A missing OpenStreetMap tag is UNKNOWN, never "accessible"

**Accepted.** The single most important decision in the project, and the one
every other decision defers to.

## Context

The specification's hard constraint reads: exclude ways whose `surface` is not
in a known-good set. Read literally, `surface == MISSING` is excluded — and most
of the world's footways carry no `surface` tag at all, no `smoothness` tag and
no `kerb` tag. Applied literally the accessible preset returns no route almost
anywhere and the feature is useless.

The tempting alternative is a default: treat untagged as probably-fine, because
most pavement is fine. That produces an app that answers the question it was
built for — "can I get there in a wheelchair" — with a guess, presented in the
same visual language as a fact.

## Decision

Three-valued logic, enforced by the type system rather than by convention.

- `Verdict` is `PASS`, `FAIL` or `UNKNOWN`, and **`Verdict.__bool__` raises**.
  `if verdict:` is a `TypeError` on first execution instead of a wrong answer
  in production, because that expression silently treats UNKNOWN as passing.
- The router excludes only *tagged bad* values. Untagged ways are routed.
- `accessibility.py` then marks untagged spans UNKNOWN, counts them against
  `confidence`, and they can never contribute a PASS.
- `road_class` can reject but can never pass. A way tagged `FOOTWAY` and
  nothing else is still UNKNOWN — a footway can be cobbles.
- Every response carries `confidence`, a sentence saying what that means, and
  `scoring_method`. A route with no recorded barriers and low coverage gets an
  explicit `status_note`: *"No barriers were found, but almost nothing along
  this route has been recorded in OpenStreetMap. That is an absence of data,
  not a step-free route."*

## Consequences

- Coverage figures are low and honestly so — driven by `surface` and
  `smoothness` alone, which is why a route tagged only with road classes
  reports 0% rather than a flattering number.
- The app frequently says it does not know. That is the product.
- It constrains everything downstream. The PWA's saved-route labelling, the
  `null` vs `[]` distinction for rest stops, and `synthetic_upstream` are all
  the same rule applied to different data.

## Alternatives rejected

**Default untagged to passable.** Rejected: it makes the app's one distinctive
claim a guess, and the person harmed is the person it was built for.

**Exclude untagged at the router.** The literal reading. Rejected: it returns
no route in most of the world, and a feature that never answers is not safer,
it is just absent.

**Confidence without three-valued logic** — score coverage but let the code use
booleans internally. Rejected after writing it: `if verdict:` is too easy, and a
comment does not stop it. `__bool__` raising does.
