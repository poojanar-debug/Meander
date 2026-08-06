# The previous deployment

Meander was first written to deploy on Render's free tier (backend) and Vercel
(frontend). That is superseded by the AWS stacks in [`infra/`](../../infra/),
and these two files are kept because the configuration is correct and someone
may want the cheaper shape.

| file | what it was |
|---|---|
| `render.yaml` | Blueprint for the API. Every secret `sync: false`, so Render prompts rather than reading a value from the file. |
| `vercel.json` | SPA rewrite, immutable asset caching, and the security headers including the CSP. |

**Neither was ever deployed either.** Same status as `infra/`: written,
reviewed, never applied.

## What the AWS version changed, and why

**One origin instead of two.** The split deployment's most error-prone step was
closing the CORS/CSP loop between the two hosts — the site stayed broken until
*both* `MEANDER_ALLOWED_ORIGINS` on Render and `connect-src` in `vercel.json`
were edited, and the failure was a browser console message with an empty server
log. One CloudFront distribution serving the app and `/api/*` removes the step
rather than documenting it better.

**Somewhere to put the router.** The decisive one. Render's free tier cannot
hold a routing graph — the demo set is 485 MB and needs a 3 GB heap — so the
Render deployment could only ever point at the hosted GraphHopper API, which
cannot execute a custom model, which means `nature` and `accessible` come back
blocked. Two of the three presets do not work. See
[ADR 2](../adr/0002-self-host-graphhopper.md).

**A pre-warmed cache that survives.** `render.yaml` originally set
`MEANDER_CACHE_DB=/tmp/meander-cache.db`, which is outside the repository — so
the committed `data/cache.db`, the entire reason a small instance can serve real
CLIP scores without torch, would never have been read. Every route would have
quietly dropped to `geometry_only` and nothing would have looked broken. Phase K
found it; the override is gone from both files, and the AWS task definition
deliberately does not set the variable at all.

## If you want this shape anyway

It is genuinely cheaper — free, against about $108/month — and for a demo
limited to `fastest` it is a reasonable trade. Move `render.yaml` back to the
repository root and `vercel.json` back to `frontend/`, then follow the version
of `DEPLOY.md` at tag `launch-p3`:

```bash
git show launch-p3:DEPLOY.md
```

Expect `nature` and `accessible` to report `status: "blocked"` with a
`status_note` saying the routing backend refused the custom model. That is the
app being honest, not a defect.
