# Meander API

Base path `/api`. JSON in, JSON out. No authentication, no cookies, no session.

Every error uses one envelope:

```json
{ "error": { "kind": "no_route", "message": "There is no route between those two points for this mode of travel." } }
```

`message` is written for a person and is safe to render verbatim. `kind` is for your code.

---

## `POST /api/routes`

### Request

```json
{
  "origin":      { "lat": 6.9271, "lon": 79.8612 },
  "destination": { "lat": 6.9497, "lon": 79.8500 },
  "minutes": 25,
  "mode": "auto",
  "depart_at": "2026-09-04T17:40:00Z",
  "objectives": ["fastest", "scenic", "accessible"]
}
```

| field | required | notes |
|---|---|---|
| `origin` | yes | `lat` −90…90, `lon` −180…180 |
| `destination` | no | **Omit entirely for a round-trip loop.** `null` is also accepted. |
| `minutes` | no | 20–360, default 35. The time budget, and the primary input. |
| `mode` | no | `auto` \| `foot` \| `bike` \| `car`. Default `auto`. |
| `depart_at` | no | ISO 8601. Used for sun position and air quality. |
| `objectives` | no | Up to three of `fastest` `scenic` `accessible` `quiet` `shade` `air`. Defaults to the first three. |

Unknown fields are rejected with `422` rather than ignored.

**`auto` mode ladder** — resolved server-side, and mirrored exactly by `deriveMode` in the frontend:

```
minutes <= 45          -> foot
45 < minutes <= 120    -> bike
minutes > 120          -> car
```

### Response `200`

```json
{
  "routes": [
    {
      "id": "fastest",
      "label": "Fastest",
      "status": "ok",
      "geometry": [[79.8612, 6.9271], [79.8615, 6.9280]],
      "duration_min": 18.0,
      "distance_m": 1450,
      "mode": "foot",
      "scores": { "scenic": 0.31, "air": 0.62, "shade": 0.20 },
      "scoring_method": "clip",
      "confidence": 0.88,
      "rest_stops": [{ "lat": 6.93, "lon": 79.86, "type": "bench", "at_m": 180 }],
      "blockers": [],
      "narration": null,
      "synthetic_upstream": false,
      "confidence_note": "Accessibility data covers 88% of this route.",
      "status_note": null
    }
  ],
  "best_departure": "2026-09-04T18:15:00Z",
  "reason": null,
  "cache": { "segments_scored": 14203, "hit_rate": 0.87 }
}
```

`geometry` is **GeoJSON `[lon, lat]`**. Feed it straight into a `LineString`; do not swap.

### The fields that decide whether a number can be trusted

| field | meaning |
|---|---|
| `scoring_method` | `clip` — real CLIP inference on street-level imagery. `geometry_only` — numpy scoring from route shape and elevation, no imagery. `placeholder` — **not a measurement.** Do not present as one. |
| `confidence` | Fraction of the route for which accessibility data actually exists, 0…1. |
| `confidence_note` | The same thing as a sentence, pre-written for display. Render it verbatim. |
| `synthetic_upstream` | `true` when the route was built from a hand-authored fixture rather than a real routing response. Implies `scoring_method: "placeholder"`. |

### `status: "blocked"` is a result, not an error

A blocked route still comes back `200`, still occupies its slot in `routes`, and the other routes
are unaffected. There are two shapes:

**Barriers found on a real route** — `geometry` is populated, `blockers` lists what is in the way.

```json
{ "id": "accessible", "status": "blocked", "geometry": [[...]],
  "blockers": [{ "type": "steps", "lat": 6.93, "lon": 79.86, "description": "3 steps, no ramp" }] }
```

**No such route exists** — `geometry` is `[]` and `status_note` explains why.

```json
{ "id": "accessible", "status": "blocked", "geometry": [], "blockers": [],
  "status_note": "There is no step-free route between those two points." }
```

If *no* route is `ok`, the response is still `200` and top-level `reason` explains it.

### Streaming

Send `Accept: text/event-stream` to receive routes as they are computed. Events:

```
data: {"type":"progress","pct":40,"text":"Scoring segments","segments_scored":812}

data: {"type":"route","route":{...}}

data: {"type":"done","payload":{"routes":[...],"cache":{...}}}
```

`narration` may be `null` on a route's first arrival and arrive again populated — **merge by `id`,
do not append.** Clients that do not ask for SSE get the whole document at once.

### Errors

**Every** error uses the `{"error": {"kind", "message"}}` envelope, including validation failures.
FastAPI's own `{"detail": [...]}` shape is normalised by an exception handler, so a client needs one
code path rather than one plus a special case for 422.

| status | `kind` | when |
|---|---|---|
| `413` | `payload_too_large` | Request body over 64 KB. |
| `422` | `invalid_request` | Validation failure. `message` is `"<field>: <reason>"`. |
| `422` | `no_route` | Nothing routable near the origin, or no connection between the points. |
| `429` | `per_ip` / `daily_ceiling` | Rate limited. `Retry-After` header is set, and is readable cross-origin. |
| `502` | `upstream` / `network` | The routing service failed or was unreachable. |
| `503` | `auth` / `budget` / `no_fixture` | The server is misconfigured or out of budget. Not the caller's fault, and the message says so. |

Over SSE the status line has already been sent, so an error arrives as an event instead:
`{"type": "error", "kind": ..., "message": ...}`. Two kinds only occur there — `internal` for an
unexpected server-side failure, and `shutting_down` when the instance is restarting mid-request.

### Rate limits

Per-IP token bucket (default 12 burst, refilling 3/min) plus a global daily ceiling (default 120
routed requests) held under the GraphHopper free-tier quota. **A cache hit is refunded** — it costs
no upstream credit, so it does not cost you a token. IP addresses are consumed by a salted digest
and never stored.

---

## `GET /api/geocode?q=<string>`

`q` is 2–120 characters. Debounce 300 ms client-side and abort in-flight requests.

```json
{ "results": [{ "name": "Colombo Fort, Colombo, Sri Lanka", "lat": 6.9344, "lon": 79.8428 }] }
```

Backed by Nominatim, not GraphHopper: it needs no key and spends nothing from the routing quota.

---

## `GET /api/health`

```json
{
  "status": "ok",
  "version": "0.1.0",
  "clip_available": false,
  "fixture_mode": "replay",
  "missing_keys": ["GRAPHHOPPER_KEY"],
  "cache": { "segments_scored": 0, "segments_clip": 0, "routes_cached": 3, "schema_version": 3 },
  "live_call_budget": { "graphhopper": { "cap": 80, "spent": 0, "remaining": 80 } },
  "fixtures": { "graphhopper": { "recorded": 0, "synthetic": 18 } },
  "counters": { "route_requests_total": 0, "unique_sessions_today": 0 },
  "rate_limit": { "per_ip_capacity": 12, "daily_ceiling": 120, "served_today": 0 }
}
```

`clip_available` is computed with `importlib.util.find_spec`, never by importing torch — the
deployed instance has 512 MB and importing torch would end it.

---

## `POST /api/report-barrier`

Reports an obstruction to **`api06.dev.openstreetmap.org`, the OpenStreetMap development server,
and never to production OSM.**

```json
{ "lat": 6.9344, "lon": 79.8428, "type": "steps", "description": "Four steps at the park entrance, no ramp." }
```

---

## Privacy

Nothing here is stored against a person. No cookies are set, no browser storage is used, and the
server keeps no location history. Coordinates, IP addresses and user agents are never written to a
log — `backend/logging_setup.py` redacts them as a backstop. Usage is counted as aggregates plus a
daily unique-session count derived from an in-memory digest keyed by a salt that is generated at
process start and never persisted.
