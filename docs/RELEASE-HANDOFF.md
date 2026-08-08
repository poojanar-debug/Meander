# Meander — release handoff

Written 2026-08-08, at `219bf77`, at the end of a session that executed Act I and
Act III of [`RELEASE-PROMPT.md`](RELEASE-PROMPT.md) and the first phase of Act II.

**Read this before re-reading the brief.** The brief is still the plan and is
still mostly right, but parts of it are now stale, and five of its claims were
found to be wrong. Those are listed below so nobody spends an hour rediscovering
them.

---

## 0 · Where things are

```
main = origin/main = 219bf77        clean tree, everything pushed
```

`main` is **76 commits ahead** of where the brief found it. The fast-forward it
describes has happened; `feat/ios` is an ancestor of `main` and there is nothing
left to merge. Do not re-run Act I.

The full gate is green. Run it with `make check` — it now includes the three
jobs that used to be CI-only:

| | |
|---|---|
| backend tests | **652** |
| coverage | **87.71%** against an 85% floor |
| frontend tests | **51** |
| `test-sandboxed` | **skips on macOS** and says so — no `unshare -n`. CI covers it. |

Quote whatever your own run prints, not these numbers.

---

## 1 · What is done

**Act I — the tree.** Rescued, fast-forwarded, verified. The working tree had
been stuck for four days behind a **zero-byte `.git/index.lock` dated Aug 4** —
that, not neglect, is why it was dirty. A `cache.db` carrying 17 route-history
rows was discarded, 71 stray fixtures removed, four briefs that existed on no git
ref committed, and a duplicate-definition scan added to CI after it found real
silent merge damage on its first run.

**Act III — all six live defects.** Strict startup, the daily ceiling, the CORS
default, `.env.example`, the README claims. The sixth needed no fix: the
three-state score rendering was already correct and is now verified in a browser
rather than assumed.

**Act II phase 2 — two of nine capabilities.** `ElevationProfile` (`378beec`)
and `ReportBarrier` (`898810f`), the two that `BLOCKED.md` §5 never tracked.

---

## 2 · What is left, in order

### Act II, phases 3–6 · seven capabilities

Specs for every one of them are in [`RELEASE-SPECS.md`](RELEASE-SPECS.md) —
written by agents that read the `feat/launch` source and this component tree
side by side. **Read the spec for a capability before starting it.** They are
long, and each has a "what the brief got wrong" section that has already paid
for itself twice.

| # | capability | brief phase |
|---|---|---|
| 3 | `env(safe-area-inset-*)` | 3 |
| 4 | `lib/units.js` + `UnitsControl` | 3 |
| 5 | `lib/permalink.js` + `ShareButton` | 4 |
| 6 | `lib/export.js` | 4 |
| 7 | offline: `lib/offline.js`, `lib/offlineStore.js`, `sw.js`, three components | 5 |
| 8 | `frontend/public/` icons + `manifest.webmanifest` | 5 |
| 9 | `scripts/gate.mjs` + the other frontend gates | 6 |

Then **tag `v1.0.0-rc1`**, which the brief defines as "when the dropped
capabilities are back".

### Act IV · deployment

Decided already, by the project owner, in the session that wrote this:

- **Acts I–III plus deploy artifacts** is the agreed scope — write everything
  that needs no account, hand over the provisioning.
- **DuckDNS + Caddy DNS-01** for TLS, not a purchased domain. Keeps it $0.

Artifacts to write: `compose.prod.yml`, a Caddyfile, `scripts/provision-vm.sh`,
`frontend/public/_headers` and `_redirects`, `docs/adr/0007-single-vm-over-fargate.md`,
and a rewritten `DEPLOY.md`.

Provisioning itself needs an Oracle Cloud account, a Cloudflare account, and
**JDK 21, which is not installed on this machine** (`java` is 1.8). That blocks
Phase 9's graph import locally; import on the VM instead, which the brief already
recommends.

### Act V · audit and release

Untouched. Needs the live deployment and a real phone.

---

## 3 · Five things the brief gets wrong

Verified, not guessed. Do not re-litigate these.

1. **Phase 0's commits break Phase 1.** Any commit on `main` at `867e8e2` makes
   it diverge and `merge --ff-only` refuses. Phase 0 has to be working-tree
   cleanup only. Moot now, but the same trap applies to any future rebase plan.
2. **`scripts/scrub_cache_db.py` does not exist on `main`.** It arrives *with*
   the fast-forward, so Phase 0.2 cannot run as written.
3. **The precision-based fixture guard cannot work.** 283 of the 322 committed
   fixtures already carry more than six decimal places, some eighteen; they are
   verbatim recordings and carry upstream's precision by definition. The rule
   would reject the existing corpus. The strays were identical to the committed
   ones by every intrinsic property — the real discriminator is "nobody decided
   to add it", which is what `scripts/check_new_fixtures.py` checks.
4. **`OSM_DEV_TOKEN` is optional, not required.** `backend/osm_report.py:60`
   records that anonymous notes are permitted. Degrading the UI on token absence
   would have disabled a working feature.
5. **Four untracked docs, not three.** `RELEASE-PROMPT.md` postdates its own
   inventory of the working tree.

One more, smaller: the brief says the daily ceiling's rationale "evaporates
entirely" once the router is self-hosted. It does not. `fixtures.budget_applies()`
skips the per-service budgets in live mode, so the ceiling is the only remaining
guard on Overpass and Open-Meteo. It was re-sized against a measurement, not
removed.

---

## 4 · Two gates that could not fail

Both found in this session. The second is the reason the first matters.

**The hard-coded-colour gate had never worked.** `\b` is a GNU regex extension
and means nothing in a POSIX awk ERE, so `#[0-9a-fA-F]{3,8}\b` never matched an
ordinary `color: #ff0000;`. It was green in CI from the day it was written,
against a stylesheet it was not reading. `01160fb` fixes the pattern and makes
the gate **self-test before it certifies anything** — it feeds itself a known-bad
file and refuses to pass if that comes back clean.

**`scripts/gate.mjs` will do the same thing if ported rather than rewritten.**
It selects on `.row__button`, `.sheet__handle` and `.sheet__scroll`, none of
which exist in this frontend. Roughly half its checks would find zero elements
and pass vacuously.

So, for capability 9 and for anything else restored from `feat/launch`:
**make each gate fail once, on purpose, before trusting it.**

---

## 5 · This machine

| | |
|---|---|
| repo | `/Users/poojana/Meander/Meander`, `main` checked out |
| python | `.venv/bin/python` (3.13). The system python is 3.14 and cannot build pydantic-core. |
| `cfn-lint` | in the venv, **not on `PATH`** — `.venv/bin/cfn-lint` |
| `.venv-deploy/` | built by `make torch-free`, cached against `requirements-deploy.txt`. Gitignored. |
| JDK | **1.8 only. JDK 21 is missing** and Phase 9's import needs it. |
| ports 5173, 8000 | held by **another worktree's** stale servers from Aug 6 (`.claude/worktrees/meander-deploy-polish-018ed2`). Left alone deliberately. Use another port. |
| preview | the worktree's gitignored `.claude/launch.json` has a `primary-mock` entry on **5175** pointing at the primary checkout's frontend. |
| `.env` | exists, sets `MEANDER_FIXTURES=live`. Relevant when reasoning about CORS defaults locally. |

### Things that will stop you

- **The pre-commit hook fires on `data/cache.db`.** Any TestClient run or live
  request adds `route_cache` rows, and `git add -A` will stage them. It happened
  in this session. Fix with `make scrub`, which scrubs *and* restores.
- **A new fixture cannot be committed** without `MEANDER_ALLOW_NEW_FIXTURES=1`.
  That guard is new (`a9575a6`) and deliberate.
- **`git add -A` is risky in this repo** for both reasons above.
- **Do not re-record fixtures casually.** `BLOCKED.md:228` first.

---

## 6 · How to work

Unchanged from the brief, and it has been followed so far:

- 3–8 commits per phase, lowercase conventional subjects that say *why*.
- **Never rewrite history, never squash, never force-push.**
- `make check` green at **every** commit, not at the end.
- Push after every phase.
- Append to `PROGRESS.md` in its existing voice at the end of every phase —
  first person, honest about what did not work, specific about numbers.
- Say only what is true. If you cannot verify something, write down that you
  could not.

**Ask before:** changing `models.py` or `accessibility.py` semantics; spending
money; adding a runtime dependency; reopening the `66eaef3` frontend decision;
anything touching an accessibility claim or the privacy promise.

That last one is not theoretical. Restoring `ReportBarrier` would have turned
"Nothing is stored" into a false statement in two components. The owner was
asked, and chose to ship it with the promise amended to name its exception.

---

## 7 · The reading list, shortest useful path

1. This file.
2. `BLOCKED.md` §5 — updated, now nine capabilities with what came back.
3. The last two entries of `PROGRESS.md` — Act III and Act II phase 2.
4. `RELEASE-SPECS.md`, the section for whichever capability you are starting.
5. `RELEASE-PROMPT.md` §§2–3 and the Act you are in. Skip Act I entirely.
