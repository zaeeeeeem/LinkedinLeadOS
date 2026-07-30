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
Chrome. Failures split transient-vs-fatal on whether a retry could change the outcome (D13);
port 9222 is refused before any I/O. Reviewed 2026-08-08 — binary-missing reclassified fatal and
an early-`exit` listener added. Proven: 21/21 tests pass offline (16 new, fake `/json/version`
server), typecheck clean; live cold start returned `{"port":9223,"wsUrl":"ws://127.0.0.1:9223/
devtools/browser/259ef368-…","launched":true}` with no dialog, an immediate second call returned
the same URL with `"launched":false`, and launching against an in-use profile failed in 272ms with
`CHROME_LAUNCH_FAILED` naming the holding profile instead of burning the 30s timeout.

Task 3 — CDP transport client. `src/core/cdp/{constants,client}.ts`: `CdpClient.connect(url, opts)`
→ `send(method, params, sessionId?, timeoutMs?)`, `on()`/`off()` event fan-out preserving
`sessionId`, `dead` flag, idempotent `close()`, and a keepalive that stays silent while traffic
flows. Transport only — it enables no CDP domain, ever; callers decide (D8). Every failure is
transient with the raw CDP error kept as `evidence` (D15). Proven: 36/36 tests pass offline
(15 new, fake CDP server on the dev-only `ws` package), typecheck clean; live against the
automation Chrome, `Browser.getVersion` round-tripped in 7ms returning `Chrome/151.0.7922.76`
protocol 1.3, an unknown method mapped to `CDP_PROTOCOL_ERROR` without killing the connection,
and `dead` was true after `close()`.

Task 6 — event logger and run context (Tasks 4/5 were being built in parallel worktrees;
see their own entries for status when merged, not restated here). `src/core/run/
{events,paths,context}.ts`: `EventLogger` appends NDJSON synchronously over a held fd
(closed set of event names, seq continuing past resumes); `RunContext.open()` mints a
ULID run and `raw/`/`shots/` dirs on create, or reuses the directory and appends a
`resumed_at` timestamp + logs `checkpoint.resume` on resume; rejects an unknown run id as
`RUN_NOT_FOUND` and a capability swap as `RUN_CAPABILITY_MISMATCH` (both exit 1);
`checkpoint()`/`lastCheckpoint()` round-trip arbitrary state via atomic tmp+rename with
latest-wins (D16); `screenshot()` writes zero-padded, collision-free names under
`shots/`; `artifacts()` matches spec §5's `runs/<id>/events.ndjson` / `runs/<id>/raw/`
shape; `finish()` writes `summary.json` and is idempotent. Proven: 58/58 tests pass
offline (22 new, all in `fs.mkdtempSync` temp dirs), typecheck clean.

## In progress
_(nothing)_

## Next
Task 7 — archive shape hash (`docs/plans/m1-m3/tasks/task-07-archive-shape-hash.md`)
