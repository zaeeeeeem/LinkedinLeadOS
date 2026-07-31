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

Revised 2026-08-08 after review, one exception: a client the caller closed itself
(`CDP_CLIENT_CLOSED`) is `HALT_AND_NOTIFY` / exit 1 / `retryable: false`. This is the one
death cause the transport is certain about — it caused it — and `retryable` is what callers
branch on, so leaving it true would spin a back-off loop against a condition that cannot
change. Remote death stays transient and keeps its own codes (`CDP_CONNECTION_CLOSED` for a
close frame, `CDP_SOCKET_ERROR` for an abrupt drop); a shared code with a differing
`retryable` would reintroduce exactly the ambiguity the split removes.

Rejected: a fatal class for protocol errors. A transport that halts the run on a reply it
cannot interpret makes the whole toolkit brittle to Chrome-version wording. `evidence`
carrying the untouched CDP error is what lets a caller split it later without the transport
inventing a taxonomy.

Also settled here: `ws` is a **dev dependency only**, used to run the fake CDP server in
tests. Production code uses Node's built-in `WebSocket` (D7 — no CDP wrapper library ever
touches the real account's socket).

## D16 — The tab lease trusts pid liveness, but only on its own host, and never a clock
2026-08-08, revised 2026-08-08 after review. `tab-lease` decides reclaimability from
`process.kill(pid, 0)` alone. A record written on a different `hostname()` is refused
outright rather than reclaimed: asking this machine about a foreign pid answers a different
question, and a wrong answer preempts a live run driving the tab — the exact thing §8 exists
to prevent.

Rejected: a TTL / max-lease-age, the usual staleness heuristic (`proper-lockfile` uses mtime
plus a heartbeat). Any age-based rule preempts a holder that is merely slow, and the
constraint is absolute — a live holder is never preempted. A long capability run is normal
here, so the heuristic would fire on the healthy case. The cost of that choice is pid reuse:
a crashed run whose pid is recycled by an unrelated process wedges the tab forever. The
remedy is an explicit operator action, not a timer — Task 12's CLI carries a
`--force-release` alongside a lease inspection, so the escape hatch is discoverable instead
of being tribal knowledge.

**Reclaim is a filesystem proof, not a timing heuristic.** Taking a reclaimable lease is:
`rename(lock, quarantine-unique)` → confirm the quarantined bytes are still the exact bytes
that were judged reclaimable → `open(lock, "wx")`. Of several processes that judged the same
lease reclaimable, exactly one renames the original inode away; a loser either finds nothing
to rename, or quarantines a record that is not the one it judged — in which case it renames
that record straight back, untouched, and refuses.

Rejected, and the reason this entry was revised: replacing the lock with a `rename` and
confirming by reading it back after a settle delay. The delay bounds nothing. A racer's write
can land *after* an earlier racer's read-back has already returned — 50ms of ordinary
scheduling is enough — and then both processes believe they hold the lease and both drive the
tab. Randomizing the delay decorrelates racers that collide in lockstep; it does not bound
how late a separate process's write arrives. `tests/tab-lease.test.ts` stages that
interleaving directly and it fails against the settle version.

Also rejected earlier, and wrongly: unlink-then-exclusive-create, on the grounds that the
window with no lock lets a fresh acquirer in. It does, and that is harmless — an absent lock
is claimable, which is the correct state for a stale lease, and the reclaimer's own `wx` then
fails `EEXIST` and it refuses. One winner either way. The real hazard on that path is two
reclaimers where the second's unlink deletes the first's fresh lock, which is what the
content-checked quarantine rename closes.

Also settled: an unwritable lease path (`EACCES`, `EROFS`, `ENOTDIR`, `ENOSPC`) is fatal
`TAB_LEASE_UNWRITABLE` / `HALT_AND_NOTIFY` / exit 1, not transient. Per D13 the question is
"will a retry change this?" — a read-only directory answers no. Only contention is transient.

## D17 — The session layer polls for page readiness, and re-classifies nothing it did not cause
2026-08-08. Two choices the task file left open, both of which a later session would
otherwise re-open.

**Navigation completion is polled, not awaited.** `navigate()` sends `Page.navigate` and
then polls `document.readyState` every 100ms until `"complete"`. The obvious alternative —
`Page.enable` and await `Page.loadEventFired` — is forbidden by D8, and the cost of the
polling version is one cheap `Runtime.evaluate` per 100ms against a local socket. Evaluation
failures during the poll are treated as "not ready yet", never as an error: the execution
context is genuinely torn down and rebuilt mid-navigation, so an error there is the expected
observation, not a fault. The same reasoning covers screenshots (`Page.captureScreenshot`
needs no enable) and evaluation (`Runtime.evaluate` needs no `Runtime.enable`, which is the
`consoleAPICalled` leak). Nothing above this layer consumes a `Page` or `Runtime` event, so
the domains stay off.

**A `CapabilityError` passes through this layer untouched.** The launcher classified its
failures with knowledge of the environment (D13) and the transport classified its own with
knowledge of the socket (D15); re-coding either here would throw away a decision made with
more context and would, for instance, turn `CDP_CLIENT_CLOSED`'s `retryable: false` back
into a spin. The session layer only invents a code for a failure it is the first to see: a
command that *succeeded* at the protocol level while carrying a failure payload
(`Runtime.evaluate` with `exceptionDetails` → `TAB_EVAL_FAILED`, `Page.navigate` with
`errorText` → `TAB_NAVIGATE_FAILED`), a tab that detached underneath it (`TAB_DETACHED`),
or a non-CDP failure of its own such as an unwritable screenshot path
(`TAB_SCREENSHOT_UNWRITABLE`, fatal per D13's question). That is what "no raw CDP errors
escape to capabilities" means here — a resolved-but-failed reply is exactly the shape that
would otherwise reach a capability as a silent `undefined`.

## D18 — Each task reserves a decision-number range up front
2026-08-08. Decision numbers are allocated to a task **before** it starts, ten at a time:
task N owns `D(10 × (N − 4))` through `D(10 × (N − 4) + 9)`. Task 6 owns D20–D29, Task 7
owns D30–D39, Task 8 D40–D49, and so on. D19 is spare. A task writes only into its own
range, so two worktrees never append the same line of this file.

Rejected: renumbering at merge, which is what we had been doing implicitly. Parallel
worktrees all branch from the same tip, all read the same "last used" number, and all claim
the next one — Tasks 5, 6 and 7 each independently wrote a `D16`. The cost is not the
renumber itself but everything downstream of it: the merging branch's commit body, its
`STATE.md` line, and any cross-reference from another decision all still name the old
number, and nothing catches a stale reference. Append-only files with sequential ids do not
survive concurrent authors; reservation is the cheapest thing that makes them survive.

Rejected: per-task decision files with `DECISIONS.md` as an index. Structurally
conflict-free and needs no bookkeeping, but it gives up the property D12 and `CLAUDE.md`
both lean on — that a decision made on turn 6 is still visible by scrolling one file on
turn 400. Findability is the whole point of the file.

Rejected: serializing the merges. It removes the collision at its source but gives up the
parallelism the worktrees exist for, which costs more than the gaps this scheme leaves.

Accepted cost: numbers are no longer chronological, and a task using fewer than ten
decisions leaves visible gaps. A gap is not a missing decision.

## D20 — Checkpoint state lives in `checkpoint.json`, not replayed from `checkpoint.save` events
2026-08-08. `RunContext.checkpoint()` writes the full state to `checkpoint.json` (atomic
tmp+rename, latest write wins) and logs a `checkpoint.save` event as a breadcrumb only —
the event carries no state, `lastCheckpoint()` never reads the event log.

Rejected: treating the last `checkpoint.save` event as the source of truth and putting the
state in its `detail`. That would make resume an O(events-in-run) linear scan of a file
that is also the forensic log, and it would force every event line to be large enough to
hold arbitrary pagination state instead of a few fixed fields — the NDJSON shape in spec §5
stops being uniform. A dedicated file makes "what do I resume from" an O(1) read
independent of how long the run has been running.

## D21 — The event log is written with synchronous appends
2026-08-08 (already implemented in `events.ts`; recorded here because Task 6 is what makes
the trade-off visible end to end). `EventLogger.log()` calls `writeSync` on a held fd, once
per event, no batching.

Rejected: a buffered async writer flushing on an interval or on `n` events. The event log
exists specifically to explain a run that died mid-invocation — a challenge, a crash, an
operator kill. A buffered writer loses exactly the events written in the last flush window,
which are the ones adjacent to the death and therefore the most diagnostic. Synchronous
per-event writes cost a syscall per event, which is acceptable because event volume is
bounded by page loads and CDP round-trips, not by anything hot.

## D22 — Resuming a nonexistent run id is a usage error, not a create
2026-08-08. `RunContext.open({ runId })` throws `RUN_NOT_FOUND` (`HALT_AND_NOTIFY`, exit 1)
when the directory for that id does not exist, rather than creating it and proceeding as a
fresh run.

Rejected: silent create-on-resume. A run id reaching `open()` almost always came from a
prior receipt or a `--run-id` flag typed by an agent continuing earlier work; silently
starting a new, empty run under that id would make the agent believe it resumed a
checkpoint that was never written, and the two calls would produce a directory whose
`run.json.created_at` lies about when the run actually started. A missing id is either a
typo or a deleted archive — both are for a human or a higher-level caller to resolve, not
for the run context to paper over.

## D23 — A corrupt local archive file is a usage-class halt, never parse drift
2026-08-08. A truncated or unparseable `run.json` / `checkpoint.json` raises
`RUN_META_CORRUPT` / `RUN_CHECKPOINT_CORRUPT` as `HALT_AND_NOTIFY` / exit 1, with the
underlying parse message on `evidence`.

Rejected: `EXIT.PARSE_DRIFT` (5). That code has one meaning for the agent — LinkedIn changed
a response shape, go re-derive a parser against fixtures. Pointing it at our own file
integrity would send the agent to the parsers over a half-written local file that no parser
change can fix, and it would poison `log:drift`, whose entire job is counting real shape
changes.

Rejected: a retryable class. The file is on the local disk and will read back identically
forever; the only thing that resolves it is a human deciding whether to repair the run
directory or abandon the id.
