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
transient with the raw CDP error kept as `evidence`, except a locally-closed client, which is
fatal and non-retryable (D15). Reviewed 2026-08-08 — local close split from remote close on
both code and `retryable`, a socket-`error` handler added so death detection no longer rests on
Node emitting `close` afterwards, and undispatchable frames now surface through
`onListenerError` (shape only, never the body) instead of vanishing. Proven: 41/41 tests pass
offline (20 new, fake CDP server on the dev-only `ws` package), typecheck clean; live against
the automation Chrome, `Browser.getVersion` round-tripped in 7ms returning
`Chrome/151.0.7922.76` protocol 1.3, an unknown method mapped to `CDP_PROTOCOL_ERROR` without
killing the connection, and a send after `close()` returned
`CDP_CLIENT_CLOSED` / `retryable: false` / exit 1.

Task 5 — single-holder tab lease. `src/core/lease/{constants,tab-lease}.ts`:
`acquireLease({runId, capability, path?})` / `releaseLease({runId, path?})` / `inspectLease(path?)`
over a lockfile at `runs/tab.lock` carrying run_id, pid, host, capability and acquired_at (§8, D10).
A free lease is claimed with exclusive create; a reclaimable one is taken by renaming it to a
unique quarantine name, confirming the bytes are still the ones judged reclaimable, then claiming
with `wx` — so exactly one of several racers wins by filesystem semantics rather than by timing
(D16, revised after review: the first version used a settle-and-read-back that let two reclaimers
both hold the lease). Live holders are never preempted, same run id is re-entrant and keeps its
original acquired_at, dead-pid and corrupt files are reclaimable, another host's lease is refused
rather than judged by local pid, and a crashed acquire's scratch files are swept. Refusal is
transient `TAB_LEASE_HELD` / `RETRY_BACKOFF` / exit 6 with `retry_after_ms`; an unwritable lease
path is fatal `TAB_LEASE_UNWRITABLE` / exit 1 (D13's question). Proven: 64/64 tests pass offline
(28 new; dead pids taken from exited child processes, four real racing processes on one lockfile,
and the two-reclaimers interleaving staged directly — that last one fails against the settle
version, verified), five consecutive full runs with no flake, typecheck clean. No live check —
the lease touches no browser and no network by design.

Task 4 — browser session and worker tab. `src/core/session/{constants,session,tab}.ts`:
`BrowserSession.open()` (ensureChrome + CdpClient.connect) → `listPageTargets()`,
`openWorkerTab()`, `close()`; `WorkerTab` with session-scoped `send`, `evaluate`, `navigate`,
`currentUrl`, `screenshot`, `ensureForeground`, `close`. Attach enables `Network` and nothing
else, ever (D8), and asserts focus emulation before anything can render (D10); foregrounding
escalates emulation → web-lifecycle → `Target.activateTarget`, that last one strictly last
because it steals the operator's window. Readiness is polled instead of awaiting `Page`
events, and errors already classified by the launcher or the transport pass through unchanged
(D17). Teardown drops emulation, closes the tab, closes the socket, and never throws past
itself. Proven: 12 offline tests against a recording CDP double pin the attach surface and
the escalation order (added beyond the task file, which asked for none — those two are safety
properties a passing live check cannot see); 81/81 tests pass, typecheck clean. Live against
the automation Chrome: worker tab created in the background, `https://example.com/` read back
with title `Example Domain`, foreground reached at `via: "already"` without touching
`activateTarget`, a 41,550-byte screenshot written, and a fresh reconnect saw the target count
back at its starting value. A second live probe confirmed emulation is load-bearing — with it
`hidden: false`, with it dropped `hidden: true`, and `ensureForeground` recovered at step one.

## In progress
_(nothing)_

## Next
Task 6 — events and run context (`docs/plans/m1-m3/tasks/task-06-events-run-context.md`)
