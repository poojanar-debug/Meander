# Meander API

Base path `/api`. JSON in, JSON out — with one deliberate exception, `GET /api/photo/{ref}`, which
streams image bytes. No authentication, no cookies, no session.

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
| `minutes` | no | 20–360, default 35. The time budget, and the primary input **for a loop**. It has a default, so it is always populated; read `budget_minutes()`, which is `None` when there is a destination. The client omits it entirely from a point-to-point body, and the plan surfaces hide the dial rather than show one that changes nothing. |
| `mode` | no | `auto` \| `foot` \| `bike` \| `car`. Default `auto`. |
| `depart_at` | no | ISO 8601. Used for sun position and air quality. |
| `objectives` | no | Up to three of `fastest` `scenic` `accessible` `quiet` `shade` `air`. Defaults to the first three. `nature` is accepted as a retired alias for `scenic` and is never emitted. |

Unknown fields are rejected with `422` rather than ignored.

**What each objective optimises**

| id | label | what it asks the router for |
|---|---|---|
| `fastest` | Fastest | Shortest time. No custom model. The control every other preset is measured against. |
| `scenic` | Scenic | Maximum visual appeal, capped at 1.6× the fastest duration and required to beat it. Several candidates are routed and the best is kept. |
| `accessible` | Accessible | Hard accessibility constraints first. **May return `status: "blocked"`** rather than a route. |
| `quiet` | Quiet | Away from motor traffic, and off cobblestones. Unlike `scenic` it penalises ordinary residential streets, and unlike `scenic` it has no preference for an unsealed surface. |
| `shade` | Shade | The kinds of way that tend to be shaded, and never a bridge deck. |
| `air` | Clean air | Away from motor traffic, and **out of tunnels**, which is where it and `shade` pull hardest in opposite directions. |

The last three are **preferences inferred from OpenStreetMap way tags**, not
measurements of noise, canopy or pollution — none of the three exists in OSM in
a form a router can steer on. Every route from one of them carries a
`status_note` saying so in a sentence, on `status: "ok"` as well as on blocked
routes. See [adr/0007](adr/0007-preference-presets-are-proxies.md).

Every preset except `fastest` sends a `custom_model`, which needs GraphHopper's
flexible mode. On a free hosted package all five come back
`status: "blocked"` with that reason; self-hosting is what makes them real.

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
      "scores": { "scenic": 0.31, "air": 0.62, "shade": 0.20, "quiet": 0.55 },
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
| `scores.*` | `scenic`, `air`, `shade` and `quiet`, each **`null` when it was not computed**. Null is not zero: zero shade is a claim about a place, "we did not measure this" is not. Render null as "not measured". Every score is reported on every route whatever objective produced it, so the comparison across the rail is the reader's to make. |
| `status_note` | Present on blocked routes, and on `ok` routes from `quiet`, `shade` and `air`, where it states what the objective was inferred from. Render it verbatim. |

`scores.shade` is the only one that combines a request-level figure with a
route-level one: how much shade the hour calls for (sun elevation against cloud
cover, at the midpoint) against how much cover the route's own tags suggest.
At night and under closed cloud it is 1.0 on every route, because nobody is
short of shade at midnight.

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

`q` is 2–120 characters. Debounce 500 ms client-side and abort in-flight requests. It was 300 ms,
which sits exactly on the median inter-keystroke gap of a 40 wpm typist and made the cost of a name
knife-edge bimodal — see `PlaceInput.jsx`'s header for the measurement and the incident.

```json
{ "results": [{ "name": "Colombo Fort, Colombo, Sri Lanka", "lat": 6.9344, "lon": 79.8428 }] }
```

Backed by Nominatim, not GraphHopper: it needs no key and spends nothing from the routing quota.

Answers are cached server-side for **one day**, and answers that found nothing for **ten minutes**.
The two are different questions: how long a coordinate stays right is bounded by how often OSM
*moves* a place, and how long "nowhere is called that" stays right is bounded by how often OSM
*gains* one. `MEANDER_GEOCODE_CACHE_TTL_S` and `MEANDER_GEOCODE_EMPTY_CACHE_TTL_S` shorten either.

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

## `POST /api/photos`

Photographs along one route, chosen for what that route was optimised for. A second call rather
than part of `/api/routes`: the photographs come from two hosts neither the router nor the
enrichment path touches, and folding them in would put an unrelated upstream between the user and
the thing they actually asked for. It also means the frontend asks about the one route the user
picked instead of all three.

```json
{
  "geometry": [[4.8686, 52.3579], [4.8701, 52.3588]],
  "objective": "scenic",
  "blockers": []
}
```

`geometry` is `[[lon, lat], …]` — GeoJSON order, exactly as `Route.geometry` carries it, so a route
can be passed straight through. Two points minimum, 800 maximum; thin the line before sending it.
`blockers` is passed through from `Route.blockers` and is only used by the `accessible` hero.

```json
{
  "hero": {
    "id": "…",
    "url": "/api/photo/<ref>",
    "source": "wikimedia_commons",
    "lat": 52.3579, "lon": 4.8686, "at_m": 812.0,
    "width": 640, "height": 480,
    "title": "Vondelpark", "licence": "CC BY-SA 3.0",
    "licence_url": "https://creativecommons.org/licenses/by-sa/3.0",
    "author": "…", "attribution": "…",
    "source_page": "https://commons.wikimedia.org/wiki/File:…",
    "captured_at": "2019-06-04T10:12:00Z"
  },
  "strip": [],
  "hero_basis": "most_photographed",
  "hero_reason": "The most photographed place along this route, according to Wikimedia Commons.",
  "objective_measured": false,
  "sources_used": ["wikimedia_commons"],
  "mapillary_enabled": false,
  "note": "This is the most photographed place near the route, not the prettiest part of it. …"
}
```

**`url` is a path on this service, never an upstream URL.** That is the point of the endpoint — see
Privacy below. A split deployment has to put the API base back on it.

### `objective_measured` is the field that decides whether the hero means anything

`hero_basis` is one of `first_barrier`, `midpoint`, `most_photographed`, `sampled` or `none`, and
`objective_measured` is true for exactly the first two.

| objective | anchor | measured? |
|---|---|---|
| `accessible` | the first barrier on the route, off `Route.blockers` | **yes** |
| `fastest` | the midpoint, which is arithmetic | **yes** |
| `scenic` `shade` `quiet` `air` | the most-photographed nearby place, or an evenly spaced one | **no** |

The four unmeasured ones are not an oversight and cannot be fixed here. Those scores reach the wire
as one aggregate number for the whole route; the per-way tag spans they are computed from are
consumed inside the backend and never leave it. There is no greenest point, no shadiest point and
no quietest point on a `Route` to choose from, so the response says so in `note` and sets
`objective_measured: false` rather than inventing one. **Do not render a hero as "the greenest
point" when this is false.**

`hero_reason` is a full sentence, rendered verbatim as the caption. `note` is null when there is
nothing worth saying; when a deployment has no `MAPILLARY_TOKEN` and nothing more important is
being said, it explains that the photographs are Commons-only.

Rate-limited on the **routing** bucket rather than one of its own, and not counted against the
daily route ceiling: one photo request follows one route selection, so it has the same natural rate
as a route request. `/api/photo/{ref}` below does not, and has its own.

### It never returns an error envelope

Every upstream call degrades. Offline, slow, rate-limited upstream, no results: the answer is a
null `hero`, an empty `strip`, and `sources_used: []` if nobody answered at all — which is a
different statement from both sources answering with nothing. A page that has already drawn a route
must not acquire an error box because a photo host was slow.

Licences are required, not best-effort: `Photo.licence` has no default, and a photograph whose
licence could not be determined is dropped rather than shown uncredited. `attribution` is assembled
server-side and is meant to be rendered verbatim, not reassembled.

---

## `GET /api/photo/{ref}`

Streams one upstream image, so the image host never sees the user. `ref` is the opaque signed
reference carried in `Photo.url`; it is not a URL and cannot be constructed by hand.

Returns the image bytes with `Cache-Control: public, max-age=86400, immutable` — honest rather than
optimistic, because the reference pins one exact upstream URL — plus `X-Content-Type-Options: nosniff`
and `Content-Disposition: inline`. Only `image/jpeg`, `image/png`, `image/webp`, `image/gif` and
`image/avif` are passed through; anything else is refused, because a proxy that serves an arbitrary
content type from this API's own origin is an XSS vector.

Anything that is not a valid reference to one of exactly two allowed hosts gets the same answer
whatever the reason. `backend/photos.py` documents why all three of the signature, the host
allowlist and the size cap are needed rather than any one of them, and why the shared client runs
with `follow_redirects=False` here in particular: a redirect is the standard way an allowlisted host
is turned into a request to somewhere else.

**Its own token bucket** (default 60 burst, refilling 60/min), separate from the routing one and
never counted against the daily route ceiling. One route view asks for up to six images and the
route bucket holds twelve requests in total, so sharing it would leave nothing for the second route
a user looks at. An image is not a route.

On a deployment running more than one worker, `MEANDER_PHOTO_SIGNING_KEY` must be set, or each
worker mints references the others reject and roughly `(n-1)/n` of image loads 404 at random.

---

## Privacy

Nothing here is stored against a person. No cookies are set, no browser storage is used, and the
server keeps no location history. Coordinates, IP addresses and user agents are never written to a
log — `backend/logging_setup.py` redacts them as a backstop. Usage is counted as aggregates plus a
daily unique-session count derived from an in-memory digest keyed by a salt that is generated at
process start and never persisted.

**Photographs are proxied for exactly this reason.** A route is a person's Tuesday afternoon, and
asking a browser to fetch a thumbnail hands Wikimedia and Mapillary an IP address alongside
coordinates describing where that person is about to walk. `/api/photos` therefore returns URLs on
this service and `/api/photo/{ref}` streams the bytes, so the image hosts see this server and never
a user. The alternative — returning upstream URLs and naming the hosts in the frontend's
Content-Security-Policy — was rejected twice over: it reintroduces the disclosure the proxy exists
to prevent, and Mapillary's thumbnails come from rotating `scontent-*.xx.fbcdn.net` hostnames that a
strict policy cannot enumerate at all.

One thing this API does **not** control: the map. The default and green-cover basemaps fetch no
tiles while a user is walking, and the satellite basemap fetches one for every stretch covered,
direct from `server.arcgisonline.com`. That is a frontend choice, it is stated in the UI at the
moment of choosing and again on the follow screen, and no tile is ever cached — but it is not
proxied and this server is not in that path.
