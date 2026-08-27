# Runbook

What to do when something is wrong, written for somebody who did not build it.

The deployment this covers is the one that exists: the app on Cloudflare Pages
(`meander-eoc.pages.dev`, built from `main` by the GitHub integration) and the
API plus the router on one VM (`meander-app.duckdns.org`), three containers
under `docker compose` behind Caddy: `api`, `graphhopper`, `caddy`.

> This file used to describe the AWS deployment that `infra/` would have
> created — ECS services, CloudWatch alarms, security groups. None of that was
> ever applied, and it has been removed from the repository. Where a symptom's
> cause below is a guess rather than something that has been observed, it still
> says so.

## First, three commands

```bash
SITE=https://meander-app.duckdns.org

curl -s $SITE/healthz                                  # is it alive
ssh <the-vm> 'curl -s 127.0.0.1:8000/api/health | jq'  # is it configured correctly
ssh <the-vm> 'docker compose -f ~/Meander/docker-compose.yml -f ~/Meander/compose.prod.yml logs --since 15m api'
```

`/api/health` is the one that answers most questions — the routing backend,
whether custom models can run, which path details are being requested, the
cache contents and which keys are missing. It is deliberately **not** public:
the Caddyfile allowlists exactly `/api/routes`, `/api/geocode`,
`/api/report-barrier`, `/api/photos`, `/api/photo/*` and `/healthz`, and
default-denies the rest, because `/api/health` publishes the router's internal
URL and key-presence booleans. Read it from the VM.

---

## Routing is down

**Every route request is failing while the site looks fine.** The router has no
public surface — Caddy never proxies to it, and only the `api` container can
reach `graphhopper:8989` on the compose network — so nothing outside notices
except `/api/routes` failing.

```bash
docker compose -f docker-compose.yml -f compose.prod.yml ps
docker compose -f docker-compose.yml -f compose.prod.yml logs --since 30m graphhopper
```

Most likely causes, in the order they have actually bitten during development:

| what you see in the log | what it is |
|---|---|
| `OutOfMemoryError` after a long start | `GH_HEAP` too close to the container's memory limit. The JVM needs headroom above `-Xmx` for metaspace and the direct buffers the graph is mapped through. 3g against 4 GiB is the tested pair. |
| `No graph, and no GRAPH_S3_URI` | the image was built with `GRAPH_SOURCE=none` and no fetch URI. This image never imports — stage a graph with `scripts/publish_graph.sh --local` and rebuild, or point `GRAPH_S3_URI` at a published archive. |
| `GRAPH DIGEST MISMATCH` | the fetched archive is corrupt. It refuses to unpack rather than serving a half-graph that dies later on an opaque error. |
| the container starts and is killed minutes in | the health check's start period is shorter than the graph load. A much larger graph needs a longer one. |

Restarting it: `docker compose -f docker-compose.yml -f compose.prod.yml restart graphhopper`.
There is one router, so this is a brief total outage of routing by design.

## The API is failing `/readyz`

`/readyz` goes 503 when the instance cannot reach the router — so it usually
means the router is the thing to fix, above. If the router is healthy and
`/readyz` still fails, the compose network is the suspect: both services must
be on it, and the API reaches the router by the service name `graphhopper`.

## 5xx from the API

**This should be close to impossible, and that is why it is worth attention.**
The application degrades rather than failing: a dead Overpass, a dead
Open-Meteo, a failed scoring pass and a failed accessibility assessment all
produce a `200` with null fields and a smaller claim. If 5xx is climbing, the
failure is *not* an upstream — look at the API log for a traceback.

## Slow requests

Routing is ~24 ms and Overpass's tail is 13.6 s, so anything past ~15 s at p95
is outside the shape of a normal slow request (a local load test at 10
concurrent gave p50 3.48 s and p95 5.36 s). Almost always Overpass. Check
before assuming it is you:

```bash
time curl -s -X POST https://overpass-api.de/api/interpreter \
  --data 'data=[out:json][timeout:10];node(51.50,-0.17,51.51,-0.16);out 1;'
```

Rest stops coming back `null` is the correct degradation for this, not a bug —
`null` means "we could not look", which the response distinguishes from `[]`.

---

## Symptoms that are not alarms

### Every route says `scoring_method: "geometry_only"`

The pre-warmed CLIP scores are not being read.

```bash
curl -s 127.0.0.1:8000/api/health | jq .cache      # segments_scored should be 146
```

If it is 0, the overwhelmingly likely cause is that `MEANDER_CACHE_DB` has been
set in the environment. It points the API away from the `data/cache.db` baked
into the image, and **nothing looks broken** — every route quietly drops to
geometry scoring and says so, correctly, in a field nobody reads. Phase K found
exactly this in `render.yaml`. Leave it unset.

### The accessible route stops rejecting bad surfaces

The most dangerous silent failure in the system: the app would report a route
as step-free that it has not actually checked.

```bash
curl -s 127.0.0.1:8000/api/health | jq '.routing | {self_hosted, self_hosted_source, path_details}'
```

`self_hosted` must be `true`, `self_hosted_source` must be `"env"`, and
`path_details` must contain `"smoothness"`. If `self_hosted_source` is
`"sniff"`, `MEANDER_GRAPHHOPPER_SELF_HOSTED` is missing from the environment
and the hostname heuristic has guessed. `path_details` then drops `smoothness`,
and the accessible custom model silently stops excluding impassable surfaces.
`compose.prod.yml` sets it; keep it set.

### Everyone is being rate limited at once

`MEANDER_TRUSTED_PROXY_HOPS` is wrong. The limiter reads `X-Forwarded-For`
from the right; behind Caddy alone the value is **1**, which is what
`compose.prod.yml` sets. At 0 every request resolves to Caddy's own address
and shares one bucket; at 2 the limiter trusts a hop that does not exist and a
client can spoof its way out of the bucket.

```bash
# From two different networks — a phone on mobile data is the easiest second one.
for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' -X POST $SITE/api/routes \
  -H 'content-type: application/json' \
  -d '{"origin":{"lat":51.5,"lon":-0.16},"minutes":35,"mode":"auto","objectives":["fastest"]}'; done
```

### The app opens blank, or offline into an old version

The service worker is serving a stale shell. `sw.js` must never be cached long:
`frontend/public/_headers` serves it `max-age=0, must-revalidate`, and that
file is what Cloudflare Pages applies.

```bash
curl -sI https://meander-eoc.pages.dev/sw.js | grep -i cache-control
```

A user already holding the stale worker recovers on the next load, because the
worker is network-first for navigations. To force it, ship any asset change:
the worker's version is a hash of its own source plus the precache list, so the
old shell cache is dropped on activate.

### A saved route shows the wrong age, or no age

`lib/offline.js` treats an unknown age as the *loudest* tier, never the
quietest, so "no age" should be impossible — `npm run check:offline` asserts
there is no input for which the label is absent. If it happens anyway, the
stamp is not reaching the client: check that the replayed response still
carries `X-Meander-Cached`.

---

## Deploying the API on the VM, and the two ways it lies to you

```bash
cd ~/Meander
git status --short && git log --oneline -1     # <- do not skip this line
git reset --hard origin/main                   # only if the line above was not clean
docker compose -f docker-compose.yml -f compose.prod.yml build api
docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate api
```

**`build` before `up`, always.** `--force-recreate` replaces the container, not
the image, and the backend is baked into the image rather than mounted. On its
own it restarts the old code, healthily, and reports success. BLOCKED.md §7 has
the session where that cost an afternoon.

**Check `git status` before you build, and check `HEAD` is what you mean to
ship.** On 2026-08-26 this checkout was found with `HEAD` at `origin/main` and
its *working tree* four commits behind, 33 files staged as a wholesale revert.
Nothing reports that: `git log`, `git branch` and the status branch line all
read correctly, because only the files were wrong. `git checkout <old> -- .`
produces it, and `docker compose build` would have shipped it without a murmur.
The image is built from this directory and nothing in the deploy path compares
it to `HEAD`.

**Recreate `caddy` only if `Caddyfile` changed** — and if it did, you must,
because the file is a single-file bind mount. That binds the *inode*: `git pull`
writes a new file and renames it over the old one, so the container keeps the
one it started with and `caddy reload` cheerfully re-reads the config it already
had. Recreating the container re-resolves the path.

Then verify **over the wire**, never on an exit code:

```bash
curl -s https://meander-app.duckdns.org/healthz
curl -s -X POST https://meander-app.duckdns.org/api/routes \
  -H 'Content-Type: application/json' -H 'Origin: https://meander-eoc.pages.dev' \
  -d '{"origin":{"lat":51.5074,"lon":-0.1657},"minutes":35,"mode":"foot"}' | head -c 400
```

and for the app, `node frontend/scripts/live-gate.mjs`, which is the only thing
here that checks CORS, the CSP, the service worker and the offline open — none
of which curl can see. 28 passed / 0 failed is the current baseline.

## Rolling back

The image is built from the checkout, so a rollback is a checkout of the
commit you were on, rebuilt:

```bash
cd ~/Meander
git log --oneline -5                       # find the SHA that was good
git reset --hard <good-sha>
docker compose -f docker-compose.yml -f compose.prod.yml build api
docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate api
git reset --hard origin/main               # afterwards, so the checkout is not left lying
```

The frontend rolls back from the Cloudflare Pages dashboard — every deployment
is kept and any previous one can be re-promoted to production — or by
reverting the commit on `main`, which redeploys.

## What this runbook cannot tell you

- What normal traffic looks like. Every threshold here comes from a single
  local measurement or from the request-path timings in PROGRESS.md, not from
  a week of production data. They are starting points to be re-sized.
