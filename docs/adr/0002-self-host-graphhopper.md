# 2 · Self-host GraphHopper rather than use the hosted API

**Accepted.** Recorded in PROGRESS.md under "Self-hosted GraphHopper".

## Context

Two of the three presets need a `custom_model`, and the hosted free tier
cannot execute one — it answers "Free packages cannot use flexible mode". So
`nature` and `accessible` came back blocked, and the app had one working
preset out of three.

## Decision

Run GraphHopper 11 in a container with a graph built from Geofabrik extracts.

## Consequences

Measured rather than assumed:

- **All three presets route.** Verified at four points across three regions.
- **A foot route takes 24 ms**, against ~4 s for the hosted API. Routing stopped
  being the bottleneck entirely; the request budget is now Overpass at 13.6 s.
- **`smoothness` became available**, which the hosted API never exposed. It is
  one of the five hard accessibility constraints, and until self-hosting that
  constraint could not fire from routing data at all. This was not a goal — it
  was found by running it.
- No API quota, no per-request cost, no key in the request path.

The costs are real:

- **The graph is the deployment.** 485 MB for the demo region set, 6.6 GB for
  three whole countries with a 20 GB import heap. It cannot be built in CI.
- A 1.2 GB image to pull on every task replacement.
- ~$29/month of Fargate for a process that is idle almost all the time.
- Four of the six defects found while building it were configuration
  (`ch.disable` on every request, `surface == EARTH`, `ignored_highways`
  dropping `steps`, an 8 GB heap against a 6.6 GB graph). None was detectable
  by reading; each needed a real run.

The `ignored_highways` one is worth singling out: GraphHopper's own example
config excludes `footway`, `cycleway`, `path` and **`steps`**. Correct for a
car server, catastrophic here — if steps are never imported the graph cannot
contain them, the hard check can never fire, and the app would confidently
report a staircase as step-free.

## Alternatives rejected

**Pay for the hosted flexible tier.** Rejected: a per-request cost on the
project's core feature, and it still would not have provided `smoothness`.

**Two presets only.** Rejected: `accessible` is the reason the project exists.

**Precompute routes.** Rejected: the input is an arbitrary origin and a time
budget, so there is nothing bounded to precompute.
