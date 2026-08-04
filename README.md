# Meander

**Give it where you are and how long you have. It gives you three routes back.**

| id | label | what it optimises |
|---|---|---|
| `fastest` | Fastest | Shortest time. The control. |
| `nature` | Nature | Maximum greenery, capped at 1.6× the fastest duration. |
| `accessible` | Accessible | Hard accessibility constraints first, then greenery within them. May return no route at all. |

One dial, 20–360 minutes. No destination means a round trip from where you started.

---

## Why

Time in nature is now prescribed clinically — roughly two hours a week, in sessions of twenty
minutes or more. Nothing tells you *where to go* given the time, the transport and the body you
actually have today.

And people with mobility impairments are routinely routed down flights of steps. Meander treats a
blocked route as a first-class answer: it will tell you it cannot get you there rather than
inventing a path you cannot use.

**The rule this project is built around: a missing OpenStreetMap tag means `UNKNOWN`, never
"accessible".** A false step-free claim can strand a real person. Everything else here is
negotiable; that is not.

---

## Status

Under construction. See [PROGRESS.md](PROGRESS.md) for what works today and
[BLOCKED.md](BLOCKED.md) for what does not.

---

## Architecture

```
                        ┌──────────────────────────────┐
   browser              │  frontend/  Vite + React     │
                        │  MapLibre GL + OpenFreeMap   │
                        └──────────────┬───────────────┘
                                       │  POST /api/routes  (SSE)
                        ┌──────────────▼───────────────┐
                        │  backend/main.py   FastAPI   │
                        │  rate limit · CORS · SSE     │
                        └──┬────────┬────────┬─────────┘
                           │        │        │
              routing.py ──┘        │        └── enrich.py ── Overpass
              (GraphHopper)         │                        Open-Meteo (+AQ)
                                    │
                    accessibility.py│  geometry.py   scoring.py
                    hard constraints│  numpy only    CLIP  [torch, local only]
                                    │
                        ┌───────────▼──────────────────┐
                        │  cache.py  →  data/cache.db  │
                        │  segment scores · route cache│
                        └──────────────────────────────┘

   ALL network egress passes through fixtures.py — record/replay + hard live-call caps.
```

### The split that makes it deployable

CLIP needs 2–3 GB of RAM. The Render free tier has 512 MB. So scoring is split in two:

| local (`requirements.txt`) | deployed (`requirements-deploy.txt`) |
|---|---|
| `batch_score.py` pulls Mapillary imagery | FastAPI reads the committed `data/cache.db` |
| CLIP ViT-B-32 scores each segment | numpy-only `geometry.py` scores the rest |
| writes `data/cache.db` | **no torch, no open-clip-torch** |

Cached regions get real CLIP scores. Everywhere else falls back to geometry with lower confidence.
**Every route states which path produced its numbers** in `scoring_method`.

---

## Setup from a clean clone

Requires Python 3.11+ and Node 18+.

```bash
git clone https://github.com/<you>/meander.git && cd meander
```

### Backend

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt
```

```bash
cp .env.example .env
```

Fill in `GRAPHHOPPER_KEY` for live routing. Everything runs from recorded fixtures without it —
that is the default (`MEANDER_FIXTURES=replay`).

```bash
uvicorn backend.main:app --reload --port 8000
```

```bash
curl -s localhost:8000/api/health | python3 -m json.tool
```

### Frontend

```bash
cd frontend && npm install && npm run dev
```

Open http://localhost:5173. To run the UI with no backend at all:

```bash
VITE_MOCK_API=1 npm run dev
```

### Tests

```bash
python3 -m pytest backend/tests -q
```

The suite runs entirely offline. It never opens a socket.

---

## API

`POST /api/routes` · `GET /api/geocode?q=` · `GET /api/health` · `POST /api/report-barrier`

Full contract, including the streaming shape and the blocked-route cases: [docs/API.md](docs/API.md).

---

## Privacy

Stateless by design. No location history, no cookies, no third-party analytics, no browser
storage. Coordinates, IP addresses and user agents are never logged or persisted — there is a
filter in `backend/logging_setup.py` that redacts them as a backstop.

Usage is counted as aggregates only (`route_requests_total`, `routes_blocked_total`,
`cache_hits_total`, `segments_scored_total`) plus a daily unique-session count derived from an
in-memory digest keyed by a salt generated at process start and never written anywhere.

---

## Limitations

A full, honest limitations section lands once the data pipeline is validated. While the project is
in progress, the short version:

- Accessibility answers are only as good as OpenStreetMap tagging in your area, and coverage is
  uneven. The response always tells you what fraction of a route was actually verified.
- Scenery scoring only exists where Mapillary has street-level imagery. Elsewhere the app falls
  back to route geometry, and says so.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence and attribution

MIT — see [LICENSE](LICENSE).

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
- Basemap tiles by [OpenFreeMap](https://openfreemap.org/).
- Street-level imagery from [Mapillary](https://www.mapillary.com/), CC BY-SA 4.0.
- Weather and air quality from [Open-Meteo](https://open-meteo.com/), CC BY 4.0.
- Routing by [GraphHopper](https://www.graphhopper.com/).
