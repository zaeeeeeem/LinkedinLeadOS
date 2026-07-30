# DECISIONS

Why X over Y. Dated, append-only.

## D1 — Network tap is the source of truth; DOM is for navigation only
2026-08-07. Data fields come only from captured Voyager / `salesApi*` response bodies, never
from parsed HTML. DOM reads are for click targets, pagination state, challenge detection, and
render confirmation only. See `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D2 — Raw-first storage
2026-08-07. Every capture archives the untouched response body before any parsing; a wrong
parser is fixed by re-parsing history, never by re-scraping. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D3 — Receipt on stdout, data in the store
2026-08-07. Capability stdout is a fixed-size envelope regardless of result size; bulk data
goes to Supabase and the run archive. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D4 — Agent reads bulk data straight from Supabase
2026-08-07. No read-command wrapper layer; the agent runs SQL directly. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D5 — Structured NDJSON logs plus bounded query capabilities
2026-08-07. Logs are machine-readable event streams; the agent calls bounded query
capabilities instead of reading whole log files. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D6 — `HALT_AND_NOTIFY` exits non-zero and stops
2026-08-07. No desktop notification, no Slack, no file drop — the agent surfaces the non-zero
exit and receipt to the operator and does not proceed. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D7 — Playwright is not used against the production account
2026-08-07. Raw CDP only on the tab driving the real account; Playwright's `connectOverCDP`
enables an attach surface this design deliberately avoids. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D8 — Minimal CDP attach surface
2026-08-07. Enable `Network` only — never `Runtime.enable` (the `consoleAPICalled` detection
leak) or `Page.enable` (unneeded). See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D9 — Dedicated Chrome profile launched with `--remote-debugging-port`
2026-08-07. Automation Chrome runs on its own profile and port 9223, launched by the toolkit,
never attached via `chrome://inspect`; discovery goes through `GET /json/version`. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D10 — One resident worker tab, navigated between targets
2026-08-07. A single background-created tab is reused and navigated between targets for the
whole session, closed at session end. See
`docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`.

## D11 — The budget ledger is file-backed, never database-backed
2026-08-07. The ledger is the safety mechanism that protects a single unburnable
account. It must work when Supabase is down, when Docker is not running, and
before storage exists at all. It lives at `runs/budget.ndjson`, append-only.
Rejected: the `budget_ledger` Supabase table as the source of truth — a safety
check that depends on an external service can fail open, which is the one failure
mode that is unacceptable here. The table may later mirror the file for reporting.

## D12 — Plans state outcomes and constraints, never implementations
2026-08-08. The first M1–M3 plan (`docs/plans/2026-08-07-m1-m3-core-storage-profile.md`)
wrote out full code, pinned dependency versions, and invented exported names. Executing
it produced drift and hallucination: the plan's guesses diverged from reality and the
implementing agent transcribed instead of thinking. Replaced by `docs/plans/m1-m3/` —
one outcome-driven file per task, a shared always-read context pack, and a shared
recording contract. Cross-task interfaces come from the actual source on disk, never
from plan text. Implementation agents design with fresh context; minor improvements are
theirs to make and note, major deviations (new runtime dependency, interface change,
anything touching the attach surface or safety model) require operator approval first.

## D13 — Launcher failures split on "will a retry change this?", not on severity
2026-08-08, revised 2026-08-08 after review. `chrome-launcher` raises two error classes.

**Transient / `RETRY_BACKOFF` / exit 6 — the endpoint is not answering *yet*:*
`CHROME_UNREACHABLE`, `CHROME_DISCOVERY_MALFORMED`, `CHROME_LAUNCH_TIMEOUT`. Callers back
off without special-casing the module.

**Fatal / `HALT_AND_NOTIFY` / exit 1 — the environment is wrong and only a human can fix
it:** `CHROME_FORBIDDEN_PORT` (a request pointing at the operator's personal logged-in
Chrome), `CHROME_BINARY_MISSING` (a path that will never materialize), and
`CHROME_LAUNCH_FAILED` (spawn failed, or Chrome exited without opening the port — usually
another instance already holding the user-data-dir).

Rejected: one uniform transient class. A caller that backs off against a wrong binary
path or the wrong port retries forever against a condition that cannot change, and for
the 9222 case succeeding would be strictly worse than failing. The port guard sits in
`assertNotPersonalChrome` and runs before any I/O in both discovery and the launcher.

Accepted limitation: on the reuse path the launcher attaches to whatever serves CDP on
the port without proving it is our profile — `/json/version` does not expose the
user-data-dir, so there is no cheap check. 9223 is ours by convention enforced at launch,
not by proof; the unconditional 9222 guard is what keeps the dangerous mistake
unreachable.

## D14 — The launched Chrome carries only the four flags D9 verified
2026-08-08. `chromeLaunchArgs` emits exactly `--remote-debugging-port`, `--user-data-dir`,
`--no-first-run`, `--no-default-browser-check`. Rejected: the usual automation flag pile
(`--disable-*`, window sizing, `--restore-last-session`). Each extra flag is a
fingerprint change on an account that cannot be burned, and the four-flag launch is the
combination verified dialog-free on Chrome 151. Adding a flag is a design decision, not a
convenience.

## D15 — The CDP transport reports every failure as transient, and preserves the cause
2026-08-08. `CdpClient` maps connect failure, connect timeout, command timeout, protocol
`error` replies, and connection death all to `RETRY_BACKOFF` / exit 6, and puts the raw CDP
error object on the receipt's `evidence`.

This does not contradict D13, it is where D13's question gets answered. D13 splits on "will a
retry change this?" — the launcher can answer that, because it knows a missing binary from a
slow start. A transport cannot: `-32601 method not found` and "Cannot find context with
specified id" arrive down the same pipe, and the second one clears on its own. Classifying
JSON-RPC codes inside the transport would be guessing on behalf of a caller that has the
context to decide properly.

Rejected: a fatal class for protocol errors. A transport that halts the run on a reply it
cannot interpret makes the whole toolkit brittle to Chrome-version wording. `evidence`
carrying the untouched CDP error is what lets a caller split it later without the transport
inventing a taxonomy.

Also settled here: `ws` is a **dev dependency only**, used to run the fake CDP server in
tests. Production code uses Node's built-in `WebSocket` (D7 — no CDP wrapper library ever
touches the real account's socket).

## D16 — The tab lease trusts pid liveness, but only on its own host, and never a clock
2026-08-08. `tab-lease` decides reclaimability from `process.kill(pid, 0)` alone. A record
written on a different `hostname()` is refused outright rather than reclaimed: asking this
machine about a foreign pid answers a different question, and a wrong answer preempts a live
run driving the tab — the exact thing §8 exists to prevent.

Rejected: a TTL / max-lease-age, the usual staleness heuristic (`proper-lockfile` uses mtime
plus a heartbeat). Any age-based rule preempts a holder that is merely slow, and the task's
constraint is absolute — a live holder is never preempted. A long capability run is normal
here, so the heuristic would fire on the healthy case.

Rejected: unlink-then-exclusive-create for reclaim. It leaves a window where the lock is
absent, during which an unrelated fresh acquirer takes it through the create path and holds it
alongside the reclaimer. Reclaim replaces the file with `rename`, which is atomic and never
absent, and is then confirmed by a settle-and-read-back: several processes may all judge the
same dead lease reclaimable, they all write, and the read-back leaves exactly one believing it
holds the lease. Accepted residual: the settle window (40–80ms, randomized) is a heuristic, not
a proof. It is bounded by the real exposure — one operator, one machine, capabilities that
start seconds apart — and the dangerous case, preempting a live holder, is closed by the pid
check regardless.

Also settled: an unwritable lease path (`EACCES`, `EROFS`, `ENOTDIR`, `ENOSPC`) is fatal
`TAB_LEASE_UNWRITABLE` / `HALT_AND_NOTIFY` / exit 1, not transient. Per D13 the question is
"will a retry change this?" — a read-only directory answers no. Only contention is transient.
