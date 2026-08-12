---
name: recover-session
description: Use when something went wrong — a capability exited non-zero, a challenge or captcha appeared, budget is exhausted, CDP won't connect, parsers report drift, a run died mid-flight, or the tab lease is wedged. Keyed by symptom.
---

# Recover a Broken Session

**Read the `linkedin-session` skill first.** The recurring theme: the evidence is already
on disk — receipts, `runs/<id>/events.ndjson`, raw archives, the budget ledger. Diagnose
from those (free) before spending a single new page load to "see if it works now".

## First moves, always free

```sh
npm run cap -- log.runs --since=24h          # what ran, what status
npm run cap -- log.errors --run=<id>         # the warn/error events of one run
npm run cap -- log.why --run=<id> --item=<ref>   # one item's full story
npm run cap -- log.drift --since=7d          # which parsers are decaying, by field
npm run cap -- health.check                  # zero-cost full-stack diagnosis + budget state
```

`log.runs` status `incomplete` = no summary yet (still running, or died mid-flight);
`log.errors` on it tells which.

## By symptom

**Exit 2 — challenge.** Screenshot + checkpoint already saved in the run dir. Stop the
whole session — every capability, not just the failed one. Hand the operator the
screenshot path. Never solve, never retry, never reload "to check if it cleared". Paged
runs stay resumable after the operator clears it.

**Exit 3 — rate-limited / exit 4 — auth dead.** Full stop. No probes. For 4, the operator
logs in manually on the automation profile (`~/.linkedin-os/chrome-profile`); `health.check`
(free) confirms `login.logged_in` afterwards.

**Exit 5 — parse drift.** LinkedIn changed shape; the untouched body/snapshot is in
`runs/<id>/raw/`, named in the receipt's evidence. The fix is **entirely offline**: reread
the archive, adjust the parser in `src/capabilities/<name>/parse.ts`, prove it against
fixtures (`npm test`), zero live requests. Promote new fixtures via
`npm run fixtures:promote` — inbox/thread fixtures only ever to `.fixtures-private/`.
`log.drift` says whether it's one field decaying (tolerable warning) or a surface break.

**Exit 6 — transient.** One retry. A second failure is a real failure — diagnose, don't
loop.

**Exit 7 — budget.** The receipt's evidence names the scope: `"global"` (the shared
60/hr–400/day–50 searches–120 profiles window) or `"capability"` (that reader's own daily
sub-cap). Compute when the window frees from `health.check`'s `data.budget` and wait or
re-plan the day around cheaper reads. **Never** edit `src/core/budget/constants.ts`, and a
cap raise exists only as a fresh dated operator grant in DECISIONS.md.

**`TAB_LEASE_HELD` / wedged lease.** Another run holds the worker tab. If `log.runs` shows
it crashed: `npm run cap -- health.check --force-release` — the evicted holder lands on the
receipt. Don't force-release a run that's genuinely still running.

**CDP won't connect.** In order: is Chrome running on the automation profile? Discover via
`GET http://127.0.0.1:9223/json/version`, use its `webSocketDebuggerUrl` (Chrome 151
rejects the hardcoded `/devtools/browser` path; `DevToolsActivePort` file is unreliable).
Claude Code's Bash sandbox blocks loopback — disable sandbox for that call. Port 9222 is
the operator's personal Chrome: never attach, its HTTP endpoints 404 by design.

**Run died mid-flight (crash, Ctrl-C, power).** Nothing is lost that mattered: spend was
recorded *before* navigation (ledger over-counts, never under-counts), raw bodies were
archived before parsing, paged runs checkpoint per page. Resume paged reads with
`--run-id=<id>` — resume corroborates archives on disk and refuses rather than guessing;
a refusal to resume is the system protecting result-set integrity, not a bug to fight.

**Worktree hazards.** Never `git add -A` in a worktree — it commits the `runs/` symlink
and the merge destroys main's raw archives and ledger (it happened; see D-log 2026-08-12).

## What recovery never includes

- Solving a challenge, or timing retries to dodge one.
- Bypassing or hand-editing the ledger.
- "Testing" a fix with live loads when a fixture can prove it offline.
- Deleting run archives to make a symptom disappear — they are the only copy of the
  evidence.

If the playbook doesn't cover it, write what you observed into STATE.md, stop spending,
and put it to the operator with run ids. An unexplained anomaly on this account is an
operator decision by default.
