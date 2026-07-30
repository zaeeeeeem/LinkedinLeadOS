# STATE

Updated at every task commit. Trust this over CLAUDE.md's phase line.

**The active plan is `docs/plans/m1-m3/`** (outcome-driven, one file per task; see D12).
The 2026-08-07 plan file is superseded — do not execute from it.

## Built
Task 1 — project scaffold and receipt contract (commits 1394d12, c2bea6f).
Reviewed 2026-08-08: `npx tsc --noEmit` clean, 4/4 tests pass.

Task 2 — Chrome launcher and endpoint discovery. `src/core/chrome/{constants,discovery,launcher}.ts`:
`AUTOMATION_PORT` 9223, `CHROME_PROFILE_DIR`, `discoverBrowserWsUrl` / `isChromeUp` over
`GET /json/version`, `ensureChrome()` → `{ port, wsUrl, launched }` reusing or detached-launching
Chrome. Port 9222 is refused before any I/O (D13). Proven 2026-08-08: 20/20 tests pass offline
(15 new, fake `/json/version` server), typecheck clean; live cold start returned
`{"port":9223,"wsUrl":"ws://127.0.0.1:9223/devtools/browser/89d7a6af-…","launched":true}` with no
dialog, and an immediate second call returned the same URL with `"launched":false`.

## In progress
_(nothing)_

## Next
Task 3 — CDP transport client (`docs/plans/m1-m3/tasks/task-03-cdp-client.md`, Opus)
