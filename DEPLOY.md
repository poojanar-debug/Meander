# Deploying Meander

Four CloudFormation stacks on AWS: ECS Fargate for the API and the router,
CloudFront and S3 for the app, all in one distribution so the browser makes no
cross-origin request.

> ## This has never been run.
>
> Every template validates and `cfn-lint` passes on all four, and **nothing has
> been deployed**. The commands below are written to be followed without
> guessing, and none of them has been executed against a real AWS account. The
> gate table in [`infra/README.md`](infra/README.md) lists all seventeen things
> that would have to be checked afterwards and marks every one UNVERIFIED.
>
> What *has* been verified end to end is the same stack under `docker compose`:
> both images build, both containers reach healthy, and `POST /api/routes`
> returns real routes with real CLIP scores.

> ## Meanwhile, something else is actually serving traffic.
>
> **This document is about the AWS path, which is unbuilt. It is not the
> deployment people are using.** That one is:
>
> | | where | how it ships |
> |---|---|---|
> | the app | `meander-eoc.pages.dev` | Cloudflare Pages, built from `main` by the GitHub integration — merging to `main` deploys it |
> | the API and the router | `meander-app.duckdns.org` | one VM, `docker compose` behind Caddy: `api`, `graphhopper`, `caddy` |
>
> Its procedure lives in [`docs/RUNBOOK.md`](docs/RUNBOOK.md) under "Deploying
> the API on the VM", because it is an operational routine rather than a
> first-time build. Read it before running anything against that box: two of its
> commands report success while changing nothing, and a third would have shipped
> a four-commit-old backend from a checkout whose `git log` read correctly.
>
> The sections below on **CORS**, **preview deployments** and **rolling back**
> apply to both topologies and are the ones worth reading either way.

The old two-host deployment — Render for the API, Vercel for the frontend — is
in [`docs/legacy/`](docs/legacy/) with its own notes. It worked and it was
never deployed either.

---

## Before you start

| | where | free? |
|---|---|---|
| An AWS account | https://aws.amazon.com | the resources below are **not** free — about $108/month, itemised in [`infra/README.md`](infra/README.md) |
| Mapillary client token | https://www.mapillary.com/dashboard/developers | yes |
| Anthropic API key | https://console.anthropic.com/ | **no — costs real money per call** |
| GraphHopper API key | https://www.graphhopper.com/ | yes, and **not needed** — you are running your own router |

**None of the three keys is required to serve a route.** `ANTHROPIC_API_KEY` is
read only by narration, and `GRAPHHOPPER_KEY` only if you point at the hosted
API instead of your own router. `/api/health` reports which are missing. Without
Anthropic, `narration` stays `null` and the card reads "Description still being
written…" — which is why that copy exists.

**`MAPILLARY_TOKEN` now has two readers, and this paragraph used to name only
one.** `backend/scoring.py` reads it for the offline CLIP batch job, which is
the only way new scenery scores reach `data/cache.db` — the served API only ever
reads that table, so a deployment without the token still answers. Since route
photos landed, `backend/photos.py` reads it too, for the street-level half of
the photo strip. Absent, photographs come from Wikimedia Commons only, which
needs no key and no account at all, and the response says so in
`mapillary_enabled` rather than looking like a failure. It is still not required
to serve anything.

Nothing in this repository deploys itself. Secrets go into Secrets Manager by
hand; none is ever a CloudFormation parameter, because a parameter value is
visible in `describe-stacks` for the life of the stack.

---

## ⚠ The satellite basemap needs a free account that nobody has registered

**Read this before you deploy anything that serves the layer picker.** It is not
a footnote, it is the one open licensing question in this repository, and it is
the only item on this page that cannot be closed by a command.

The imagery comes from Esri's World Imagery tile service:

```
https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
```

That endpoint is **keyless**, and keyless is not the same as licensed. Esri's
published guidance permits unrestricted keyless use for OpenStreetMap *tracing
and editing*. Embedding the imagery in a third-party application is a different
case, and for that Esri asks for four things together:

| | | |
|---|---|---|
| a free ArcGIS Developer account | **done, 2026-08-26** | registered. See `VITE_ARCGIS_API_KEY` below for the key that follows from it |
| no revenue generation | true | the project takes none |
| under 1,000,000 tiles a month | true | the raster source is added **lazily**, on first selection, so a visitor who never opens the layer menu makes no request to this origin at all |
| attribution | true | `frontend/src/lib/basemap.js` carries the credit and the footer renders it; the OpenStreetMap credit survives the switch, because the labels over the imagery are still OSM's |

⚠ **Do not "fix" the Esri credit string from memory or from a tutorial.** It is
the service's own `copyrightText`, read from
`.../World_Imagery/MapServer?f=json` and reproduced verbatim. Maxar rebranded to
Vantor in 2025 and the service updated its credit accordingly, so the familiar
"Esri, Maxar, Earthstar Geographics" is now the *wrong* attribution rather than
merely an old one. Re-read the field before editing it. `frontend/scripts/gate.mjs`
asserts the attribution line changes and still names OpenStreetMap, which
catches a deletion but cannot catch a wrong string.

**What to do:** the account exists. What remains is to mint a key and set
`VITE_ARCGIS_API_KEY` in the Pages build environment.

### `VITE_ARCGIS_API_KEY` — the keyed imagery host

Unset, the build uses the anonymous host and behaves exactly as it did before
this variable existed. Set, it uses the authenticated one:

```
unset  →  https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}
set    →  https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=…
```

Both are raster XYZ templates, which is why this is a one-row change in
`frontend/src/lib/basemap.js` rather than a rewrite. The other authenticated
route Esri documents — `basemapstyles-api.arcgis.com/.../styles/arcgis/imagery`
— returns a **MapLibre style document** rather than tiles, and consuming that
means either `setStyle()` (which destroys every source and layer this app has)
or lifting sources out of it by hand. Both were rejected.

**Minting the key.** ArcGIS Location Platform dashboard → **Content → New item
→ Developer credentials → API key credentials**. Set **Application type =
Public application**, grant the **Basemaps** privilege (`premium:user:basemaps`),
and fill in the **Referrers** allowlist with the deploy origins:

```
meander-eoc.pages.dev
*.meander-eoc.pages.dev      ← Pages preview deployments get their own subdomain
localhost                     ← only if you want `npm run preview` to use the keyed host
```

**Leaving the referrer list empty is not a neutral default.** An unrestricted
public key is usable by anyone who reads it out of the bundle, and it is in the
bundle by design — see below.

⚠ **The key is public, and that is Esri's model rather than an oversight.** A
"Public application" credential is meant to be embedded in client code and is
secured by the referrer allowlist rather than by secrecy. It is not
secret-grade: Esri's own security guidance notes a referrer header can be
spoofed. For a free, non-commercial, low-traffic app that is the documented
trade. It is *not* a credential of the kind `MAPILLARY_TOKEN` is — that one is
server-side only and must never reach the bundle.

⚠⚠ **The referrer allowlist needs a referrer, and this site sends none.** Both
`frontend/public/_headers` and the Caddyfile set `Referrer-Policy: no-referrer`.
Under that policy the browser sends no `Referer` at all, so a restricted key is
rejected on every single tile — a blank satellite layer, and nothing in the
console names the cause. The header is right and stays; the exception is made
per request in `MapView`'s `transformRequest`, which returns
`referrerPolicy: 'origin'` for the keyed host and nothing for anything else. So
Esri receives `https://meander-eoc.pages.dev/` and never a path, a route or a
coordinate. `basemap-contract.test.js` pins that the exception stays narrow.

**Free tier:** 2,000,000 basemap tiles a month. Exceeding it converts to
pay-as-you-go, which is off by default on a new account — so with no payment
method on file the practical failure mode is requests failing rather than a
surprise bill. Verify that against your own account settings rather than
trusting this paragraph.

**Both origins are named in the CSP**, not only the active one. Which host is
live is decided by this variable at *build* time, and a policy covering only
the active one would blank the satellite layer the first time the variable
changed. A contract test fails if either goes missing.

[BLOCKED.md](BLOCKED.md) §13 tracks what remains.

**If it ever becomes untenable** — the project takes revenue, or Esri changes
the terms — the swap is one line in `frontend/src/lib/basemap.js`, plus the
matching origin in `frontend/public/_headers`. EOX's Sentinel-2 cloudless is
verified keyless, CC BY-NC-SA 4.0 and CORS-open:

```
https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg
EOxCloudless 2020 by EOX IT Services GmbH, contains modified Copernicus Sentinel data 2020
```

It is not the default because it is 10 m/pixel and EOX's own documentation says
z13 best resembles the source resolution. Follow mode runs at about z17, where
Sentinel-2 is an upsampled blur — which for a walking app is the difference
between seeing the path and seeing a green smear.

**The privacy consequence ships with it, and it is not optional either.**
Satellite is the only basemap that fetches tiles while somebody is walking, so
`FollowMode` prints a different provenance sentence under it, the layer picker
warns at the moment of choosing, and the CSP names
`https://server.arcgisonline.com` in **both** `img-src` and `connect-src` —
both, because MapLibre v5 loads raster tiles through `fetch` rather than through
an `<img>`, and a policy that forgets `connect-src` produces a permanently blank
basemap after a twenty-second timeout with no error anywhere.

---

## Route photos, and the one setting that matters in production

`POST /api/photos` returns image URLs that point back at this service, and
`GET /api/photo/{ref}` streams the bytes. The browser never contacts Wikimedia
or Mapillary, so neither of them sees a user's IP address next to a set of
coordinates describing where that person is about to walk. Both paths need a
line in the `@public` allowlist in `Caddyfile`, and both have one.

**`MEANDER_PHOTO_SIGNING_KEY` is empty on a single worker and must be set on
more than one.** Unset, `backend/config.py` generates a key per process:
references stay valid for the life of that process, and a restart invalidates
them, which shows up as one image that fails to load and is refetched by the
next `/api/photos` call. Run two workers or two instances without setting it and
each mints references the others reject — roughly `(n-1)/n` of image loads 404
at random, which reads as a flaky CDN rather than as a configuration error.

```bash
openssl rand -hex 32
```

It is not a credential and grants access to nothing. `backend/photos.py` refuses
any host that is not `upload.wikimedia.org` or a Mapillary CDN edge whatever the
signature says; the HMAC is the second lock, there so a reference cannot be
edited into a *different* URL on those allowed hosts.

The remaining knobs — `MEANDER_PHOTO_MAX_ANCHORS` (keep it **odd**, or the
`fastest` hero stops being the midpoint), `MEANDER_PHOTO_SEARCH_RADIUS_M`,
`MEANDER_PHOTO_MAX_IMAGE_BYTES`, `MEANDER_PHOTO_CACHE_MAX_AGE_S` and the
`MEANDER_PHOTO_RATE_*` bucket — are documented beside their defaults in
`.env.example` and in `backend/config.py`. The image endpoint has its own token
bucket on purpose: one route view asks for up to six images against a route
bucket whose whole capacity is twelve.

---

## Step 0 · The graph, which is the awkward part

The router image never imports a graph. An import is 71 s for the demo region
set and about 31 minutes for three whole countries — either would be an outage
of that length on **every** task replacement, and ECS would kill the task long
before the second finished. So the graph is a build artifact.

```bash
scripts/graphhopper.sh setup --region-set demo   # ~4 min, once. Needs JDK 21.
scripts/publish_graph.sh --local                 # stages it for the image build
```

That gives a 485 MB graph covering bounding boxes around the five demo
locations. `--region-set countries` gives Sri Lanka, the Netherlands and Great
Britain entire: 6.6 GB, a 31-minute import and a 20 GB serve heap, which is a
different `RouterMemory` and a different cost conversation.

CI cannot do this — a GitHub runner would have to import the graph first — so
the router image is built from a workstation. See
[`infra/README.md`](infra/README.md) for the alternative, where the container
fetches a published archive at start and verifies its digest before unpacking.

## Step 0b · Pre-warm the scenery cache

Optional, and do it before the first deploy: `data/cache.db` is baked into the
API image, so warming it afterwards means rebuilding.

```bash
MEANDER_FIXTURES=record python3 -m backend.batch_score
```

Needs a Mapillary token and torch locally. It writes CLIP scores for the demo
locations; anywhere you have not warmed comes back
`scoring_method: "geometry_only"` and says so in the response. The committed
cache already holds 146 segments across the five demo locations, so you can
skip this entirely and still get real scores there.

## Step 1 · The stacks

In order, because each imports from the one before. Full commands with the
parameter overrides are in [`infra/README.md`](infra/README.md); the shape is:

```bash
REGION=ap-south-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)

aws cloudformation deploy --stack-name meander-platform --template-file infra/00-platform.yaml \
  --capabilities CAPABILITY_NAMED_IAM --region $REGION
aws cloudformation deploy --stack-name meander-network  --template-file infra/10-network.yaml \
  --region $REGION --parameter-overrides CloudFrontPrefixListId=$PL
# push both images, then
aws cloudformation deploy --stack-name meander-services --template-file infra/20-services.yaml \
  --capabilities CAPABILITY_NAMED_IAM --region $REGION --parameter-overrides ...
aws cloudformation deploy --stack-name meander-web      --template-file infra/30-web.yaml \
  --region $REGION
```

Then the secrets, separately:

```bash
aws secretsmanager put-secret-value --secret-id meander/api --region $REGION \
  --secret-string '{"MAPILLARY_TOKEN":"…","ANTHROPIC_API_KEY":"…"}'
```

## Step 2 · CORS — one line, and it is not optional any more

This section used to say there was no CORS step. That was true of the website
and only of the website.

The previous deployment's most error-prone moment was closing the CORS/CSP loop
between two hosts, where the site stayed broken until *both* edits were made
and the failure mode was a browser console message with an empty server log.
One CloudFront distribution serves the app from S3 and `/api/*` from the load
balancer, so **the browser** only ever talks to one origin, and the CSP names
exactly `'self'` plus the tile host.

**The iOS app is not the browser.** It serves its own assets from
`capacitor://localhost` and calls `https://<distribution>/api/*`, which is
cross-origin by any definition — so preflight applies and the allowlist has to
name a scheme that is neither `http` nor `https`. `CorsOrigins` defaults to
`capacitor://localhost`; override it only if you also change
`server.iosScheme`, and if you do, the two must change together.

> ⚠ **`MEANDER_ALLOWED_ORIGINS=''` never meant "allow nothing".**
> `backend/config.py:322` reads `_env_flag("MEANDER_ALLOW_LOCAL_ORIGINS", not
> origins)` — the default is *on whenever no origins are configured*. The task
> definition shipped an empty string, so the deployed allowlist was
> `('http://localhost:5173', 'http://127.0.0.1:5173')`: production allowlisted
> the Vite dev server. Setting `CorsOrigins` turns that default off as a side
> effect of the list becoming non-empty, which is the behaviour we want —
> `backend/tests/test_client_ip_and_cors.py` pins both halves so it stays true.

Two things already verified and worth not re-deriving: the `/api/*` cache
behaviour uses AWS-managed `AllViewerExceptHostHeader`
(`b689b0a8-53d0-40ab-baf2-68738e2966ac`), which forwards `Origin` to the ALB,
and `CachingDisabled` (`4135ea2d-6df8-44a3-9df3-4b5a84be39ad`), so a response is
never cached across origins.

Prove the preflight survives CloudFront before building any app — this is the
single most likely thing to be quietly wrong:

```bash
curl -s -i -X OPTIONS $SITE/api/routes \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' | head -20
```

You want a `200` with `access-control-allow-origin: capacitor://localhost` and
`POST` in `access-control-allow-methods`. A `403` means CloudFront answered
instead of the ALB.

## Step 3 · Verify

```bash
SITE=$(aws cloudformation describe-stacks --stack-name meander-web \
  --query 'Stacks[0].Outputs[?OutputKey==`SiteUrl`].OutputValue' --output text)

curl -s $SITE/api/healthz
curl -s $SITE/api/health | jq '.routing | {self_hosted, self_hosted_source, path_details}'
curl -s $SITE/api/health | jq .cache
curl -s -X POST $SITE/api/routes -H 'content-type: application/json' \
  -d '{"origin":{"lat":51.507489,"lon":-0.162207},"minutes":35,"mode":"auto",
       "objectives":["fastest","scenic","accessible"]}' \
  | jq '.routes[] | {id, status, scoring_method, confidence}'
```

**The one that matters most is the second.** `self_hosted` must be `true`,
`self_hosted_source` must be `"env"`, and `path_details` must contain
`"smoothness"`. If `self_hosted_source` says `"sniff"` the hostname heuristic
has guessed — and it guesses wrong for a Cloud Map name — so `smoothness`
silently leaves the request, and the accessible model stops excluding surfaces
recorded as impassable. The app carries on looking perfectly healthy.

The full list is the gate table in [`infra/README.md`](infra/README.md).

## Watching the bill

The two lines worth arguing about, both in [`infra/README.md`](infra/README.md):
the NAT gateway costs $32/month, more than the API it serves, and the load
balancer costs $18/month, about as much as everything it balances. At this size
a single small instance running `docker compose up` would do the same job for
about a third of the total, and the README says so.

`meander-api-latency-p95` and the other three alarms go to an SNS topic; set
`AlarmEmail` when deploying the services stack or they exist and notify nobody.

## Rolling back

Images are tagged with the commit SHA and the ECR repositories are
IMMUTABLE-tagged, so a rollback is a task definition rather than a rebuild. The
API service has a deployment circuit breaker with rollback enabled and reverts
a bad image on its own; the router runs a single task and does not. Commands
are in [`docs/RUNBOOK.md`](docs/RUNBOOK.md).

---

## Preview deployments are CORS-rejected, on purpose

Every Cloudflare Pages build that is not on the production branch is published
at a fresh, per-deployment hostname — `https://<hash>.meander-eoc.pages.dev`.
The API allowlists one origin, the stable project URL, so **every preview
deployment fails CORS on every call.** Measured against the live API:

```
$ curl -i -X OPTIONS https://meander-app.duckdns.org/api/routes \
    -H 'Origin: https://abc123.meander-eoc.pages.dev' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type'
HTTP/2 400
Disallowed CORS origin
```

with no `access-control-allow-origin` header at all, against a `200` and
`access-control-allow-origin: https://meander-eoc.pages.dev` for the stable one.

Session A saw this happen for real: Caddy's log shows an iPhone hitting
`POST /api/routes` from `https://7ff77dbe.meander-eoc.pages.dev` and being
rejected.

**Three options existed, and this is the one that was taken:**

1. **Accept it.** Previews are for looking at the UI; develop against the mock
   with `npm run dev:mock`, which needs no API at all.
2. Build previews against the mock automatically — a `VITE_MOCK_API=1` preview
   environment variable in the Pages project. Rejected only because it makes a
   preview quietly *not* the thing it looks like, which is worse than a preview
   that visibly cannot reach the server.
3. Teach the backend pattern matching. `backend/config.py:336-372` comma-splits
   `MEANDER_ALLOWED_ORIGINS` and compares verbatim; there is no
   `allow_origin_regex` anywhere in the backend and no test pins the behaviour,
   so this is an absence rather than a guarantee. Rejected because a regex over
   an origin allowlist is a security control that is easy to write
   almost-correctly — `.*\.meander-eoc\.pages\.dev` also matches
   `evil.meander-eoc.pages.dev.attacker.com` if the anchor is wrong — and the
   thing it buys is convenience on a branch build.

If you need a specific preview to reach the API, add that exact origin to
`MEANDER_ALLOWED_ORIGINS` on the VM for as long as you need it, and take it out
again. Do not put a per-deployment hostname in the committed config: it works
today and breaks on the next Pages build.

CONTRIBUTING.md carries the short version, in the gotchas table, because the
person who hits this is opening a pull request rather than reading this file.

---

## Things that will look like bugs and are not

The most useful table in this document. Kept from the Render version and
extended, because most of it was never about Render.

| symptom | cause |
|---|---|
| `clip_available: false` | Correct. The deployed image has no torch, by design. Scores are read from the pre-warmed cache. |
| `scoring_method: "geometry_only"` | No pre-warmed CLIP scores for that area. Run Step 0b for it. Everywhere outside the five demo locations, this is expected. |
| `segments_scored: 0` when you warmed the cache | `MEANDER_CACHE_DB` is set in the task definition. It points the API away from the `data/cache.db` baked into the image and **nothing else looks wrong**. Leave it unset. |
| Every route identical | GraphHopper accepted `custom_model` and ignored it. `ch.disable` must accompany it — the classic failure, and it is silent. `scripts/verify_selfhosted.py` checks for exactly this. |
| `scenic` and `accessible` blocked, "flexible routing mode" | You are pointed at the hosted GraphHopper free tier, which cannot execute a custom model. Point `MEANDER_GRAPHHOPPER_URL` at your own router. |
| `path_details` has no `smoothness` | `MEANDER_GRAPHHOPPER_SELF_HOSTED` is not `1`. The accessible model has silently stopped excluding impassable surfaces. This is the most dangerous one on the list. |
| 429 with "used up its routing allowance" | The daily ceiling. Working as intended. |
| `/api/health` 404s from your laptop but `/healthz` is fine | Deliberate, since the Caddyfile stopped allowlisting it. `/api/health` is a strict superset of `/metrics` — the same counters, plus the router's internal URL, key-presence booleans, cache counts and the rate limiter's own configuration — and `/metrics` was already firewalled to hide exactly that, so publishing the larger one was the wrong way round. Read it on the VM: `curl -s 127.0.0.1:8000/api/health`. `/healthz` stays public because UptimeRobot polls it and it discloses a status string and a version. |
| *Everyone* getting 429 at once | `MEANDER_TRUSTED_PROXY_HOPS` is wrong. Behind CloudFront **and** an ALB it is `2`: the header is `viewer, cloudfront` and the limiter counts from the right. At `1` every request in the world shares one bucket, and the limiter still *works*, which is what makes it hard to spot. |
| A Cloudflare **preview** deployment loads, but every API call fails CORS | Expected, and accepted rather than fixed — see "Preview deployments" above. |
| Routes appear but the map is blank | CSP `connect-src`/`img-src` is missing `https://tiles.openfreemap.org`. |
| The map is fine until you pick **Satellite**, then blank for twenty seconds and then blank for ever, with nothing in the console | CSP is missing `https://server.arcgisonline.com` from **`connect-src`**. `img-src` alone is not enough and looks like it should be: MapLibre v5 loads raster tiles through `fetch`, not through an `<img>`, so the request is a connect and the policy refuses it. `MapView.jsx` then falls through to its 20 s `MAP_LOAD_TIMEOUT_MS` and reports nothing, because no error is raised anywhere. Both entries are in `frontend/public/_headers`; if you serve the app from somewhere else, both have to be there too. |
| The satellite layer works and you have not registered anything with Esri | Read the ⚠ section above. Three of Esri's four conditions are met and the fourth is a free account nobody has created. It will not break; it is unresolved. |
| The follow screen says satellite tiles are being fetched as you move | Correct, and deliberate. Under satellite the imagery host can infer the walk from the sequence of tile requests. The position itself still never leaves the device, and no tile is cached. Switch to Map or Green cover and the sentence goes back to "no network in follow mode", which is measured rather than asserted. |
| Photos load, and after an API restart every one of them 404s | Expected on a single worker: `MEANDER_PHOTO_SIGNING_KEY` is unset, so the key is per process and a restart invalidates outstanding references. The next `/api/photos` call mints new ones. If it happens **continuously and at random** instead, you are running more than one worker without the key set — see "Route photos" above. |
| Every photo comes from Wikimedia Commons and none from street level | No `MAPILLARY_TOKEN`. That is the ordinary keyless configuration, not a failure: `mapillary_enabled: false` and a note say so, and the strip is Commons-only. |
| The `scenic` hero is not obviously the scenic bit | Correct, and the response admits it. Only `accessible` (the first barrier) and `fastest` (the midpoint) are anchored by anything measured. The other four have no per-segment data on the wire at all, so the hero is the most-photographed nearby place and `objective_measured` is `false`. |
| Mapillary answers `Please reduce the amount of data you're asking for` | The bbox is too large. Measured: a 0.016 × 0.008 degree box is rejected outright, while the 0.004-degree box `backend/photos.py` builds (`MAPILLARY_BBOX_HALF_DEG = 0.002`) returns images fine. If you widen `MEANDER_PHOTO_SEARCH_RADIUS_M`, check this before assuming the token is wrong. |
| A photo request is served from `scontent-*.xx.fbcdn.net` in the backend's egress | Correct. That is Mapillary's thumbnail CDN and its hostname rotates per edge and per session — `scontent-bom5-1.xx.fbcdn.net` was one observed live. It is exactly why photos are proxied: no CSP can enumerate those hosts without allowing the whole of Facebook's CDN, and letting the browser fetch them would hand the user's IP to the host anyway. |
| The map is blank **and** the app says it is showing a saved copy | Correct. Map tiles are deliberately never cached — a tile cache is a record of where you have been — so an offline route has no map. Everything the routes say is in the list. |
| Nothing is served offline at all | No longer true on the web. The service worker registers on the live site, precaches eleven entries and opens the app with the network off — verified in a real browser by `frontend/scripts/live-gate.mjs`. Still true for iOS, where a service worker never registers under `capacitor://localhost` at all: BLOCKED.md §5. |
| "Save routes for offline" is granted, and nothing is saved | **Fixed.** It was real: `sw.js` returns early for any cross-origin request — the line that keeps map tiles from ever being cached, and it is right — but this deployment serves the site from `meander-eoc.pages.dev` and the API from `meander-app.duckdns.org`, so *every* API call was cross-origin and the worker's `/api/routes` branch never ran. Measured live at the time: consent granted, search completed, zero results caches, nothing stored. The store now lives on the page (`frontend/src/lib/resultsStore.js`), written by `client.js` after a completed stream, so it sees the request whatever origin the API is on. BLOCKED.md §8 has the reasoning. If you see this symptom again, check in this order: is a shell cache installed (`caches.keys()` — the store versions itself against it and stores nothing without one); is the origin secure (`crypto.subtle` is needed for the request digest); and did the search actually return 200 rather than 429. |
| Rest stops are `null` rather than `[]` | Overpass timed out. `null` means "we could not look" and `[]` means "we looked and found none" — the difference is deliberate and the UI renders them differently. |
| `narration` is `null` | No `ANTHROPIC_API_KEY`. The card says "Description still being written…". |
| The router has no public IP and you cannot curl it | Correct. Its security group's only ingress rule names the API's security group. It is unauthenticated and compute-unbounded; that is the boundary. |
| The frontend 404s on a deep link | On Cloudflare Pages this is automatic — Pages falls back to `/index.html` for any path with no asset, as long as the build has no top-level `404.html`. Adding one switches that off for every path at once. `frontend/public/_redirects` deliberately contains no rules and says why. On the retired CloudFront path it was the custom error responses instead. |
| A `Caddyfile` change survives `git pull` **and** a reload, and the old config is still served | The `caddy` service bind-mounts a **single file** (`compose.prod.yml:194`, `./Caddyfile:/etc/caddy/Caddyfile:ro`), and a single-file bind mount is bound to the *inode*, not to the path. `git pull` does not rewrite a tracked file in place — it unlinks it and creates a new one — so the host path is now a different inode and the container's mount still points at the old, unlinked one. `caddy reload` then re-reads `/etc/caddy/Caddyfile` **from inside the container**, which is the stale inode: measured here, it logged `adapted config to JSON`, **exited 0**, and went on serving the previous config. Nothing anywhere says the word "stale". ⚠ **This is why the trap is intermittent and reads as haunted:** an edit that writes *in place* — `>`, `>>`, an editor configured to truncate-and-write — keeps the inode and does propagate into the container, so hand-editing the Caddyfile on the VM appears to work. Anything that replaces the file instead — `git pull`, `git checkout`, `sed -i`, and any editor that writes a temp file and renames it over the target — does not. Both were measured; the difference is invisible from the shell. The fix is to **recreate the container, not reload it** — `docker compose … up -d --force-recreate caddy`. (A plain `restart caddy` also works, because the mount is re-resolved at container start; `up -d` on its own does not — it prints `Container … Running` and does nothing.) This is why `scripts/provision-vm.sh` recreates Caddy and never reloads it. |
| A backend change survives `git pull` **and** `--force-recreate`, and the old code is still running | `--force-recreate` recreates the **container**. It never rebuilds the **image**, and `Dockerfile:46` bakes the source in with `COPY backend/ /app/backend/` — so after a pull the new code is on the host and the image still holds the old. Compose recreates from that unchanged image, prints `Started`, and exits 0. The verb is `docker compose … build api`. ⚠ **This row and the one above it need different verbs, and neither covers the other:** `--force-recreate` alone fixes the Caddyfile and silently misses the API; `--build` alone rebuilds the API and silently misses the Caddyfile — it prints `Image Built` and then `Container Running` for a Caddy still on the stale mount, because the Caddy *image* did not change so nothing is recreated. Both failures exit 0 and look like deploys. Measured on this VM (Docker 29.7.2, Compose v5.4.0). Use `scripts/provision-vm.sh deploy`, which does both and then proves it. |
| You want to know whether the running containers are actually the code you pulled | Do not infer it from a green `up -d`; neither trap above turns anything red. Compare digests across the boundary — `scripts/provision-vm.sh verify` does exactly this, and it is the only check here that can fail for the right reason: `sha256sum Caddyfile` against `docker exec meander-caddy-1 sha256sum /etc/caddy/Caddyfile`, and the same comparison over `backend/**/*.py` inside `meander-api-1`. |
| `/api/report-barrier` really does write to OpenStreetMap | Correct, deliberate, and the only write this application makes. It goes to `api06.dev.openstreetmap.org` — the OSM **development** server, whose data is disposable — and `backend/osm_report.py:66` asserts that host at call time rather than only configuring it, so a copy-paste that repointed it at production raises a 500 instead of publishing junk into the map everyone else relies on. It shares the per-IP token bucket with routing and geocoding and costs a daily-ceiling slot, so it cannot be used to hammer OSM from behind this deployment. A missing `OSM_DEV_TOKEN` means an *anonymous* note, not a broken feature, which is why callers key their failure handling on the response rather than on whether a token is set. `About.jsx` and `FirstRun.jsx` both name it, because a privacy promise with an exception has to say so out loud. Left exactly as it is. |

### The iOS build, specifically

Each of these fails **silently**, which is the failure mode this project's whole
ethic is built against. None of them produces an error anywhere.

| symptom | cause |
|---|---|
| The app calls the API and the browser console says nothing, but every request fails | CORS. `MEANDER_ALLOWED_ORIGINS` does not name `capacitor://localhost` — see Step 2, and note that an *empty* value does not mean "deny", it means "allow the Vite dev server". |
| All three routes arrive together at the end instead of one at a time | The `CapacitorHttp` plugin is enabled. It patches global `fetch`, so `res.body` is gone, and `realFetchRoutes()` in `client.js` falls through to its plain-JSON branch — the app still works, and the streaming choreography the UI is built around never fires. **Leave it disabled.** Fix CORS on the server, which is where it belongs. |
| The map is blank in the app but fine on the website | The app has no server in front of it, so `infra/30-web.yaml`'s response headers never reach it. It needs its own `<meta http-equiv="Content-Security-Policy">` naming `https://tiles.openfreemap.org` in **both** `connect-src` and `img-src`. |
| A frame of cream before the dark theme paints | `script-src 'self'` with no hash killed the inline anti-flash block in `index.html`. That script exists on purpose; add its SHA-256 to `script-src` and a build check that the hash still matches, because it will drift the first time anyone edits it. |
| A "save this route for offline" control that does nothing | Service workers do not register under `capacitor://localhost` — WKWebView only registers them on `http`/`https` secure origins, and `registerServiceWorker()` catches the failure and says nothing. **Still true on iOS after the web fix**, and deliberately so: the page-side store versions its bucket against the installed shell cache, and with no worker there is no shell cache, so it stores nothing rather than inventing a version. That keeps the web fix from silently starting to store on a platform nobody has tested it on. Re-base it on native storage or **remove the affordance** — a control that does nothing is the exact dishonesty this project refuses, and on iOS it still does nothing. |
| The 200 m barrier warning is visible but silent | `navigator.vibrate` is not implemented in WKWebView. It does not throw; it does nothing. Use a native haptic and keep the `role="alert"` announcement and the visual. |
| Geolocation never returns a fix | `server.iosScheme` was changed away from the default. `capacitor://localhost` keeps `localhost` as the hostname, which is what makes the WebView a secure context — and without a secure context there is no `navigator.geolocation` and follow mode cannot start. Changing the scheme also changes the `Origin`, so Step 2 has to change with it. |
| Route coordinates appear in a published container layer | `data/cache.db` is baked into the API image and its `route_cache` table holds real coordinate arrays. Run `make scrub` before any image build, and install the pre-commit hook — `scripts/install-hooks.sh`, which is **not** automatic on clone. There is no way to un-publish a container layer. |
