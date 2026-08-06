# 6 · No contraction hierarchies in the routing graph

**Accepted.** A small decision with a measurement behind it, recorded because
it looks like an obvious mistake and is not.

## Context

Contraction hierarchies are GraphHopper's standard speed-up, and turning them
off looks like leaving performance on the table.

## Decision

`ch.disable`, and no CH preparation at import.

## Consequences

CH is **incompatible with a custom model**, so it could only ever have served
`fastest` — one of three presets. Measured on the demo graph:

| | with CH | without |
|---|---|---|
| `fastest` route | 5.1 ms | 9.2 ms |
| graph on disk | +22% | — |
| import time | +40% | — |

Four milliseconds on one preset, against a request budget dominated by Overpass
at 13.6 s, in exchange for 22% of the image size that gets pulled on every task
replacement and 40% of an import that already takes 71 s.

It also removed a whole class of confusion: CH prepared but disabled per-request
produced `algorithm=round_trip cannot be used with CH`, and the fix had to be
conditional on which server was answering because the hosted API charges for
flexible mode. With no CH at all, there is one code path.

## Alternatives rejected

**CH for `fastest`, flexible for the rest.** What the first version did. It is
where the round-trip error came from, and it makes the request body depend on
both the preset and the server — which is also what a fixture signature is keyed
on, so it doubled the fixture set for 4 ms.

**Landmarks (A*, `prepare.lm`) instead.** Kept, in fact — landmarks are prepared
and do work with custom models. This ADR is only about CH.
