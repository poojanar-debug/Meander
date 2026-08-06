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
> What *has* been verified end to end is the same stack under `docker compose`
> on a laptop: both images build, both containers reach healthy, and
> `POST /api/routes` returns three routes with real CLIP scores. That is the
> strongest claim available without spending money.

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

**None of the three keys is required to serve a route.** `MAPILLARY_TOKEN` is
read only by the offline batch scorer, `ANTHROPIC_API_KEY` only by narration,
and `GRAPHHOPPER_KEY` only if you point at the hosted API instead of your own
router. `/api/health` reports which are missing. Without Anthropic, `narration`
stays `null` and the card reads "Description still being written…" — which is
why that copy exists.

Nothing in this repository deploys itself. Secrets go into Secrets Manager by
hand; none is ever a CloudFormation parameter, because a parameter value is
visible in `describe-stacks` for the life of the stack.

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
       "objectives":["fastest","nature","accessible"]}' \
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

## Things that will look like bugs and are not

The most useful table in this document. Kept from the Render version and
extended, because most of it was never about Render.

| symptom | cause |
|---|---|
| `clip_available: false` | Correct. The deployed image has no torch, by design. Scores are read from the pre-warmed cache. |
| `scoring_method: "geometry_only"` | No pre-warmed CLIP scores for that area. Run Step 0b for it. Everywhere outside the five demo locations, this is expected. |
| `segments_scored: 0` when you warmed the cache | `MEANDER_CACHE_DB` is set in the task definition. It points the API away from the `data/cache.db` baked into the image and **nothing else looks wrong**. Leave it unset. |
| Every route identical | GraphHopper accepted `custom_model` and ignored it. `ch.disable` must accompany it — the classic failure, and it is silent. `scripts/verify_selfhosted.py` checks for exactly this. |
| `nature` and `accessible` blocked, "flexible routing mode" | You are pointed at the hosted GraphHopper free tier, which cannot execute a custom model. Point `MEANDER_GRAPHHOPPER_URL` at your own router. |
| `path_details` has no `smoothness` | `MEANDER_GRAPHHOPPER_SELF_HOSTED` is not `1`. The accessible model has silently stopped excluding impassable surfaces. This is the most dangerous one on the list. |
| 429 with "used up its routing allowance" | The daily ceiling. Working as intended. |
| *Everyone* getting 429 at once | `MEANDER_TRUSTED_PROXY_HOPS` is wrong. Behind CloudFront **and** an ALB it is `2`: the header is `viewer, cloudfront` and the limiter counts from the right. At `1` every request in the world shares one bucket, and the limiter still *works*, which is what makes it hard to spot. |
| Routes appear but the map is blank | CSP `connect-src`/`img-src` is missing `https://tiles.openfreemap.org`. |
| The map is blank **and** the app says it is showing a saved copy | Correct. Map tiles are deliberately never cached — a tile cache is a record of where you have been — so an offline route has no map. Everything the routes say is in the list. |
| Nothing is served offline at all | Correct **for now**, and a regression this tree owns. The service worker and the saved-route store belonged to the launch frontend and did not survive the reconciliation merge — BLOCKED.md §5. They are coming back on native storage, because a service worker never registers under `capacitor://localhost` in the first place. |
| Rest stops are `null` rather than `[]` | Overpass timed out. `null` means "we could not look" and `[]` means "we looked and found none" — the difference is deliberate and the UI renders them differently. |
| `narration` is `null` | No `ANTHROPIC_API_KEY`. The card says "Description still being written…". |
| The router has no public IP and you cannot curl it | Correct. Its security group's only ingress rule names the API's security group. It is unauthenticated and compute-unbounded; that is the boundary. |
| The frontend 404s on a deep link | The CloudFront custom error responses rewrite 403/404 to `/index.html`. If they are missing, the SPA cannot handle refreshes. |

### The iOS build, specifically

Each of these fails **silently**, which is the failure mode this project's whole
ethic is built against. None of them produces an error anywhere.

| symptom | cause |
|---|---|
| The app calls the API and the browser console says nothing, but every request fails | CORS. `MEANDER_ALLOWED_ORIGINS` does not name `capacitor://localhost` — see Step 2, and note that an *empty* value does not mean "deny", it means "allow the Vite dev server". |
| All three routes arrive together at the end instead of one at a time | The `CapacitorHttp` plugin is enabled. It patches global `fetch`, so `res.body` is gone, and `realFetchRoutes()` in `client.js` falls through to its plain-JSON branch — the app still works, and the streaming choreography the UI is built around never fires. **Leave it disabled.** Fix CORS on the server, which is where it belongs. |
| The map is blank in the app but fine on the website | The app has no server in front of it, so `infra/30-web.yaml`'s response headers never reach it. It needs its own `<meta http-equiv="Content-Security-Policy">` naming `https://tiles.openfreemap.org` in **both** `connect-src` and `img-src`. |
| A frame of cream before the dark theme paints | `script-src 'self'` with no hash killed the inline anti-flash block in `index.html`. That script exists on purpose; add its SHA-256 to `script-src` and a build check that the hash still matches, because it will drift the first time anyone edits it. |
| A "save this route for offline" control that does nothing | Service workers do not register under `capacitor://localhost` — WKWebView only registers them on `http`/`https` secure origins, and `registerServiceWorker()` catches the failure and says nothing. Re-base the store on native storage or **remove the affordance**. A control that does nothing is the exact dishonesty this project refuses. |
| The 200 m barrier warning is visible but silent | `navigator.vibrate` is not implemented in WKWebView. It does not throw; it does nothing. Use a native haptic and keep the `role="alert"` announcement and the visual. |
| Geolocation never returns a fix | `server.iosScheme` was changed away from the default. `capacitor://localhost` keeps `localhost` as the hostname, which is what makes the WebView a secure context — and without a secure context there is no `navigator.geolocation` and follow mode cannot start. Changing the scheme also changes the `Origin`, so Step 2 has to change with it. |
| Route coordinates appear in a published container layer | `data/cache.db` is baked into the API image and its `route_cache` table holds real coordinate arrays. Run `make scrub` before any image build, and install the pre-commit hook — `scripts/install-hooks.sh`, which is **not** automatic on clone. There is no way to un-publish a container layer. |
