# Deploying Meander

Backend on Render's free tier, frontend on Vercel. Roughly twenty minutes end to end, most of it
waiting for builds.

Nothing in this repo deploys itself and no step below runs automatically. Every secret is entered
in a hosting dashboard; none is ever committed.

---

## Before you start

You need:

| | where | free? |
|---|---|---|
| GraphHopper API key | https://www.graphhopper.com/ → Dashboard → API keys | yes, 500 credits/day |
| Mapillary client token | https://www.mapillary.com/dashboard/developers | yes |
| Anthropic API key | https://console.anthropic.com/ | **no — costs real money per call** |
| Render account | https://render.com | yes |
| Vercel account | https://vercel.com | yes |

Only the GraphHopper key is required. Without Mapillary, scenery scores fall back to geometry and
say so. Without Anthropic, `narration` stays `null` and the card reads "Description still being
written…" — which is why that copy exists.

---

## Step 0 · Pre-warm the scenery cache (optional, but do it before the first deploy)

The deployed backend has 512 MB and cannot run CLIP. It reads scores from `data/cache.db`, which
you generate **locally**, commit, and deploy along with the code.

```bash
python3 -m venv .venv && source .venv/bin/activate && pip install -r backend/requirements.txt
```

```bash
MEANDER_FIXTURES=record python3 -m backend.batch_score --location hyde-park-london --location euston-road-london
```

```bash
git add data/cache.db && git commit -m "chore(cache): pre-warm CLIP segment scores"
```

Skip this and everything still works — every route just comes back with
`scoring_method: "geometry_only"` and a lower confidence, which the UI states plainly.

---

## Step 1 · Backend on Render

1. Push this repo to GitHub.
2. Render dashboard → **New** → **Blueprint** → select the repo. Render reads
   [`render.yaml`](render.yaml).
3. It will prompt for the values marked `sync: false`. Enter:

   | key | value |
   |---|---|
   | `GRAPHHOPPER_KEY` | your key |
   | `MAPILLARY_TOKEN` | your token, or leave blank |
   | `ANTHROPIC_API_KEY` | your key, or leave blank |
   | `OSM_DEV_TOKEN` | leave blank unless you want barrier reporting |
   | `MEANDER_ALLOWED_ORIGINS` | **leave blank for now** — you do not know the Vercel URL yet |

4. Deploy. First build takes 2–4 minutes.
5. Note the service URL, e.g. `https://meander-api.onrender.com`.

Check it:

```bash
curl -s https://meander-api.onrender.com/api/health | python3 -m json.tool
```

You want `"status": "ok"`, `"missing_keys": []`, and `"clip_available": false`. **`clip_available:
false` is correct and expected** — torch is deliberately absent from the deployed build.

> **`MEANDER_STRICT_STARTUP=1` means a missing key stops the boot** with a message naming the key.
> That is on purpose: a production instance silently falling back to fixtures would serve made-up
> routes. If the deploy fails, read the log — it tells you exactly which key is missing.

### About the free plan

- **It sleeps after 15 minutes of inactivity.** The next request takes 30–60 seconds to wake it.
  The frontend shows its loading banner throughout, so it looks slow rather than broken, but it is
  the first thing testers will notice.
- **The filesystem is ephemeral.** `MEANDER_CACHE_DB` points at `/tmp`, so the whole-route cache
  resets on every deploy and every wake. Segment scores come from the committed `data/cache.db` and
  survive, because they are part of the repo.
- **512 MB of RAM.** Do not add `torch` to `requirements-deploy.txt`. The instance will OOM at
  import and the failure is confusing — it looks like a crash loop with no error.

---

## Step 2 · Frontend on Vercel

1. Vercel → **Add New** → **Project** → same repo.
2. Set **Root Directory** to `frontend`. Vercel then reads
   [`frontend/vercel.json`](frontend/vercel.json) and detects Vite.
3. Add one environment variable, for **Production** and **Preview**:

   | key | value |
   |---|---|
   | `VITE_API_BASE` | `https://meander-api.onrender.com` — your Render URL, no trailing slash |

   Do **not** set `VITE_MOCK_API`. If you set it to `1`, the site runs on fixtures and shows a
   "Demo data" badge saying so.

4. Deploy. Note the URL, e.g. `https://meander.vercel.app`.

### Then close the CORS loop — the site is broken until you do

Two edits, both required:

**a. Render → your service → Environment → `MEANDER_ALLOWED_ORIGINS`:**

```
https://meander.vercel.app
```

Comma-separate if you have several. `http://localhost:5173` is always allowed in addition, so local
development keeps working. Save; Render redeploys.

**b. `frontend/vercel.json` → the `Content-Security-Policy` header.** Replace
`https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com` in `connect-src` with your Render URL, then
commit and push.

If you skip either, the browser blocks every API call and the UI shows "Could not reach the Meander
server." The Render logs will be empty, because the request never arrives. Check the browser console
first — it names which policy blocked it.

---

## Step 3 · Verify the deployment

```bash
curl -s https://meander-api.onrender.com/api/health | python3 -m json.tool
```

```bash
curl -s -X POST https://meander-api.onrender.com/api/routes -H 'Content-Type: application/json' -d '{"origin":{"lat":51.5073,"lon":-0.1657},"minutes":35,"mode":"auto"}' | python3 -m json.tool
```

Then in the browser, on the deployed site:

- [ ] Three route cards appear.
- [ ] Every card shows a `scoring_method` line and a confidence sentence.
- [ ] No card says "Built from demonstration data" — if one does, the backend is serving synthetic
      fixtures, which means `MEANDER_FIXTURES` is not `live` or the GraphHopper key is not working.
- [ ] The time dial refetches, and the previous routes stay on screen while it does.
- [ ] Tab through the whole page: every control is reachable and has a visible focus ring.
- [ ] At 375 px wide there is no horizontal scrolling.

---

## Watching the quota

`/api/health` reports it:

```json
"rate_limit": { "daily_ceiling": 120, "served_today": 37 }
```

GraphHopper's free tier is 500 credits/day and one routed request costs about three. The default
ceiling of 120 routed requests is ~360 credits, leaving headroom for geocoding and retries. A cache
hit is refunded and costs nothing.

If you raise `MEANDER_DAILY_ROUTE_CEILING`, raise it knowing that exceeding the GraphHopper quota
makes every route fail with a 503 for the rest of the day.

---

## Rolling back

Render and Vercel both keep previous deployments. Roll back from the dashboard; neither the
frontend nor the backend holds state that a rollback could corrupt — the app is stateless by
design and the only persistent artefact, `data/cache.db`, is versioned in git with the code.

---

## Things that will look like bugs and are not

| symptom | cause |
|---|---|
| First request after a quiet period takes ~45 s | Render free tier cold start. |
| `clip_available: false` | Correct. The deployed build has no torch, by design. |
| `scoring_method: "geometry_only"` | No pre-warmed CLIP scores for that area. Run Step 0 for it. |
| Every route identical | GraphHopper is ignoring `custom_model`. Check that `"ch.disable": true` is still in `build_request_body` — this is the classic failure and it is silent. |
| 429 with "used up its routing allowance" | The daily ceiling. Working as intended. |
| Routes appear but the map is blank | CSP `connect-src`/`img-src` is missing `https://tiles.openfreemap.org`. |
| "Could not reach the Meander server" | CORS. Step 2's two edits. |
