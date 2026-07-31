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

Task 7 — raw archive and structural shape hashing. `src/core/archive/shape.ts` (pre-existing):
`canonicalShape`/`shapeHash`/`shapeHashOfBody`/`NON_JSON_SHAPE`. `src/core/archive/raw.ts`
(new): `RawArchive` over a plain directory string — `archive(input)` gzips the body, writes it
first as `<seq>-<shapeHash>.json.gz` with metadata beside it in a `.meta.json` sidecar (D16),
then `list()`, `read()`, `readText()`. `seq` seeds from the directory so a resumed run keeps
numbering; writes claim their filename with `wx` so two instances over one directory can't
clobber each other. Errors are `ARCHIVE_WRITE_FAILED` / `ARCHIVE_ENTRY_MISSING`, both
`HALT_AND_NOTIFY`/non-retryable, via the shared `CapabilityError`. No Task 6 event logging
yet — Task 6 isn't on main; Task 9's network tap is the natural place to emit
`capture.hit`/`capture.miss`. Proven: 27 new tests pass offline (63/63 on this branch, which forked before Task 3's
review added five; 16 in
`tests/archive-shape.test.ts` pinning every shape-hash rule, 11 in `tests/archive-raw.test.ts`
covering gzip-on-disk, byte-identical read-back of string/`Uint8Array`/emoji bodies,
no-dedupe on identical shapes, `list()` metadata and empty/missing-directory cases,
seed-from-disk resume, and `ARCHIVE_ENTRY_MISSING` on an unknown id), all in `mkdtemp` temp
dirs cleaned up per test; typecheck clean.

## In progress
_(nothing)_

## Next
Task 4 — session and worker tab (`docs/plans/m1-m3/tasks/task-04-session-worker-tab.md`)
