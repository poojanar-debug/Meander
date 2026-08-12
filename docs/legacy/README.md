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

## The move that was a copy

`PROGRESS.md:1768` and `docs/IOS-LAUNCH-PROMPT.md:119` both record `vercel.json`
as having been *moved* here. It was copied: `frontend/vercel.json` survived,
byte-identical, for 157 commits. Deleting it is what makes both of those
sentences true. Two things made that worth doing rather than leaving alone.

The live deployment is **Cloudflare Pages**, which does not read `vercel.json`
at all — it reads `public/_headers` and `public/_redirects`. So the copy in
`frontend/` was a file that looked like the deployed configuration, sat in the
build directory, and governed nothing. Nothing in the repository referenced it
either: not `package.json`, not the Makefile, not either workflow.

It also carried a literal `https://REPLACE-WITH-YOUR-RENDER-HOST.onrender.com`
in its `connect-src`. **That placeholder is correct here and wrong there.** In a
Render blueprint the API host genuinely is not known until you create the
service, so a placeholder is the honest value; in the build directory of a site
that is actually deployed, it is a CSP that would block the only API the app
talks to. The copy in this directory keeps it, deliberately.

The policy itself still has to go somewhere Pages reads. At the time of writing
`frontend/public/_headers` does **not** exist, which means the live site is
served with no CSP at all — `frontend/index.html` has no `<meta http-equiv>`
fallback either. That is the gap this file's `headers` block is the source
material for, and it is the frontend session's first job.

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
cannot execute a custom model, which means `scenic` and `accessible` come back
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

Expect `scenic` and `accessible` to report `status: "blocked"` with a
`status_note` saying the routing backend refused the custom model. That is the
app being honest, not a defect.
