# Runbook

What to do when something is wrong, written for somebody who did not build it.

> **Nothing is deployed.** This describes the deployment `infra/` would create.
> Every command is written to be runnable, and none has been run against a real
> environment. Where a symptom's cause is a guess rather than something that has
> been observed, it says so.

## First, three commands

```bash
SITE=https://your-distribution.cloudfront.net

curl -s $SITE/api/healthz                       # is it alive
curl -s $SITE/api/health | jq                   # is it configured correctly
curl -s $SITE/api/metrics 2>/dev/null || \
  aws logs tail /ecs/meander/api --since 15m    # what has it been doing
```

`/api/health` is the one that answers most questions. It reports the routing
backend, whether custom models can run, which path details are being requested,
the fixture mode, the cache contents and which keys are missing.

---

## The alarms

### `meander-router-not-running`

**Every route request is failing.** The router has no load balancer and no
public surface, so nothing outside the VPC notices — the API keeps answering
and the site looks up.

```bash
aws ecs describe-services --cluster meander --services meander-graphhopper \
  --query 'services[0].{desired:desiredCount,running:runningCount,events:events[:5]}'
aws logs tail /ecs/meander/graphhopper --since 30m
```

Most likely causes, in the order they have actually bitten during development:

| what you see in the log | what it is |
|---|---|
| `OutOfMemoryError` after a long start | `GH_HEAP` too close to the task memory. The JVM needs headroom above `-Xmx` for metaspace and the direct buffers the graph is mapped through. 3g against 4096 MiB is the tested pair. |
| `No graph, and no GRAPH_S3_URI` | the image was built with `GRAPH_SOURCE=none` and no fetch URI. See infra/README.md — this image never imports. |
| `GRAPH DIGEST MISMATCH` | the S3 archive is corrupt. It refuses to unpack rather than serving a half-graph that dies later on an opaque error. |
| the task starts and is killed ~3 min in | the health check's `StartPeriod` is shorter than the graph load. It is 180 s; a much larger graph needs more. |

Rolling it: `aws ecs update-service --cluster meander --service meander-graphhopper --force-new-deployment`.
There is one task, so this is a brief total outage of routing by design.

### `meander-api-unhealthy-hosts`

A task is failing `/readyz` and is out of the pool. `/readyz` goes 503 when the
instance cannot reach the router — so this alarm and the one above usually fire
together, and the router is the thing to fix.

If `/readyz` is failing while the router is healthy, it is almost certainly the
security group: the router admits only the API's security group on 8989.

```bash
aws ec2 describe-security-groups --filters Name=group-name,Values=meander-router \
  --query 'SecurityGroups[0].IpPermissions'
```

### `meander-api-5xx`

**This should be close to impossible, and that is why the threshold is low.**
The application degrades rather than failing: a dead Overpass, a dead
Open-Meteo, a failed scoring pass and a failed accessibility assessment all
produce a `200` with null fields and a smaller claim. If 5xx is climbing, the
failure is *not* an upstream — look at the API log for a traceback.

### `meander-api-latency-p95`

p95 above 15 s. Sized from measurement rather than a round number: routing is
24 ms and Overpass's tail is 13.6 s, so this is past the shape of a normal slow
request. A local load test at 10 concurrent gave p50 3.48 s and p95 5.36 s.

Almost always Overpass. Check before assuming it is you:

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
curl -s $SITE/api/health | jq .cache      # segments_scored should be 146
```

If it is 0, the overwhelmingly likely cause is that `MEANDER_CACHE_DB` has been
set in the task definition. It points the API away from the `data/cache.db`
baked into the image, and **nothing looks broken** — every route quietly drops
to geometry scoring and says so, correctly, in a field nobody reads. Phase K
found exactly this in `render.yaml`. It is deliberately unset in
`infra/20-services.yaml`; leave it unset.

### The accessible route stops rejecting bad surfaces

The most dangerous silent failure in the system: the app would report a route
as step-free that it has not actually checked.

```bash
curl -s $SITE/api/health | jq '.routing | {self_hosted, self_hosted_source, path_details}'
```

`self_hosted` must be `true`, `self_hosted_source` must be `"env"`, and
`path_details` must contain `"smoothness"`. If `self_hosted_source` is
`"sniff"`, `MEANDER_GRAPHHOPPER_SELF_HOSTED` is missing from the task
definition and the hostname heuristic has guessed — and it guesses wrong for a
Cloud Map name. `path_details` then drops `smoothness`, and the accessible
custom model silently stops excluding impassable surfaces.

### Everyone is being rate limited at once

`MEANDER_TRUSTED_PROXY_HOPS` is wrong. The limiter reads `X-Forwarded-For` from
the right; behind CloudFront *and* an ALB the header is `viewer, cloudfront`, so
the value is **2**. At 1 every request in the world resolves to one CloudFront
edge address and shares one bucket.

```bash
# From two different networks — a phone on mobile data is the easiest second one.
for i in $(seq 1 20); do curl -s -o /dev/null -w '%{http_code} ' -X POST $SITE/api/routes \
  -H 'content-type: application/json' \
  -d '{"origin":{"lat":51.5,"lon":-0.16},"minutes":35,"mode":"auto","objectives":["fastest"]}'; done
```

### The app opens blank, or offline into an old version

The service worker is serving a stale shell. `sw.js` must not be edge-cached —
its cache behaviour in `infra/30-web.yaml` is CachingDisabled and S3 serves it
with `max-age=0, must-revalidate`.

```bash
curl -sI $SITE/sw.js | grep -i cache-control
```

A user already holding the stale worker recovers on the next load, because the
worker is network-first for navigations. To force it, bump the deploy: the
worker's version is a hash of its own source plus the precache list, so any
asset change rotates it and the old shell cache is dropped on activate.

### A saved route shows the wrong age, or no age

`lib/offline.js` treats an unknown age as the *loudest* tier, never the
quietest, so "no age" should be impossible — `npm run check:offline` asserts
there is no input for which the label is absent. If it happens anyway, the
stamp is not reaching the client: check that the service worker's replayed
response still carries `X-Meander-Cached-At`.

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

Images are tagged with the commit SHA and the ECR repositories are
IMMUTABLE-tagged, so a rollback is a task definition, not a rebuild.

```bash
aws ecs describe-task-definition --task-definition meander-api \
  --query 'taskDefinition.revision'
aws ecs update-service --cluster meander --service meander-api \
  --task-definition meander-api:<previous> 
aws ecs wait services-stable --cluster meander --services meander-api
```

The API service has a deployment circuit breaker with rollback enabled, so a
task definition that cannot pass its health check reverts on its own. The router
service does **not** — it runs a single task with `MinimumHealthyPercent: 0`,
so a bad router image is a manual rollback and an outage until it is done.

The frontend rolls back by re-syncing a previous build; the bucket is versioned
with a 30-day non-current expiry.

## What this runbook cannot tell you

- Whether any of it works. None of these commands has been run against a real
  deployment, because there is not one. Where a cause is listed it is either
  something observed during development on a laptop, in Docker or in the test
  suite, or it is reasoning from the code — and the table above says which.
- What normal traffic looks like. Every threshold here comes from a single
  local measurement or from the request-path timings in PROGRESS.md, not from
  production. They are starting points to be re-sized once there is a week of
  real data.
