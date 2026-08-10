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

**Revised 2026-08-08 after review**, one exception, and it is D15's exception one layer up: a
tab this session closed itself raises `TAB_CLOSED` as `HALT_AND_NOTIFY` / exit 1 /
`retryable: false`. The original entry made it transient, which reintroduced exactly the trap
`891cbea` removed from the transport — `retryable` is what callers branch on, so a back-off
loop above a deliberately closed tab spins against a condition that can never change. A tab
that detached on its own keeps its own code, `TAB_DETACHED`, and stays transient, because a
crashed or navigated-away tab genuinely can come back on a fresh attach. Separate codes rather
than one code with a differing `retryable`, per the same convention.

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

## D30 — Shape hash covers structure only, and archives use a sidecar over an index
2026-08-08. Two parts, one commit. (Written as `D16` on the Task 7 branch, which forked
before D18 reserved a range per task; renumbered into Task 7's D30–D39 range at merge.)

**Shape hashing.** `canonicalShape` reduces a JSON value to key paths and value *types*,
never values: object keys sorted so key order is irrelevant; adding/removing a key changes
the hash; a value changing type changes the hash; an array collapses to the sorted set of
its *distinct* element shapes, so a 1-item and a 100-item list of the same element shape
hash identically and element order within a heterogeneous array does not matter; `null` is
its own type, distinct from a string, a number, or a missing key; `[]` is its own shape,
distinct from `[num]`. This is deliberate under-discrimination: two responses describing
different people with the same fields collide on purpose, because the point is grouping
captures by structure for fixture promotion and drift detection, not fingerprinting content.
A non-JSON body (HTML error page, redirect stub) is not an error — it archives fine under a
single fixed non-JSON shape rather than throwing.

**Archive layout: sidecar metadata, not an index file.** Each capture is
`<seq>-<shapeHash>.json.gz` (the gzipped body) plus `<seq>-<shapeHash>.meta.json` (url,
status, method, capturedAt, uncompressed byte count) written beside it. `list()` scans the
directory for `*.json.gz` and attaches the sidecar when present. Rejected: a single
`index.ndjson` appended to after each write. A crash between the body write and the index
append makes an archived body invisible to every later step (fixture promotion, receipts,
retries) — exactly the failure raw-first storage (D2) exists to prevent. The sidecar layout
fails the other way: the body write happens first and is always enumerable by directory
listing; only its metadata can go missing, and a missing sidecar still yields a listable
entry with just a thinner record. `seq` is an instance counter seeded lazily by scanning the
directory for the highest existing sequence number, so a resumed run over the same directory
continues numbering instead of restarting at 0; each write claims its filename with the `wx`
(exclusive-create) flag and moves to the next `seq` on `EEXIST`, so two `RawArchive`
instances racing over one directory cannot clobber each other's body.

## D31 — Archive failure classes split three ways, and a lost sidecar is a warning
2026-08-08 (Task 7 follow-up, written during Task 8). Three findings from the Task 7
review, resolved together.

**A failed sidecar write no longer halts the run.** `archive()` returns the
`ArchivedCapture` with `warning: { code: "ARCHIVE_SIDECAR_FAILED", … }` instead of
throwing. D30 chose the sidecar layout precisely so that the survivable failure is the
metadata one and the body is always on disk and always enumerable — throwing
`ARCHIVE_WRITE_FAILED` / `HALT_AND_NOTIFY` at that exact moment threw the advantage away
and reported the degraded case identically to a lost capture. Worse, the message did not
say the body had survived, so the receipt sent its reader hunting for a file already
sitting on disk. The warning message now states that the body is archived and readable.
Rejected: keeping the halt with a better message. The message was the smaller half of the
problem — a run that stops over a missing `.meta.json` has stopped over nothing that
re-parsing cannot reconstruct.

**Read failures are their own code.** `ARCHIVE_WRITE_FAILED` (never reached disk) ·
`ARCHIVE_READ_FAILED` (`readFile`/`readdir` failed) · `ARCHIVE_CORRUPT` (on disk and
readable but not valid gzip). Receipts and `log:why` group by code (D5), so folding a
corrupt-archive read into the write bucket permanently miscounts how runs fail, and the
three point at three different fixes: disk full, permissions, and a damaged file.

**The shape hash stays computed before the body is written, and D2's ordering stands.**
The filename embeds the hash, so the hash must exist first. This is not the inversion of
raw-first it looks like: the body is fully buffered in memory before hashing,
`shapeHashOfBody` is total (a non-JSON body returns `NON_JSON_SHAPE` rather than
throwing), and the only failure the ordering could introduce is an OOM on a pathological
body — which no ordering survives and which `NETWORK_RESOURCE_BUFFER_BYTES` caps at 20MB
upstream. Rejected: writing under a seq-only name and renaming once the hash is known.
It matches the rule more literally and buys nothing real, and it breaks the property that
makes concurrent writers safe — the `wx` claim is currently on the final filename, so a
rename step reopens the seq for a second instance to claim between the claim and the
rename.

## D40 — Wheel notches are planned so the total lands exactly on the request
2026-08-08. `HumanCursor.wheel` shortens the *current* notch when the remainder would
otherwise fall below one notch, so every notch stays inside the 40–120px human band and
the dispatched deltas sum exactly to the requested distance.

The reference worker (`engine/cdp.mjs`) instead rounded the final leftover **up** to the
40px minimum, overshooting the request by up to 39px. That was the right call against the
alternative it was weighing — a 6px wheel event is a giveaway twitch — but it is not the
only way to avoid one, and the overshoot is not free here: a caller scrolling by a
measured remainder (a pagination boundary, a distance to a known element) gets a page
scrolled past where it asked, and cannot tell without reading the return value.

The one ask that cannot satisfy both properties is one smaller than a single notch. There
the notch wins, exactly as the reference decided, and `WheelResult.scrolled` reports the
real distance rather than echoing the request — so the truth is on the return value in the
one case where it differs, instead of in every case.

## D41 — Randomness and the clock are injectable seams in the human-input layer
2026-08-08. `HumanCursor` takes optional `rng` and `sleep`, defaulting to `Math.random`
and a real timer. Nothing in production ever passes them; the tests always do.

This layer's correctness is entirely statistical — a path that bows only one way, a
cadence that is secretly constant, an overshoot that never fires — and all of those look
perfectly fine in a test that asserts the pointer ended up on the target. Injecting the
seams is what makes them assertable: 300 paths in milliseconds instead of 300 real
`setTimeout`s, and a forced branch instead of waiting for a 20% probability.

Rejected: `vi.useFakeTimers()`. It fakes the clock but not the randomness, so the branch
tests would still be probabilistic, and it makes every test in the file depend on timer
mocking working correctly with `async` code — a failure mode with nothing to do with the
behaviour under test. Rejected: a module-level seeded PRNG swapped by an env var. Same
result, but the seam becomes global state two tests can fight over.

Consequence worth stating: `sleep` is a real seam, not a formality. A caller that passes a
no-op `sleep` in production would strip every pacing delay while leaving the paths intact,
which is the one way to misuse this class badly. Only tests pass it.

## D50 — `waitFor` waits for the *next* capture, and takes a cursor to look further back
2026-08-08. `NetworkTap.waitFor(pattern, { since })` resolves on the first matching capture
whose tap-local `seq` is at or past `since`, which defaults to the tap's current `cursor`.
Callers that need the response caused by an action they are about to take snapshot
`tap.cursor` first and pass it.

The race is real and it is the default failure mode of the naive API: a click causes a
fetch, the response and its `loadingFinished` can both land before the awaiting code runs,
and a `waitFor` that only looks forward then burns its whole timeout waiting for a capture
that already happened. That failure presents as "LinkedIn did not respond", which sends the
operator to the browser instead of to the code.

Rejected: resolving from the whole history by default. It makes the common case work and the
loop case silently wrong — a paginated crawl would re-resolve page 2's wait with page 1's
capture forever, and every row after the first would be a duplicate the parser cannot tell
from a real one. Rejected: consuming captures (each one resolves at most one waiter). Two
capabilities legitimately watch overlapping patterns over the same traffic, and a consumed
capture makes which one wins depend on registration order.

## D51 — A lost body is a recorded miss; it never throws and never fails a pending wait
2026-08-08. `Network.getResponseBody` failing (an evicted buffer), `Network.loadingFailed`,
and an archive write failing all append to `misses()` and log `capture.miss`. Nothing is
thrown: these happen inside a CDP event handler, where there is no caller to throw to and an
escaping rejection would be unhandled.

A miss also does not fail a `waitFor` on the same pattern, which is the less obvious half. A
lost body says nothing about whether the *next* matching response will arrive — pages retry
their own fetches, and a hard fail here would end a run over a recoverable event. The cost is
that a genuinely lost capture is only learned at the timeout, so the `CAPTURE_TIMEOUT` message
names how many misses were recorded for that pattern; a timeout that was really an eviction is
diagnosable from the receipt alone, without reading the event log.

An archive failure is a miss and not a delivery-with-a-warning, unlike
`ARCHIVE_SIDECAR_FAILED` (D31), which stays a warning on the capture: a body no one archived
is a body no one may parse, because there is no copy left to re-parse when the parser turns
out to be wrong (D2). A missing sidecar loses metadata that can be reconstructed; a missing
body cannot.

Also settled here: a body still on the wire when `stop()` lands is dropped rather than
archived and delivered. It belongs to a phase the capability has already left, and appending
to a result set nobody is reading is worse than losing one response the caller did not wait
for.

## D52 — The tap remembers an early finish only for requests it already matched
2026-08-08 (Task 9 review fix). `Network.loadingFinished` for a request the tap has no
`#inflight` entry for is remembered **only** when `#methods` already holds that request id —
that map is populated at `requestWillBeSent`, for URL-matching requests only, and
`requestWillBeSent` always precedes `loadingFinished` for the same request.

The first version remembered every finish in a 500-entry capped map and let the non-matching
ones age out. That was silent data loss, not merely waste: a LinkedIn feed issues thousands of
requests, so the cap churned constantly, and one of *our* early finishes could be evicted
before its `responseReceived` arrived. The response then parked in `#inflight` waiting for a
finish that had already happened and been thrown away — no capture, no miss, no
`capture.miss` event, and a `waitFor` timing out while reporting zero misses. That receipt
reads as "LinkedIn did not respond", which sends the operator to the browser to debug a bug
in this file. A tap that silently drops a response is the one failure the whole task exists to
prevent.

`#inflight` is now capped by the same `remember()` as everything else, and both of its loss
paths record an `abandoned` miss: eviction under the cap, and anything still in flight when
`stop()` runs. The second one is what makes the gate safe — the case it deliberately drops (a
request with no `requestWillBeSent` of its own, e.g. one served by a service worker, whose
finish beats its response) parks in `#inflight` and is accounted for at stop, rather than
waiting on 500 newer matched responses to push it out.

Rejected: remembering every finish in a much larger map. It moves the cliff without removing
it, and the map that needs bounding is the one holding entries that *mean* something, not the
one holding noise.

Accepted cost: `stop()` reports as misses those matched responses that were genuinely still
loading when a capability finished — real, but the correct accounting. A watched response the
tap never delivered is a miss regardless of whose fault the timing was.

## D60 — The challenge gate denies by default: an unrecognized LinkedIn page is a halt
2026-08-08. `classifyUrl` checks a deny list of challenge paths, then an allowlist of
app paths, and **anything left over on a linkedin.com host is `unrecognized`** —
`CHALLENGE_UNRECOGNIZED`, exit 2, `HALT_AND_NOTIFY`. Clean is a positive
identification, never a default.

The obvious design is the reference worker's: match the known challenge shapes, and
treat everything else as fine. It is also the design that cannot see the one failure
that matters. LinkedIn changes its challenge surface on its own schedule; the first
time it serves an interstitial at a path this file has never heard of, a
match-challenges-only gate returns clean, the capability parses an interstitial as a
profile, and the toolkit keeps driving a session LinkedIn has already flagged. There
is exactly one account and it cannot be burned, so the asymmetry in the cost is the
whole argument: a false positive is a manual restart and a one-line addition to
`APP_PATH_PREFIXES`; a false negative can cost the account.

The friction the task file warns about is real and is paid for structurally rather
than by weakening the rule: the allowlist is one entry per *product area*
(`/in/`, `/feed`, `/search/`, `/sales/`, `/jobs/`, …), not per page, so ordinary
navigation is covered by a coarse list that changes rarely. A URL that will not parse
is likewise `unrecognized` rather than clean.

The same reasoning covers an unreadable page. `detectChallenge` contributes an
`unrecognized` signal when the DOM read fails, so a page the gate could not read is
never certified — but a URL that already named a specific challenge still wins, since
that is a positive identification and `unrecognized` is the absence of one.

Rejected: `unknown` as a third, non-halting state the caller decides about. It moves
the decision to every call site, and the call sites are capabilities in the middle of
a parse, which is exactly where "probably fine" gets chosen.

## D61 — The page-URL gate and the response gate ask different questions, so only one denies by default
2026-08-08. `classifyUrl` (D60) denies by default. `classifyResponse` runs the **deny
list only**, and treats an unlisted URL as clean, deciding on HTTP status instead.

They look like the same check and are not. "Is the page we are sitting on a
challenge" is answerable by allowlist, because the app surface is a dozen product
areas. "Is this API response a challenge" is not: LinkedIn serves hundreds of
Voyager and `salesApi*` paths, no allowlist of them could be kept current, and
denying by default would halt the run on the first normal request — a gate that
fires constantly gets turned off, which is a worse outcome than the one D60 avoids.

What the deny list still buys on the response path is the case that matters: a
request *redirected* onto `/checkpoint/…` or `/uas/login` is caught even when it
carries a 200.

Status mapping: 429 → `rate-limited` (exit 3, `RETRY_BACKOFF`, `retry_after_ms` from
`Retry-After` when present) · 999, LinkedIn's own "request denied" → `restricted`
(exit 2) · 401/403 → `login` (exit 4, `REAUTH`) · everything else, 5xx included,
clean. A 5xx is a broken server, not a challenge; classifying it here would file a
transient outage under exit 2 and stop a run that should retry.

Known imprecision, deliberately kept: a 403 from LinkedIn can mean "you may not view
this member" as well as "you are logged out". The task file's contract is that
401/403 means the session is dead, and the error direction is the safe one — a halt
for reauth. Task 15's live run is where a real 403 gets looked at.

## D62 — `RunContext`'s `Screenshotter` returns `Promise<unknown>`
2026-08-08. Task 6's `Screenshotter` was `{ screenshot(filePath): Promise<void> }`
and Task 4's `WorkerTab.screenshot` returns `Promise<string>`. `Promise<string>` is
not assignable to `Promise<void>`, so `runContext.screenshot(workerTab, name)` did
not typecheck — the two modules had never been composed, because the challenge path
("screenshot, checkpoint, exit 2", spec §8) is the first caller that needs both.

Widened to `Promise<unknown>`. The position is an input, so nothing that satisfied
the old type stops satisfying the new one, and no call site changes. Rejected:
narrowing `WorkerTab.screenshot` to return `void` instead — the path it returns is
what lands on the receipt's `evidence`, and throwing it away to satisfy a structural
type would cost a real thing to fix a bookkeeping one.

Pinned by compile-time assertions in `tests/challenge-detect.test.ts` (`WorkerTab
extends ChallengeTab & ShotTab & Screenshotter`, `RunContext extends
ChallengeArchive`), verified to fail when the widening is reverted. A structural
seam between two modules that never appear in the same file is otherwise proven by
nothing until the first caller shows up, which is how this one survived two reviews.

## D63 — an unverified signal halts, but never prescribes a re-login
2026-08-08, from review of Task 10. Two signals that pointed at `login` (exit 4,
`SESSION_DEAD`, `REAUTH`) now point at `unrecognized` (exit 2, `HALT_AND_NOTIFY`):
bare `/` and `/home`, and HTTP 403.

The reasoning behind both was explicitly unverified. Bare `/` as a bounce is inferred
from LinkedIn's redirect behaviour, not observed. A 403 means "you are logged out" or
"this member is out of your network", and the two want opposite responses.

What changed is the judgement about which wrong answer is cheap. Elsewhere in this
module a false positive costs a manual restart, which is why it denies by default
(D60). Exit 4 does not fit that shape: it does not just halt, it instructs the
operator to authenticate again, and a needless re-login on a healthy session is
itself an event LinkedIn watches. So a wrong `login` spends account safety, which is
the one currency this project does not spend for convenience. `unrecognized` stops
the run exactly as hard, produces the same screenshot and checkpoint, and asks for a
human instead of prescribing the one action that carries risk.

Superseded from D60's entry: the mapping there recorded `401/403 → login`. 401 keeps
it — an unauthenticated request is unambiguous. Task 15's live run is what promotes
403 or the bare-`/` bounce back to `login`, on evidence.

## D64 — throttle wording is only trusted on a short page
2026-08-08, from review of Task 10. The three `rate-limited` text markers
("couldn't load this content", "too many requests", "try again later") are marked
`soft` and skipped when the page body exceeds `SOFT_MARKER_MAX_TEXT` (2,000 chars).

LinkedIn renders "couldn't load this content" on one failed feed card while the rest
of the page is fine and the session is healthy. The gate reads up to 20,000
characters of `innerText`, so on a feed these phrases were near-certain to fire
eventually — halting a good run with `RATE_LIMITED` and a back-off, on a receipt
indistinguishable from a real throttle.

Narrowing detection is normally the unsafe direction, so the bound on what is given
up matters: the authoritative throttle signal is HTTP 429 in `classifyResponse`,
untouched by this. These markers are the backstop for a throttle served as a 200, and
in that case the interstitial *is* the page — short by construction. What is
surrendered is a throttle phrase buried inside a full page, which is the false
positive rather than the throttle. The captcha, checkpoint and restriction markers
stay trusted at any length; their wording is specific enough that length says nothing,
and missing one of those is the expensive direction.

## D70 — budget ledger daily windows are rolling 24h, not calendar-day
2026-08-08, Task 11. §8 says "page loads / day" and "distinct profiles / day" without
saying whether "day" resets at UTC midnight or slides. Read literally alongside "the
hour is rolling" (also §8), a rolling day is the consistent reading and avoids a
calendar-boundary edge case the spec never discusses: two bursts either side of
midnight UTC that a fixed calendar day would let both through in full, uncounted
against each other. `usage`/`check`/`spend` count anything within `now − 24h`,
exactly mirroring the hourly window's `now − 1h`.

## D71 — spend() re-runs check()'s evaluation under a lock, rather than trusting a prior check()
2026-08-08, Task 11. The task file frames check and spend as separate operations
("capabilities check the estimated cost in preflight, then record actual spends as
they happen"), which could be read as spend() trusting a check() that already ran.
Rejected: a capability that spent without checking first — a bug, not a malicious
flag — would then have nothing standing between it and exceeding a limit, which is
the one failure mode task 11 calls unacceptable. spend() re-evaluates every limit
itself immediately before appending, and the read-evaluate-append sequence runs
inside a lockfile-based mutex (`<path>.lock`, exclusive-create, stale after 5s) so
two concurrent spends racing the same limit cannot both observe "under limit" and
both commit — the failure mode named directly in the task file via the tab lease.
check() stays a separate read-only peek for capabilities that want to estimate cost
before starting work; neither operation depends on the other having run.

Revised same day, from review: D71's first cut stole a stale lock with
`unlink`-then-recreate. That is not mutually exclusive — two callers can both judge
the same lock stale and both `unlink`, and the second unlink deletes the *first*
caller's brand-new lock rather than the stale one, so both end up believing they
hold it (reproduced: 2/8 trials of 6 racers against a limit of 1 let both a
"winner" and a "loser" record a spend). Replaced with rename-to-quarantine, the same
technique D16 already used for the tab lease: rename is atomic, so of several
callers that judge one lock stale, exactly one renames the real file and the rest
get `ENOENT` and loop back to find the winner's fresh lock. Also fixed: the stale
branch used to `continue` without checking the deadline or sleeping, so a lock that
could never be stolen (its directory unwritable) spun hot forever instead of
eventually reporting `BUDGET_LEDGER_BUSY`; the deadline check and poll sleep now
run on every iteration regardless of which branch was taken, and a rename that
fails for a permanent reason (not `ENOENT`) is classified `BUDGET_LEDGER_UNWRITABLE`
immediately rather than waited out, since no retry changes an unwritable directory.

## D72 — spend() compacts the ledger to the widest window on every write
2026-08-08, Task 11, from review. The task file states the ledger file "is never
rewritten or truncated by this module" (task-11, line 28) — read at the time as
ruling out compaction. Revisited after review flagged the consequence: at 400 page
loads/day the file grows to roughly 15MB/year, and every `check`/`spend`/`usage`
call re-parses it in full to answer a question about the last 24 hours, forever.
Nothing outside the widest window any limit uses (a day) is ever read again by this
module to enforce a limit — long-term history belongs to Supabase (D11's own note:
"the table may later mirror the file for reporting"), not to a file whose only job
is bounding rolling windows. `spend()` now rewrites the file, atomically via
tmp-then-rename, keeping only entries within 24h plus the just-recorded spend, on
every call — the one place already holding the full parsed list under the lock.
`check()` and `usage()` stay pure reads and never write. Operator-approved
explicitly, given the direct conflict with the task file's original wording.

Revised same day, from review, twice:

1. The first cut wrote the tmp file and renamed it with no `fsync`. Rename is
   atomic against a process crash but not against power loss or a kernel panic —
   the rename can reach disk before the tmp file's bytes do, and the ledger comes
   back reading zero spends. That flips this module's one required property:
   `appendFile`'s failure mode was a rejected partial line (fail closed); an
   un-synced compacted rewrite's failure mode is a healthy-looking empty file
   granting a fresh quota against an account that already spent it (fail open).
   `writeCompacted` now opens the tmp file, writes, calls `fh.sync()`, then
   closes and renames — the sync makes the bytes durable before the rename
   publishes them.
2. The retention window was 24h, matched to the widest limit window. But D72's
   safety argument — "long-term history belongs to Supabase" — assumes a mirror
   that does not exist yet: Task 13's `budget_ledger` table has no writer until
   Task 14. Until then this file is the *only* copy of spend history, so
   compaction dropping anything past 24h destroys it outright. Retention is now
   `COMPACTION_RETENTION_MS` (7 days, `src/core/budget/constants.ts`), separate
   from the 24h window every limit actually enforces — narrow this back to 24h
   once Task 14's mirror exists.
## D90 — local Supabase runs on the 553xx port block, not the default 543xx
2026-08-08, Task 13. `supabase/config.toml` sets `project_id = "linkedinleadsos"`
and moves every port from the CLI default 5432x to 5532x (API 55321, db 55322,
studio 55323, mailpit 55324, analytics 55327, shadow 55320, pooler 55329).

Spec §13 left "exact Supabase local port" open. It cannot stay open: this machine
already runs two other local Supabase stacks — Quran-App on 5432x and ownex-leadops
on 5632x — so the default block is occupied and `supabase start` would either fail
or, worse, a mistyped connection string would reach the wrong project's database.
The 5532x block is free and sits in the same visual family, so the port still reads
as "a local Supabase". Rejected: stopping the other stacks before working here, which
makes an unrelated project's uptime a precondition for ours.

## D91 — RLS on with no policies, and grants to `service_role` alone
2026-08-08, Task 13. Every table gets `enable row level security`, no policy is
created, and the only grants are `service_role`. Supabase's current default already
withholds Data API grants from new tables (`auto_expose_new_tables` unset), so this
makes the exposure explicit rather than incidental.

The store client holds the service role key, which bypasses RLS, so it is unaffected.
The agent reads bulk data over a direct Postgres connection (D4), which is the
superuser path and also unaffected. What this buys is that the anon/publishable key
reaches nothing at all — so if this database is ever hosted, it is not readable by
anyone who scrapes the key out of a client. Rejected: leaving RLS off on the argument
that it is local-only; "local-only" is a property of today's deployment, not of the
migration, and the migration is what would travel.

## D92 — the schema is `public`, not namespaced
2026-08-08, Task 13, settling the first half of spec §13's schema question as the task
file directs. One application owns this database, and D4 has the agent writing raw SQL
against it by hand. A `li.` prefix would mean a `set search_path` or a qualified name in
every ad-hoc query, for no isolation that a separate database would not give better.

## D93 — `person_experience` stores full employment history, not just the current role
2026-08-08, Task 13, settling the second half of spec §13. The full positions array is
already inside the captured profile response, so storing it costs nothing extra at
capture time. Keeping only the current role would mean a re-scrape to recover history
later, and D2 (raw-first) exists precisely so that a change of mind about parsing never
requires spending page loads again. The table therefore carries `started_on`/`ended_on`
and `is_current`, with a `NULLS NOT DISTINCT` unique index over
(person_urn, company_urn, company_name, title, started_on) as the upsert target — LinkedIn
omits dates and urns on old roles often enough that a plain unique index would insert a
duplicate row on every re-scrape.

## D94 — foreign keys only on `runs` and `searches`, never on a LinkedIn URN
2026-08-08, Task 13. `raw_captures.run_id`, `search_results.search_id` and
`search_results.run_ref` are real foreign keys: those parents are rows we create
ourselves, so requiring them cannot reject true data.

No URN column has one. `persons.current_company_urn`, `person_experience.company_urn`,
`company_people.person_urn`, `person_posts.person_urn` and `jobs.company_urn` all
routinely arrive before the entity they name has ever been scraped — a search result
names an employer we have never visited. A foreign key there would reject a fact
LinkedIn actually told us, which turns an integrity constraint into data loss. Pinned by
`tests/schema-migration.test.ts`, which fails if any `references` clause lands on a
`_urn` column.

## D95 — ids are `text`, including the numeric-looking ones
2026-08-08, Task 13. Company urns and job posting ids look like integers, and are stored
as text anyway. They arrive as strings in Voyager JSON; text round-trips them exactly,
where a numeric column invites a silent reformat (leading zeros, exponent notation) and
has an overflow edge no id should ever depend on. It also keeps every id column in the
schema the same type, so a join written from memory is right.

## D96 — the migration is idempotent, and re-applying it is part of the proof
2026-08-08, Task 13. Every `create` in the migration is `if not exists` and nothing in it
drops, truncates or deletes. `npm run db:verify` applies it from scratch via
`supabase db reset`, then applies the same file a second time through psql with
`ON_ERROR_STOP=1`, then compares the catalog fingerprint before and after — a re-apply
that errors or that changes the schema fails the check.

A migration that applied cleanly once is not proven; the failure this guards against is
an operator re-running the file by hand against a database that already has it, which is
the normal thing to do when you are unsure whether it ran. The static half is in
`tests/schema-migration.test.ts` so the property is also checked offline, with no Docker.

## D97 — RLS is not deny-by-default on its own; anon and authenticated are revoked explicitly
2026-08-08, from review of Task 13. **This corrects D91**, which claimed "anon and
authenticated reach nothing at all". That was false against the live database, and the
test that was supposed to prove it could not have seen it.

Measured on the local stack: every table the migration created carried
`anon = REFERENCES, TRIGGER, TRUNCATE` and the same for `authenticated`. Verified
reachable — `set role anon; truncate persons;` emptied the table (rolled back). RLS
filters rows for select/insert/update/delete and says nothing about table-level
privileges, so it never covered TRUNCATE at all.

The source is Supabase's bootstrap default ACL for role `postgres` on `public`
(`pg_default_acl` shows `anon=Dxtm/postgres`), not anything this migration wrote. A
`grant` only ever adds privileges, so no grant statement could have removed them. The
migration now ends with explicit `revoke all … from anon, authenticated` on tables and
sequences, plus `alter default privileges` so a table added by a later migration inherits
the same treatment rather than arriving with TRUNCATE handed out again. The default
privileges also *grant* to `service_role`, because `grant … on all tables` is a snapshot
of the tables that exist at that moment and Task 14's tables would otherwise get nothing.

Not reachable over the Data API today — PostgREST issues no DDL — so this was a standing
privilege contradicting the stated model rather than a live hole. `TRIGGER` is the one to
remember if a `security definer` RPC is ever added.

The general lesson, which is D-worthy on its own: **a claim about privileges can only be
proven against a database.** The offline test regexed the migration text for `to anon`,
found nothing, and passed — while the database granted to anon. The text was clean; the
privilege was one the file never wrote. `npm run db:verify` now queries
`information_schema.role_table_grants` and `has_table_privilege`, and creates a probe
table inside a rolled-back transaction to prove future tables inherit the rules. Both
assertions were verified to fail against the pre-fix migration: 78 leaked privileges, and
6 on a newly created table.

## D98 — deleting a run does not cascade into `raw_captures`
2026-08-08, from review of Task 13. The foreign key `raw_captures.run_id → runs.run_id`
loses its `on delete cascade` and takes the default `no action`.

The gzipped bodies live on disk under `runs/<run_id>/raw/` and are the durable copy (D2);
`raw_captures` is only the index into them. Cascading deleted the index while leaving the
files, which is the worst of both — the bytes are still on disk consuming space and no
query can find them. With `no action`, deleting a run that has captures fails instead, so
whoever is deleting has to deal with the files. Rejected: `on delete set null`, which
`run_id text not null` forbids and which would produce the same orphan in a different
shape.

`search_results.search_id` keeps its cascade: nothing on disk is keyed by a search id, so
deleting a search really does dispose of everything it produced.

## D99 — a migration is never edited once applied; the next change is a new file
2026-08-08, from review of Task 13. Recorded because the failure mode is silent in both
directions.

Every statement in the M1–M3 migration is `if not exists`, which is what makes re-applying
it safe (D96) and simultaneously makes editing it useless: adding a column to an existing
`create table if not exists` block is ignored outright, with no error and no warning.
`npm run db:verify` cannot catch it either — step 2 runs `supabase db reset` first, so the
check only ever exercises a fresh apply, where the edited file is correct. The edit would
work on the verifier and do nothing on the operator's actual database.

The rule is therefore stated in the migration's own header, where someone about to edit it
will read it, and pinned by a test asserting that header is still there.

## D80 — login state comes from the `li_at` cookie, never from navigating to LinkedIn
2026-08-08, Task 12. Preflight step 3 (§8, "the profile is logged in") reads the
automation profile's cookies with `Storage.getCookies` and looks for `li_at` on a
`linkedin.com` domain, checking its expiry. It issues **zero** LinkedIn requests.

Verified on the automation Chrome (151.0.7922.76): `Storage.getCookies` is a
browser-level command that needs no domain enabled, so it stays inside D8's attach
surface; `Network.getAllCookies` does not exist at browser level and answers
`-32601 method not found`. The profile's `li_at` reads back with expiry 2027-08-07,
matching what M0 recorded.

Rejected: navigating the worker tab to `linkedin.com/feed` and running the challenge
gate over it. That is the only alternative that proves the session end to end, and it
costs a page load off a metered account (§8) *to find out whether we may spend page
loads*, on every invocation, before any work happens. It also puts a LinkedIn request
in the path of `health.check`, whose whole value is that it touches nothing.

Accepted limitation, stated because it will matter: a present, unexpired `li_at` is
necessary for a live session, not sufficient. LinkedIn can invalidate it server-side and
the cookie stays on disk. That is fine here, because preflight is not the only gate —
the challenge detector (D60) runs after every navigation and classifies a login wall as
`SESSION_DEAD` on real evidence. Preflight's job is to catch the cheap, common case (a
profile that was never logged in, or a cookie that expired) before spending anything.

Also settled: a probe that *fails* is transient `LOGIN_PROBE_FAILED` (exit 6), not exit 4.
D63's reasoning applies unchanged — exit 4 does not merely halt, it instructs the operator
to authenticate again, and a needless re-login on a healthy session is itself an event
LinkedIn watches. A CDP hiccup is not evidence of a dead session.

## D81 — the CLI is generated by scanning `src/capabilities/`, and the directory name is the capability name
2026-08-08, Task 12. `loadCapabilities()` reads the `src/capabilities/` directory,
imports each `<name>/index.ts`, and registers whatever it exports as `capability` or as
its default export. There is no list of capabilities anywhere in the repo.

The spec's requirement is that adding a capability means adding one directory with zero
hand-written CLI wiring (§3). A hand-maintained `capabilities.ts` barrel would satisfy
the letter of it and not the point: the failure it produces is a capability that exists
on disk, has tests, and is invisible to `cap list` — which is the surface a
context-less agent rediscovers the toolkit from (§4.5).

The directory name must equal the capability's declared name, enforced at load with
`CAPABILITY_NAME_MISMATCH`. That is what keeps spec §10's promise that reading
`src/capabilities/profile.get/` shows you what `cap profile.get` runs; nothing else
would catch a rename that moved the two apart.

Accepted cost: a capability directory that throws at import breaks the whole CLI, including
`cap list`, rather than only its own subcommand. Deliberate — it fails at load with
`CAPABILITY_LOAD_FAILED` naming the directory, and a toolkit that quietly hides a broken
capability from its own manifest is the worse failure. A malformed export is refused the
same way (`CAPABILITY_MALFORMED`), so a capability missing a `cost` function cannot be
discovered halfway through a run against the real account.

## D82 — a capability returns a result; the runner owns the receipt, the exit code and teardown
2026-08-08, Task 12. Spec §3 sketches `run(ctx, args): Promise<Receipt<Data>>`. The
implemented shape is `run(ctx): Promise<CapabilityResult>` — counts, data, warnings,
stored, next — and `execute()` assembles the receipt around it.

`run_id`, `artifacts`, `cost` and the exit class are all facts about the invocation, not
about the capability: the run id is minted by the run context, the artifact paths by §5's
layout, the cost is measured from what the run actually spent, and the exit code is
already carried by the `CapabilityError` that ended it (Task 1). A capability that built
its own receipt would re-derive all four, and the first one that derived them differently
would produce a receipt an agent parses wrong — silently, since the shape would still be
valid.

The same reasoning puts teardown in the runner rather than in the capability. Exactly one
receipt reaches stdout and the tab and lease are released on every path — success, every
failure class, an unclassified throw, and (via the `onCleanup` thunk) an exception raised
from a CDP listener where nothing else knows what is held. A capability cannot forget to
do what it never does.

## D83 — `--budget=<n>` is enforced in two places, and has its own failure code
2026-08-08, Task 12. The flag lands as a limit override on `BudgetLedger` (which accepts
it only when it lowers a §8 default — an override above the default is ignored, per Task
11) *and* as a per-invocation page-load cap inside `RunBudget`.

Both, because they answer different questions. The ledger override bounds the rolling
hour and day across every run; the cap bounds this invocation. §4.4 says "cap page loads
for this invocation", which the window override alone does not do: with a quiet ledger,
`--budget=3` would let one invocation spend 60.

Crossing the invocation cap raises `BUDGET_INVOCATION_CAP`, not `BUDGET_EXCEEDED`. Same
exit code (7) because the agent's branch is the same, and a distinct code because the
operator action is not: one says raise your own flag, the other says wait out a
LinkedIn-facing limit. A shared code would make `log:why` unable to tell those apart.

**Revised 2026-08-08, from review — the ledger override is gone.** The first cut also
passed `--budget` to `BudgetLedger` as a limit override. The ledger's windows count
*every* run's page loads, so that compared the operator's number against other runs'
spend: with 40 page loads already in the hour, a run wanting 2 with `--budget=5` was
refused `BUDGET_EXCEEDED` — "limit is 5, already at 40" — naming a limit nobody hit and
stopping a run well inside its own cap. On any account that had done work in the last
hour the flag was unusable, and it produced exactly the receipt `RunBudget` exists to
avoid. Only the invocation cap remains. The effective ceiling is
min(invocation cap, ledger limit), so §4.4's "can only lower" still holds — the ledger's
own §8 limits stay the floor and nothing can raise them.

## D84 — `risk: "local"`, and `needsAuth` defaults to `needsBrowser` but can be declined
2026-08-08, Task 12. Two additions to §3's capability shape, both for the same reason.

`health.check` makes no LinkedIn request. Filing it under `read-cheap` would put it in the
bucket the manifest uses to tell an agent "this one spends account safety", so the risk
enum gains `local`. The manifest is the only thing a context-less agent reads before
choosing a capability; the one entry that is guaranteed safe should say so.

`needsAuth` defaults to `needsBrowser`, so every future reader capability gets the exit-4
preflight without declaring anything. `health.check` sets it false and reports
`data.login` instead: the command that diagnoses a broken session must run *when the
session is broken*, and halting it with `SESSION_NOT_LOGGED_IN` would make the toolkit
silent at exactly the moment an operator needs it to speak.

`SESSION_NOT_LOGGED_IN` is also deliberately not `SESSION_DEAD` (D60's login code). Both
exit 4 and both ask for a re-login, but they are different investigations: this one says
the profile has no usable cookie on disk (never logged in, or expired), while
`SESSION_DEAD` says LinkedIn served a login wall to a session we believed was live — the
second can mean the account was flagged, and folding them into one code would hide that.

## D85 — the closed event-name set is not extended for preflight
2026-08-08, Task 12. Spec §5 fixes the event vocabulary at fifteen names, and preflight's
steps (lease taken, budget cleared) have no name among them. They are not logged as events.

Rejected: adding `run.start` / `run.finish` / `preflight.*`. The set is closed because
`log:why` and `log:drift` group by it (D5), and widening it is a spec change that should
be made when the log-query capabilities exist to consume the new names (Task 18), not as a
side effect of building the CLI. What preflight *is* allowed to log, it does: the login
probe is a real `cdp.send`, navigation is `nav.start` / `nav.done`, the foreground
assertion is `render.wait`, a budget spend is `budget.spend`, and any failure is `error`.

Nothing is lost in the meantime: the receipt carries preflight's outcome in full — the
lease record, the login state, the budget snapshot — and `summary.json` persists it beside
the events.
## D100 — a store failure never carries a string the database wrote
2026-08-08, Task 14. `storeError` builds its own message from the operation, the table and
the SQLSTATE, and puts `{op, table, status, sqlstate}` in `evidence`. The PostgREST error's
`message`, `details` and `hint` are never forwarded.

Postgres writes the offending values straight into its own error text — a unique violation
reads `Key (urn)=(urn:li:fsd_profile:ACoAAB…) already exists` — and PostgREST passes that
through untouched. Receipts go to stdout (D3), so forwarding the driver's message would
print captured LinkedIn data into the agent's transcript, which the recording rules forbid
outright. The whole driver error is attached as a **non-enumerable** `cause` instead:
reachable under a debugger, invisible to `JSON.stringify`, so it cannot reach a receipt or
an NDJSON line by accident. Rejected: forwarding the message for unclassified codes only —
the classification is exactly what is uncertain there, so that is the case most likely to
leak.

## D101 — the person upsert is three ordered requests, not a transaction
2026-08-08, Task 14. `upsertPerson` issues: upsert the person, upsert the experience rows,
then delete that person's experience rows the capture no longer lists. PostgREST wraps each
request in its own transaction, so no single request half-lands; the seam is between them.

The order is the decision. Deleting first, or deleting inside the same statement, would mean
a failure before the insert lands destroys employment history the store had and this run
cannot replace. In the order above every failure leaves *extra* rows and never missing ones:
person only, or person plus new rows plus stale ones. Both writes are upserts on a declared
conflict target (`urn`; the `nulls not distinct` natural-key index), so a retry re-sends rows
that already landed and updates them in place — proven against the real database, including
the all-nulls experience row. `StoreWriteError.stored` carries the count that actually landed
so the receipt's `partial.stored` is truthful.

Rejected: a Postgres function called over RPC to get real atomicity. It buys atomicity for
one entity write and costs a second migration, a second place the schema is defined, and
logic that can only be tested with Docker running — while the non-atomic version's worst
case is a stale row that the next successful run removes.

## D102 — omitted means "not observed", null means "observed empty"; first_seen is the database's clock
2026-08-08, Task 14. A field absent from a `PersonInput` is left out of the payload, so
PostgREST does not include it in the `on conflict do update` set and the stored value
survives. An explicit `null` is sent and overwrites. A parser that cannot tell "the capture
did not contain this" from "the profile does not have this" must omit.

`last_seen` is stamped from the caller's clock (injectable, which is what makes freshness
testable). `first_seen` is never sent at all and stays the column default: a column present
in an upsert payload is also updated on conflict, so sending `first_seen` would reset it on
every re-scrape. The two therefore come from different clocks by design.

## D103 — a nonsense duration fails the run; it never becomes a default
2026-08-08, Task 14. `parseDuration` accepts a whole number with an optional `ms|s|m|h|d`
suffix, and throws `INVALID_DURATION` (exit 1) on anything else — including `1.5d`, `7d12h`,
`-1`, and `7w`. A typo that silently became the 7-day default would be indistinguishable
from working; one that silently became `0` would re-fetch every profile against the budget
that exists to prevent exactly that.

`isFresh`'s edges are chosen the same way: a missing or unparseable `last_seen` is stale
(the store cannot say how old the row is, so it does not get to claim it is new), the
comparison is strict so a row exactly max-age old is stale, `max-age 0` is always stale, and
a `last_seen` in the future is fresh because that is clock skew against Postgres, not
evidence about the row.

## D104 — the vanity lookup reports ambiguity instead of resolving or refusing it
2026-08-08, Task 14. `persons.vanity` is deliberately not unique (Task 13): LinkedIn
reassigns vanity URLs, so two profiles can hold the same string at different times.
`findPersonByVanity` returns the most recently seen match and sets `vanityMatches` to the
exact number of rows that matched. Above 1 means the caller is looking at a reused handle
and should resolve by urn.

Rejected: throwing on more than one match, which would make a routine LinkedIn fact into a
failed run; and returning all matches, which pushes a decision onto every caller that all of
them would resolve the same way.

## D105 — `last_seen` is the last thing written, not the first (revises D101's order)
2026-08-08, Task 14 review. D101 ordered the person upsert first and argued the ordering was
safe because every failure left *extra* rows and never missing ones. That is true of rows and
false of the one column freshness reads.

`last_seen` is not data about the person; it is the record's claim to be **complete as of that
instant**, and `isFresh` reads it to decide whether to serve from the store instead of loading
the page. Bumping it first meant a failure at the experience write left a record that was
incomplete *and* looked fresh, so the next run served the damage and never re-fetched it for a
whole `--max-age` window — a week at the default. For a person never stored before, the result
was a row with zero experience rows, marked fresh, indistinguishable from someone who genuinely
lists no jobs. The failure hid itself, and the saving freshness exists for was spent serving an
incomplete record.

The order is now: experience upsert → delete stale → person upsert. D94 puts no foreign key on
`person_urn`, so experience rows can be written before the person row exists. D101's property is
unchanged — still only ever extra rows — and every failure now leaves the person **stale**, so
the next run re-fetches and repairs. The one new intermediate state is experience rows with no
person row, which `findPersonByUrn` returns as `null`: read as stale, re-fetched, fixed. A
missing record is strictly better than a fresh lie.

This is CONTEXT.md's first shape exactly: a field written at step 1 that only becomes true at
step 3.

## D106 — SQLSTATE class 22 is a rejected write, not an unrecognized one
2026-08-08, Task 14 review. Class 22 (data exception: invalid date syntax, numeric overflow,
string too long) joins class 23 (integrity violation) on `STORE_WRITE_REJECTED`. It previously
fell into the catch-all `STORE_WRITE_FAILED`, whose message says the store reported an error
this build does not recognize.

The codes split on operator action (D13), not on cause. Class 22 and class 23 mean the same
thing to whoever reads the receipt: the row we sent is wrong, fix the caller, do not retry.
Proven live rather than only in a table — an experience row with `started_on: "not-a-date"` is
rejected by the real database as 22007 and classified `STORE_WRITE_REJECTED`, non-retryable.

## D110 — two pattern tiers, so the endpoint guess is checkable instead of merely made
2026-08-08. Task 15. The capture watches two kinds of URL pattern: `specific` ones naming
the endpoints this build predicts a profile page fetches (`voyagerIdentityDashProfiles`,
`/voyager/api/identity/dash/profiles`, `salesApiProfiles`, …) and `broad` ones matching
anything LinkedIn-API-shaped. Every capture reports which tier caught it, and the receipt
carries `unmatched_profile_ish` — profile-carrying responses that no specific pattern
matched.

The alternative was watching only the specific patterns, which is what the reference worker
does (`u.includes("salesApiProfiles")`). It is cheaper and it fails silently: if LinkedIn
has moved the payload to an operation this build has never heard of, a specific-only watch
captures nothing and the receipt reports zero — indistinguishable from a page that answered
nothing. The task file requires the capture to make it obvious whether the watched patterns
matched reality, and a net that catches what the guess misses is the only thing that can.

Whether a response is *about a person* is decided from its **body**, not its URL. Asking the
URL would make the pattern-vs-reality answer depend on the same guess it is checking.

Cost: the broad net archives every LinkedIn API response the page fetches, not only the
profile ones — tens of bodies rather than a handful. LinkedIn's own telemetry (`/li/track`,
`perftracker`) is excluded by name, since it is API-shaped, high volume, and never carries
profile data.

## D111 — a response-status `unrecognized` is a warning; every other detection halts
2026-08-08. Task 15. `profile.capture` runs `classifyResponse` over every captured response
before declaring success. A `rate-limited` (429), `restricted` (999), `login` (401) or a
redirect onto a deny-listed path halts the run through `recordChallenge`. An `unrecognized`
verdict — which in practice means HTTP 403 — becomes a `RESPONSE_STATUS_UNRECOGNIZED`
warning on an otherwise ok receipt.

D63 chose `unrecognized` for 403 precisely because it is ambiguous: "you are logged out" and
"this member is out of your network" want opposite responses. For the *page the worker tab is
sitting on*, that ambiguity is worth a halt — we may be driving a flagged session. For one
subresource among fifty on a page the DOM gate has already certified clean, it is not: a
profile page routinely 403s an out-of-network sub-fetch, and halting there would stop healthy
runs with a receipt indistinguishable from a real block.

The alternative — halting on every non-clean response verdict — was rejected on that
false-positive rate. The alternative in the other direction — not classifying responses at
all and leaving the halt entirely to the DOM gate — was rejected because a 429 served under a
normal-looking page is exactly the signal the DOM cannot see, and it is the authoritative one
(D64 already says so).

## D112 — the capture reports "no person data" as a warning, not as a failure
2026-08-08. Task 15. If a run archives responses but none of them carry person data, the
receipt is ok with `counts.usable: 0` and a `NO_PROFILE_PAYLOAD` warning — it does not fail.

The page load is already spent and the archive is the product. Failing would classify a
successful discovery run — "the page fetched these twelve endpoints and none of them is what
we expected" — as an error, which is the outcome this capability exists to surface. What must
never happen is an ok receipt that *reads* as "we got the profile" when nothing person-shaped
arrived, so the fact is on `counts.usable`, on `warnings`, and on `capture.profile_ish` in
three independent places.

Zero captures at all is different and does fail (`PROFILE_NO_CAPTURE`, transient): that is a
page load with nothing whatsoever to show for it, and a retry can genuinely change it.

## D113 — canonicalization drops every query parameter, not a deny-list of tracking keys
2026-08-08. Task 15. `normalizeProfileUrl` strips the entire query string and fragment from a
profile url rather than removing known tracking parameters (`trk`, `lipi`, `licu`,
`original_referer`, `miniProfileUrn`, `utm_*`).

No `/in/` or `/sales/lead/` page needs a parameter to decide what it renders, and a deny-list
is a list that goes stale — the next tracking key LinkedIn adds would arrive unhandled and
end up in the `ref` the budget dedupes on, so one profile would count as two profile opens.
Sub-paths (`/details/experience/`, `/recent-activity/all/`, `/overlay/contact-info/`) collapse
to the base profile for the same reason: they are different pages of one person, and this
capability captures the profile.

The vanity keeps its case in the navigable url and is lower-cased only in the `ref`, because
the vanity is LinkedIn's identifier and not ours to fold, while the ref exists to make two
spellings of one profile one budget entry.

## D114 — `readyState: "complete"` is not layout; the capture waits for the page to settle
**Superseded in part by D115 — the diagnosis below was wrong about *why*. Read D115 with it.**
2026-08-08. Task 15, from the first live run. `WorkerTab.navigate` resolves when
`document.readyState === "complete"`, which is correct for what Task 4 promised and is not
the same thing as the page having rendered. On LinkedIn it fires while the SPA is still an
empty shell.

Measured, run `01KZH9VVPKB5JEVEBW7G2JJ6F3` against a real profile: at that instant the page
reported `innerWidth 1333, innerHeight 798, scrollHeight 798`. The scroll planner correctly
concluded there was nothing to scroll, dispatched zero wheel passes, and so no lazily-loaded
section ever came into view or fetched. The run returned **ok, exit 0, 25 responses archived,
no challenge** — and the only profile-endpoint response it caught,
`voyagerIdentityDashProfiles`, was a 1,335-byte urn-resolution call carrying the person's
`entityUrn` and `versionTag` and nothing else. No name, no headline, no location, no
experience. The receipt said `passes: 0` and carried no warning at all.

So: `waitForLayout` polls the document height until it both exceeds the viewport and stops
changing (`LAYOUT_STABLE_READS` identical reads), bounded by `LAYOUT_TIMEOUT_MS`. Both
conditions are needed — an empty shell satisfies "stopped changing" on its own, and a page
mid-render satisfies "taller than the viewport" on its own. This is a render-confirmation
DOM read, one of the four D1 permits.

Rejected alternatives. A fixed sleep after navigation: it is either too short on a slow
render or wasted time on a fast one, and it can never *report* whether the page arrived.
Waiting on a `Page` lifecycle event: that means `Page.enable`, which D8 forbids. Waiting for
a specific LinkedIn DOM selector: it is a data-shaped DOM read, and the selector is
LinkedIn's to change.

The second half of this is that the failure was silent. A page that never laid out now
raises `PAGE_NOT_LAID_OUT` on the receipt. A capture that got the urn and nothing else must
not be indistinguishable from a complete one — that is the "every silent-loss path is made
visible" rule, and this is what it looks like when it is missing.

## D115 — LinkedIn scrolls an inner element, so the document height means nothing (corrects D114)
2026-08-08. Task 15, from an operator-supervised probe (`01KZHAHJ7504QSV57YC5RBZEV3`) run
specifically because D114's diagnosis was an inference from one number and had not been
checked against the live page. It was wrong, and this is what the page actually does.

**Measured, over 32 seconds on a real profile with the tab visible:**

- `document.documentElement.scrollHeight` was `798` at 3.1s and still `798` at 32.4s.
  `document.body` computes `overflow-y: hidden`. That number is a constant on this page.
- The page was nevertheless fully rendered: `main section` count went 4 → 5 → 8 → 9 → 23,
  `document.body.innerText.length` reached 30,963, and the DOM reached 875,004 characters.
- The real scroller is `main#workspace`: `overflow-y: scroll`, `scrollHeight 7348`,
  `clientHeight 746`.

So D114's premise — "the page had not laid out" — was false. The page had laid out; the
measurement was pointed at the wrong element. Worse, D114's fix would have made this louder
rather than better: `waitForLayout` would poll a constant for its whole window and then raise
`PAGE_NOT_LAID_OUT` on a perfectly rendered page, which is a false alarm on every LinkedIn
capture. D114's *shape* survives — waiting for a settled measurement, and reporting when it
never settles, is right — but it has to measure the element the page actually scrolls.

`VIEWPORT_EXPRESSION` now picks the tallest element that is genuinely scrollable
(`scrollHeight > clientHeight + 50`, `clientHeight >= 200`, computed `overflow-y` in
`auto`/`scroll`/`overlay`) and falls back to the document when there is none, so an ordinary
page is still measured correctly. `overflow-y: hidden` is excluded deliberately: the probe
found clamped `<p>` elements with `scrollHeight 1260` against `clientHeight 210`, which are
truncated text, not scrollers. The scroll budget is `scrollHeight - scrollerHeight`, the
scroller's own visible height, not the window's.

The lesson is the one the probe existed to teach, and it is worth more than the fix: **one
number that agrees with a hypothesis is not evidence for it.** `scrollHeight === innerHeight`
was consistent with "empty page" and with "inner scroller", and the whole of D114 was written
without distinguishing them. The distinguishing observation cost one page load and settled it
in 32 seconds.

## D116 — the profile's own content does not arrive on a watched Voyager endpoint
2026-08-08. Task 15, same probe. Recorded as an open finding, not a resolved design.

Across two live loads of the same profile, 24–25 LinkedIn API responses were captured and
**not one carried the person's profile content.** The only profile endpoint that answered was
`voyagerIdentityDashProfiles` at 1,335 bytes — a urn resolution returning `entityUrn` and
`versionTag`. Everything else was app chrome: `voyagerGlobalAlerts`, `ChameleonConfig`,
`premium/featureAccess`, `/voyager/api/me`, `voyagerFeedDashGlobalNavs`,
`JobSeekerPreferences`, `NotificationCards`, `LegoDashPageContents`, and messaging.

Scrolling the real scroller rendered 14 more sections (9 → 23) and produced **zero** new
network responses. So the content those sections rendered from was already client-side, and
it did not come through a URL our patterns watch.

One further observation, unexplained: `document.documentElement.outerHTML` contained
`urn:li:fsd_profile` at 3.1s and did not at 4.6s or at any point after. That is consistent
with the payload arriving inside the main document response and being consumed during
hydration — which would mean the data *is* on the network and *is* capturable, in the
navigation response the tap does not currently watch, because `/in/<vanity>` is not an API
path.

This is not yet established, and it is the question Task 16 and Task 17 turn on. The next
probe is cheap and decisive: watch the **document** response for the target URL as well, and
check whether its body carries the profile payload. If it does, `profile.get` parses the
embedded JSON out of the navigation response — still a captured response body, still not
parsed HTML (D1). If it does not, the profile must be reached by client-side navigation
(feed → profile inside the SPA), which forces the Voyager fetches, and that is a change to
how every reader capability navigates.

## D117 — the initial document response is a captured body; embedded JSON may be read from it (2026-08-08)

**Decision.** `CLAUDE.md`'s "never from parsed HTML" rule is amended, not waived. Fields may
be read from the initial document response for a profile URL, but only from **structured data
embedded in it** — the JSON LinkedIn server-renders into the document, addressed by a path
into that parsed JSON. Reading markup, element text, or CSS selectors stays forbidden.

**Why.** D116 established that no watched Voyager endpoint carries the subject's content, and
that the payload most likely arrives in the navigation response. The rule as written did not
distinguish two very different things it happened to phrase as one: a **JSON blob delivered
in a response body**, which has a stable shape and drifts only when LinkedIn changes its API,
and **rendered DOM text**, which drifts every time a designer changes a class name. The rule
exists to ban the second. Banning the first would have meant abandoning the capability over
punctuation in a sentence.

**What this does not license.** The document body must still be a *captured* response — read
through the tap, archived raw before parsing, like every other body (§6). Extracting it by
asking the live page for `innerHTML` is not this, and is still a DOM read.

**What settles it.** The probe D116 names: capture the document response and check for the
payload. If it is not there, this decision costs nothing, because nothing will have used it.

## D118 — a fixture is promoted for naming *this* subject, not for containing *a* person (2026-08-08)

**Decision.** `promoteFixtures` filters on two things it did not before. Bodies from private
endpoints — messaging, notifications, badging, presence, mailbox, nav chrome, A/B config,
account settings — are never promoted, and `--all` does not reach that exclusion. Bodies that
do carry person data are promoted only when they name the capture's **subject**, by vanity
slug or by a known urn, which the promote script reads from the run's own `run.json`.

**Why.** The first live capture promoted 9 fixtures and not one was the target. Among them:
339KB of the operator's own message threads, 106KB of notification cards, 62KB of A/B config.
The relevance test was `body contains urn:li:fsd_profile: or "publicIdentifier"` — which every
message thread and every notification satisfies cleanly, because they mention other people.
"Carries person data" and "carries the data we asked for" are not the same predicate, and
Task 16's parser was specified to be written against whatever this produced.

The private-endpoint exclusion is separate from correctness and is not overridable on purpose.
`fixtures/` is the one directory that will eventually be shared; the operator's inbox must not
be one flag away from being in it.

**Also fixed here:** shape dedupe now runs *after* the subject check, not before. Another
person's response has the same shape as the subject's — that is what a shape hash means — so
checking dedupe first let a stranger's body claim the slot and the subject's own body was then
skipped as a duplicate.

**Verified live.** Re-promoting run `01KZH9VVPKB5JEVEBW7G2JJ6F3` after the change: 0 promoted,
14 private endpoints, 3 person-data-but-not-the-subject, 8 no person data. That is the honest
answer, and it agrees with D116. The nine fixtures it produced before were all noise.

## D119 — the field map marks any path that resolves to the session's own identity (2026-08-08)

**Decision.** `buildFieldMap` takes the session's own person urns — read from the
`/voyager/api/me` body the page fetched anyway — and marks every hit whose value is one of
them. When *every* path for a probe is marked, the map says so and offers no "first concrete
path" at all.

**Why.** The generated map offered, as `person_urn`, `$.data.elements[].lixTracking.urn` with
73 hits — an A/B-test tracking field, and the urn in it was the operator's own member id. A
parser written against that path returns the operator's own account for every prospect and
passes its offline tests doing it, because the fixture it is tested against contains exactly
that value. The failure is invisible until it is in production against real prospects.

Marked, not dropped: an operator needs to see that the only `person_urn` in a body is their
own. That is a finding about the capture, not noise to hide.

## D120 — the profile's own document response is watched by name, and "specific" is read from the watched list (2026-08-09)

**Decision.** `documentPattern(targetUrl)` builds a `specific` pattern matching the initial
navigation response for one profile, and `profile.capture` watches it alongside
`PROFILE_PATTERNS`. Matching is on host-plus-path with query, fragment, trailing slash,
subdomain and case discarded; an unparseable url matches nothing rather than throwing, because
the predicate runs inside a CDP event handler where a throw is an unhandled rejection.

**Why a separate pattern rather than widening the broad net.** `/in/<vanity>` is a page, not an
API path, so `isLinkedInApiUrl` rejects it by design and no broad pattern can reach it. Widening
the net to "any linkedin.com response" would archive every asset and every tracking beacon on the
page — D110 already excluded telemetry by name for exactly that reason. The document is one known
url per run, so naming it costs one pattern and keeps the net's meaning intact.

The pattern is deliberately exact: it does not match the profile's sub-pages or the Voyager calls
about the same person. The question it exists to answer is "did the payload arrive in the
navigation response", and a pattern that also caught the API calls could not answer it.

**Also fixed here, and it is the part worth remembering.** `summarizeCaptures` accepts a pattern
list but derived "which names are `specific`" from the module-level `PROFILE_PATTERNS` constant.
So a pattern constructed at run time was `specific` by its own `tier` field and *unknown* to the
count that reads tiers — the document capture was reported as `unpredicted`, which fed
`unmatched_profile_ish`, which raised `PATTERN_MISMATCH`: "profile payloads arrived on endpoints
no specific pattern matched", naming the one pattern that had just matched exactly. The warning
would have appeared on the receipt of the probe that exists to read that warning. Specific names
are now derived from the list passed in.

This is the general shape of it: a function that takes a parameter and then consults a module
constant for a property *of that parameter* has two sources of truth, and the default argument
hides it. Caught by a test that built a summary over a run-time pattern, which nothing before
had done because nothing before had a run-time pattern.

## D121 — the profile payload in the document is a server-rendered UI tree, not addressable data; D116 resolves to its second branch (2026-08-09)

**Finding, measured, not inferred.** Run `01KZJ09FEEYGY8WYDD3RQA0BH2` captured the document
response for `/in/tankots/`: 200, 1,004,191 bytes, archived. D116's hypothesis was half right and
the half that failed is the one that decides the design.

**What is in there.** The document carries `window.__como_rehydration__`, a JSON array of 174
streaming chunks which concatenate into a React Server Components flight stream — 376 rows, 375 of
which parse as JSON, 38,419 nodes, max depth 75. The subject's content is genuinely present:

- headline — `CEO at Wispr Flow | IOI Medalist | Forbes 30 under 30 | Stanford CS + AI`
- location — `San Francisco, California, United States`
- current company and school — `Wispr Flow · Stanford University`
- `firstName: "Tanay"` / `lastName: "Kothari"` / `vanityName: "tankots"`

**Why it is not usable, and this is the whole entry.** None of it is addressed by a field name.
The headline lives at `$[162].value[3].textProps.children[0]`, in a node whose only keys are
`maxLineCountExpression`, `textColorExpression` and `textProps`. A *stranger's* headline — one of
the "people also viewed" suggestions in the sidebar — lives at `$[169].value[3]`, in a node with
**the same keys, the same shape, and the same path pattern**. Nothing in the tree says "this one
is the subject". The only thing separating the prospect from a suggestion is the flight row index,
which is rendering order.

There is no `headline` key, no `location` key, no `positions` array, no entity boundary, and no
subject urn anywhere in the document — the only person urns in it are the *operator's* own
member id, carried in A/B tracking (D119's exact trap, found again in a new place).

So a parser here would read element text at a hardcoded position in a layout tree. That is what
D117 kept forbidden in the same breath as it permitted embedded JSON: the rule's line is between
"a JSON blob with a stable shape that drifts when LinkedIn changes its API" and "rendered text
that drifts when a designer changes the layout". A serialized JSX tree is the second one written
in JSON syntax, and D117's permission does not reach it. Confirming: the `firstName`/`lastName`
that *do* appear under real keys are arguments to a *future* request
(`...actions[].value.content.screen.requestedArguments.payload.firstName`, the payload of the
"Manage notifications about Tanay Kothari" screen), not a record of the person.

**What the run did establish.** The subject's urn is available and stable:
`voyagerIdentityDashProfiles` returns `identityDashProfilesByMemberIdentity["*elements"][0]` =
`urn:li:fsd_profile:ACoAAE1JGFIB…`. That is §7's identity, from a real Voyager body, on a
`specific` pattern that matched. Identity is solved; content is not.

**Consequence.** D116's second branch is now the measured answer: a hard navigation to
`/in/<vanity>` is served server-rendered and issues no Voyager call carrying profile content —
across three live loads, 24, 25 and 26 API responses, zero with the subject's content. Reaching
the content requires the SPA to fetch it client-side, which is a change to how every reader
capability navigates and needs an operator decision and a spec note before any of it is built.
Recorded here rather than acted on for that reason.

**Cost of establishing it:** one page load, zero profile opens (the ref was inside its 24h dedupe
window), exit 0, no challenge.

## D122 — an automation Chrome with no windows is "up" to discovery and dead to every browser command (2026-08-09)

**Environment finding.** The first attempt at the probe failed preflight with
`CDP_PROTOCOL_ERROR` / exit 6: `Storage.getCookies was rejected by Chrome: Browser context
management is not supported.` The automation Chrome was running, on the right profile, with D14's
exact four flags, and `GET /json/version` answered normally with the browser websocket url.

`GET /json/list` returned `[ ]`. Every window had been closed — the leftover tab from probe run 2
that `STATE.md` warned about — and on macOS Chrome stays resident with no browser context. In that
state `isChromeUp` is true, `ensureChrome` reuses the process, and the first browser-level command
fails. Killing the process and letting `ensureChrome` relaunch it fixed it immediately; the
profile's `li_at` is on disk and was untouched.

Worth writing down because the receipt sends you the wrong way: exit 6 `RETRY_BACKOFF` on a
transport-shaped error reads as a CDP hiccup, and retrying can never fix it — the condition is
permanent until someone restarts Chrome. D13's question ("will a retry change this?") is answered
*no* here and the code says yes, because the transport classified it (D15) and the transport
genuinely cannot tell. Not fixed in this commit: the fix belongs with whoever owns preflight, and
the candidate is for `ensureChrome`'s reuse path to require a non-empty `/json/list` rather than a
bare `/json/version` answer. Filed in `BACKLOG.md`.

## D123 — identity from Voyager, content from the rendered DOM, on the cold load (operator decision, 2026-08-09)

**Operator decision, resolving D116/D121's open question.** The reader keeps the cold load of
`/in/<vanity>` that Task 15 already ships. It draws the profile from two sources, by role:

- **Identity — Voyager JSON.** The subject's stable urn (§7) comes from
  `voyagerIdentityDashProfiles` → `identityDashProfilesByMemberIdentity["*elements"][0]`, a
  real Voyager body that *does* answer on a cold load (D121). Keying, freshness and dedupe run
  on this. The document's embedded structured JSON (D117) is still read where a genuinely
  addressable blob is present.
- **Content — the rendered DOM.** Headline, location, positions and the rest are read from a
  **DOM snapshot** (`document.documentElement.outerHTML`, captured after layout settles,
  archived like any body, parsed offline), scoped to the subject's main container. Every row
  is tagged DOM-sourced.

This is the first time rendered DOM is allowed as a data source; the amendment is deliberate
and bounded — see the CLAUDE.md rule change made with this entry.

**Why not Voyager-first-then-DOM (the earlier draft of this entry).** Getting a content-bearing
Voyager response requires making the SPA fetch the profile client-side (D116 branch 2), which
means a hard-load of `/feed/`, then an injected-or-found anchor click into a specific profile,
per hop. D121's own note is that for an arbitrary prospect that fetch usually does not fire, so
"verify Voyager, else DOM" falls to DOM on most targets *after* paying for the extra navigation,
the DOM write into LinkedIn's page, and the added account activity. Voyager-first was theatre
over a DOM read. Dropped for the honest version: read the DOM directly.

**Why the DOM is tractable here when the RSC tree was not.** D121 rejected the document's
`__como_rehydration__` flight tree because the subject and a "people also viewed" stranger have
identical shape at different, meaningless indices. The *rendered* DOM does not have that problem:
the subject's content lives in the main profile container (`main#workspace` / the top card) and
the suggestions live in a sidebar `aside`. Container scoping distinguishes them — position in a
serialized JSX stream could not.

**Why DOM despite the churn risk.** A DOM parser breaks silently when LinkedIn renames a class —
exactly what D1 was written to prevent. Bounded by: (a) content only — identity, the thing
keys and dedupe depend on, stays on a stable Voyager body; (b) every content row tagged
DOM-sourced so it is never mistaken for a labeled one; (c) the same parse-drift exit code (5)
and field-level warnings as any parser, so a class rename surfaces as loud drift, not a
half-empty row. It is the pragmatic floor, chosen over abandoning the capability.

**Rejected.** Voyager-first with DOM fallback (above — theatre over a DOM read for most targets,
at real navigation and account cost). Parsing the RSC flight tree by position (D121: prospect
and stranger are the same shape at different indices). DOM for identity too (throws away the one
stable body we do get and would make dedupe drift-prone).

## D124 — the DOM snapshot is archived like a body, and recorded as something no server sent (2026-08-09)

**Decision.** `profile.capture` takes one `Runtime.evaluate` after layout settles and the
human-paced scroll, returning `document.documentElement.outerHTML`, and archives it through
the same `RawArchive` as every tapped body (D2). It is recorded distinctly: `status: 0`,
`method: "DOM"`, `pattern: "dom-snapshot"`, and a synthetic url `dom-snapshot:<targetUrl>`
whose scheme is deliberately not `http`.

**Why archived the same way.** D123 makes the rendered DOM the content source. A parser has
to be provable offline against a real page (D12/D119), which means the page has to be on disk
before anything reads it — the identical argument raw-first was written for. Giving the
snapshot its own storage would have meant a second archive with its own bugs.

**Why recorded differently.** `counts.captured` is what an operator reads as "how much
LinkedIn served". A DOM read counted among the tapped bodies inflates it, and a snapshot
recorded as `status: 200` is indistinguishable from something LinkedIn actually answered with.
Promotion, the receipt and the summary all branch on this, and the branch reads the sidecar's
`pattern` first and the url prefix only as the fallback for a sidecar that failed to write
(`ARCHIVE_SIDECAR_FAILED`, D31).

**It never throws.** Both failure modes — the page would not answer, the archive would not
take the answer — are warnings with their own codes (`DOM_SNAPSHOT_FAILED`,
`DOM_SNAPSHOT_NOT_ARCHIVED`), because by the time the snapshot runs the page load is spent
and 26 archived bodies with no snapshot are worth more than a halt. A lost snapshot logs
`capture.miss`, never a `capture.hit` with a null filename.

## D125 — cheerio for offline HTML parsing (2026-08-09)

**Decision.** `cheerio` (1.2.0) is a runtime dependency, used by the fixture tooling now and
by Task 17's parser next. Operator-approved before it was installed.

**Why a dependency at all.** D123 puts the profile's content in the rendered DOM, and the
field map has to name paths that are *checkable against the archived snapshot* — the property
that makes a field map worth anything. Node has no HTML parser. The alternative considered
and rejected was discovering selectors live in the page during capture: the browser has a
real DOM, but nothing would then verify those selectors resolve in the fixture, and Task 17
needs an offline parser regardless — it defers the same decision at the cost of an unverified
map.

**Why cheerio over the alternatives.** It is parse5 (the spec-compliant HTML5 parser jsdom is
built on) plus css-select, which is what makes container scoping expressible as a selector.
`node-html-parser` is lighter and single-package but is not spec-compliant on malformed
markup — and LinkedIn's 875KB server-rendered page is exactly where that bites, producing a
field map that looks right and is not. Bare `parse5` has no selector engine, so every scope
rule would be hand-written tree-walking.

## D126 — `voyagerIdentityDashProfiles` returns the *operator's own* urn, not the subject's (2026-08-09)

**Finding, measured. It corrects D121 and reopens the identity half of D123.**

D121 recorded `identityDashProfilesByMemberIdentity["*elements"][0]` as the subject's urn and
concluded "identity is solved". That was never cross-checked against the session's own
identity, and it is wrong.

Run `01KZJ5N27BPGY3AWGQ8FTB0C3J`, a cold load of `/in/tankots/`, captured the body at
`$.data.data.identityDashProfilesByMemberIdentity["*elements"][0]`:

    urn:li:fsd_profile:ACoAAE1JGFIBwVzih4BX7SXeW9WLwcBP6lmQE3s

**Sharpened 2026-08-09, same day, from the sidecar: the request proves it structurally.** The
url that body answered is

    /voyager/api/graphql?includeWebMetadata=true
      &variables=(memberIdentity:ACoAAE1JGFIBwVzih4BX7SXeW9WLwcBP6lmQE3s)
      &queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a

The operator's own urn is the **input**. This call is the session resolving itself, which it
does on every page; it takes a member identity and returns that member. It could not have
returned the prospect under any circumstances, on any profile, ever. What follows is not "this
endpoint happened to answer with the wrong person" but "this endpoint was never a subject
lookup", and no amount of re-running it would have shown otherwise.

That also downgrades the third option below. "Find a Voyager call that resolves a stranger's
identity" is not "none seen across four live loads" — it is that the one call we had is
structurally the wrong shape, and nothing observed points at another.

and `/voyager/api/me`, in the same run, carries
`urn:li:fs_miniProfile:ACoAAE1JGFIBwVzih4BX7SXeW9WLwcBP6lmQE3s` with
`publicIdentifier: "zaeem-dev"` — **the operator's own account.** The same key, on a page
about somebody else. The endpoint's name says so plainly once read carefully: profiles *by
member identity*, and the member identity is the logged-in member's.

D121 quoted the same urn prefix (`ACoAAE1JGFIB…`) as the subject's. It was the operator's
then too; nothing compared them.

**Consequence.** No captured body in the run carries the subject's urn. Sweeping all 27
archived bodies for `urn:li:fsd_profile:` values that are not the operator's returns hits only
in the notifications card and the messaging thread list — other people, both private endpoints
(D118), neither the subject.

So `profile.get` cannot key on a Voyager body. D123's content half stands; its identity half
does not, and D127 is where the subject's identity actually turns out to be. Recorded rather
than acted on: D123 is an operator decision and changing its source is the operator's call.

**This is D119's trap for the third time** — first in a generated field map, then in the
document's A/B tracking (D121), now inside the decision that was supposed to be the safe half.
The rule that keeps catching it is the cheap one: never accept an identity without comparing
it to `/voyager/api/me`. `checkIdentity` now does that on every run and reports
`IDENTITY_URN_IS_SESSION` on the receipt.

## D127 — the subject is identified by the SDUI card-ref namespace, not by container position (2026-08-09)

**Finding, measured on the live snapshot, and the reason the DOM is tractable at all.**

D123 justified reading the DOM on the grounds that the subject sits in `main#workspace` and
the suggestions sit in a sidebar `aside`. That is **not** what the page does: the live
snapshot's only `aside` is *inside* `main#workspace` (the capture warns
`SUBJECT_CONTAINER_NOT_SCOPED` for exactly this). Container position does not separate them.

What does separate them is better than position. Every profile card carries

    componentkey="com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>"

— 23 of them on the live page (`Topcard`, `About`, `ExperienceTopLevelSection`,
`EducationTopLevelSection`, `Skills`, `Projects`, `RecommendationsTopLevel`, …), all
namespaced by **one** profile id, and that id is the subject's. The "people also viewed"
strangers live in the `SuggestedForYou` card, which is namespaced by the subject's id too —
so scoping by id alone does not exclude them, and the card *name* is what does.

**Subject identity therefore comes from the DOM as well**, from that namespace:
`urn:li:fsd_profile:<PROFILE_ID>` where `PROFILE_ID` is the prefix every card ref shares. The
live run resolved `ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA` — which is **not** the operator's,
and is corroborated by `urn:li:member:306907360` on the top card's own Connect and Follow
buttons. Cross-checked: the id appears nowhere in `/voyager/api/me`.

**How the id is cut, and why that needed care.** It is the longest common prefix of every
`AC…` card ref suffix; with twenty-odd cards whose names diverge at the first character, that
prefix is the id exactly, and no id length is hardcoded. Two failure modes are handled rather
than hoped away: a snapshot in which only *one* card rendered gives a prefix of `<id>Topcard`,
which passes the id shape and yields a confidently wrong urn — a known card-name suffix is
peeled off first. And a boundary cut in the wrong place shows up as card names that are not
ones this build has seen (`ATopcard`, `ZAbout`), which the field map reports and, past half of
them, tells the reader not to key anything on.

**Amended 2026-08-09, same day: a candidate id that names no cards is not an id.** The
peel above handles a single card whose name `KNOWN_CARDS` lists. A single card whose name it
does **not** list leaves that name stuck on the prefix, and `<id>BrandNewCardName` passes the
id shape cleanly — so the resolver returned a real person keyed on a urn wrong by seventeen
characters, with an empty card list and no warning anywhere, which is the worst of the three
possible outcomes. The id is *defined* as the namespace the cards share, so the cards confirm
it: zero cards now resolves `null`. It does not over-fire — two refs make the common prefix
end at the id, so LinkedIn shipping a new card name costs nothing. Regression-tested, and the
test verified to fail against the unguarded version.

**Rejected.** Scoping by `main#workspace` alone (measured: contains the sidebar). Scoping by
class name (they are content-hashed — `_3bbeb416` — and churn every deploy; nothing here reads
one). Position in the RSC flight tree (D121).

## D128 — every DOM field-map hit carries the basis it was found by (2026-08-09)

**Decision.** `buildDomFieldMap` labels each hit `componentkey` / `position` / `text-shape` /
`attribute`, and the rendered map says what each one means for drift.

**Why.** The live snapshot splits cleanly in two, and a map that hid the split would be
misleading in the direction that costs most. The *cards* are semantic and subject-scoped, so
`experience`, `education`, `skills` and `about` are one selector each and survive a restyle.
*Within* the top card there is nothing named: headline and the company·school line are
`p:nth-of-type(1)` and `p:nth-of-type(2)` under a chain of anonymous divs, and location is
found by the shape of its own text. Those break the first time LinkedIn re-lays-out the card.

D123 accepted DOM churn as the price of the capability, with drift surfacing loudly. This is
what makes that promise concrete per field instead of per parser: Task 17 can see which four
fields are cheap and which three need a drift check, before writing any of it.

**One thing this caught immediately.** The first generated map reported the subject's location
as `105,570 followers` — a comma-separated string with no `·`, which is exactly what the
text-shape rule was looking for. A place name has no purely numeric component; the rule says
so now. A `componentkey`-based field could not have failed that way, and that difference is
the whole point of recording the basis.

## D129 — the captured-data gitignores are anchored to the repo root (2026-08-09)

**Bug, found while committing Task 16.** `.gitignore` carried `fixtures/` and `runs/`
unanchored, and a git pattern with a trailing slash and no leading slash matches a directory
of that name **at any depth**. So `src/core/fixtures/` — Task 15's `promote.ts` and
`fieldmap.ts` — was ignored along with the captured bodies, and had never been committed at
all. `scripts/promote-fixtures.ts` imports both, so a fresh clone did not build. `git log`
over the path returns nothing; this was not a deletion, the files were never tracked.

Both patterns are now `/runs/` and `/fixtures/`. The directories they exist to keep out of git
— the raw archives and the promoted prospect bodies — are both at the repo root, so anchoring
loses nothing, and it is verified in both directions: the root ones are still ignored, and
`src/core/fixtures/` is not.

**Worth remembering** because of how it hid. Everything worked: the tests import the module by
relative path, the promoter runs, `tsc` is clean. Nothing in a working tree can tell you a file
is untracked, and `git status` said "clean" precisely *because* the file was ignored. The
general shape: an ignore rule silently widening beyond its intent produces no error anywhere,
and the only symptom is on a machine that does not have the working tree.

## D130 — identity comes from the DOM too; the profile reader has one source, not two (operator decision, 2026-08-09)

**Supersedes the identity half of D123.** The content half of D123 is unchanged and stands.

**Numbering note.** Task 16 owns D120–D129 (D18) and all ten are used. This is an operator
decision taken in the Task 16 session that governs Task 17, so it takes D130 and **Task 17's
reserved range becomes D131–D139**. Recorded here and in `STATE.md` so the next session does
not collide.

**Decision.** `profile.get` reads the subject's urn from the rendered DOM snapshot, from the
SDUI card-ref namespace every profile card shares (D127):

    componentkey="com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>"

giving `urn:li:fsd_profile:<PROFILE_ID>`. §7's schema is untouched — that is a real profile
urn of the form `persons.urn` already holds, so no migration is edited (D99). The vanity slug
and the member urn on the top card's action buttons are stored alongside as corroboration,
not as the key.

**Why the previous answer stopped being available.** D123 put identity on
`voyagerIdentityDashProfiles` on the reasoning that keying must not depend on a source that
churns. D126 established that this endpoint takes `memberIdentity=<the operator's own urn>` as
its **input** and returns that member: it is the session identifying itself on every page, and
it cannot return a stranger on any profile. Across one live run, zero of 27 archived bodies
carried the subject's urn; the only non-operator profile urns were in the notifications card
and the messaging thread list, both private endpoints (D118), neither the subject. There is no
Voyager source to prefer, so D123's split cannot be honoured as written.

**Why the DOM is acceptable for a key here, given D123 refused exactly this.** D123's objection
was that a DOM parser breaks silently, and a silently wrong *key* is the worst failure this
project has — it writes a row under the wrong person and nothing ever notices. That objection
is answered by the failure direction rather than by the drift rate:

- The resolver returns `null` when it cannot resolve, never a guess. Three separate ways it
  could have returned a confident wrong id were found and closed while building it — an
  unscoped member urn collecting sidebar strangers, a single known card leaving its name on
  the id, and a single *unknown* card doing the same (D127, amended). Each is regression-tested
  and each test is verified to fail against the unguarded version.
- A candidate id that names no cards is not an id. The id is *defined* as the namespace the
  cards share, so the cards confirm it.
- A capture with no resolvable identity reports that on the receipt and stores nothing, rather
  than storing content under a key it invented.

So the realistic failure is "LinkedIn changed the attribute scheme and the run stops", which
costs a manual fix, not "the database quietly gains a wrong row", which costs the dataset.

**Why not the vanity slug.** It is available before the page even loads, which is genuinely
attractive. D104 already settled why it cannot be a key: vanity is reassignable and not unique,
which is why `findPersonByVanity` returns the newest match plus a count instead of an answer. A
person who changes their slug reads as a new person; a slug reclaimed by someone else merges
two people. It would also mean changing the schema's primary key, and D99 forbids editing that
migration.

**Why not keep hunting for a Voyager source.** Each attempt is a real page load on the one
account. Four live loads have produced no candidate, and the one that looked like a candidate
is structurally incapable of it (D126). Spending account activity on a search with no lead is
not a trade this project makes.

**What this does not license.** The DOM is a sanctioned source for the profile reader
specifically — content (D123) and now identity — and nowhere else. Every other capability, and
every other kind of field, still reads data only from captured network bodies (D1). Reading a
data field off the RSC flight tree by position stays forbidden (D121). Identity rows are tagged
DOM-sourced like content rows, so nothing downstream can mistake either for a labeled API field.

**Corroboration, not fallback.** The member urn (`urn:li:member:<id>`, from the top card's own
Connect and Follow buttons) and the vanity slug are both captured and stored. They are a
cross-check — a stored person whose vanity and urn disagree on a later capture is a finding
worth surfacing — not a chain to fall back through. Falling back to a weaker key on a bad day
is how a dataset ends up with two spellings of one person.

**Amended 2026-08-09, same day: the receipt now says this too.** D130 changed where identity
comes from and left `profile.capture`'s receipt describing the old arrangement. Three warnings
— `IDENTITY_BODY_ABSENT`, `IDENTITY_URN_ABSENT`, `IDENTITY_URN_IS_SESSION` — still asked
whether the Voyager body had answered, and the first of them said in as many words that a run
without it "has no subject urn to key the profile on", which after D130 is false.

`IDENTITY_URN_IS_SESSION` was the worse half. Per D126 that endpoint takes the operator's own
urn as its input and returns that member, so it answers the same on every page: that warning
was going to fire on **every capture, forever**. A warning that always fires is one an operator
learns to skip past, and it would have sat in the same block as the identity warnings that do
mean something. The rule this is an instance of: a signal that cannot vary is a measurement,
not a warning.

So the Voyager check is demoted to `data.identity.voyager`, kept because a *change* in that
answer would be worth knowing about, and raising nothing. In its place three warnings that can
only fire when something is actually wrong:

- `SUBJECT_IDENTITY_UNRESOLVED` — the snapshot archived but no id resolved from the card-ref
  namespace. The capture cannot be keyed and nothing may be stored from it.
- `SUBJECT_IDENTITY_IS_SESSION` — the id resolved to the operator's own account. Must never
  fire; kept because this exact trap has now been found in three separate places (D119, D121,
  D126) and each time it was found by comparing rather than by assuming.
- `SUBJECT_CARD_NAMES_UNRECOGNISED` — card names this build has not seen. The check on the id
  boundary from the other side: a boundary cut in the wrong place shows up as names shifted by
  exactly the characters the id is wrong by.

`data.identity` carries the outcome — resolved, the urn *family* only, how many cards agreed,
stranger-card and member-urn counts. The id itself is never on the receipt: it is the
prospect's identity and receipts go to stdout (§4.1, D3).

Also amended here: `CLAUDE.md`'s network-tap bullet opened "never from the rendered DOM" and
spelled the exception out ten lines below. A rule marked non-negotiable is exactly the line a
session absorbs as a headline without reading on, and a session that did would refuse to write
the parser Task 17 asks for. The bullet now names the exception in its first sentence.

No live run. This changes what the receipt says about a capture, not what the capture does.
Proven: 717/717 offline, typecheck clean, 15 new tests. Two mutations verified to bite —
re-adding the always-firing warning fails the demotion test, and removing D130's
cards-confirm-the-id guard fails the refusal tests at both layers.

## D131 — the profile parser requires the session identity comparison set (2026-08-09)

**Decision.** `parseProfileSnapshot` requires a non-empty `sessionUrns` input, derived from the
`/voyager/api/me` body the page fetched. With no comparison set it returns no person and reports
`PARSE_SESSION_IDENTITY_UNAVAILABLE` with parse-drift exit semantics. It never treats “nothing to
compare against” as “not the operator.”

**Why.** D119, D121 and D126 each found the operator's identity in a place that looked like the
subject. Making the comparison optional at the parser boundary would leave Task 19 one omitted
argument away from repeating the same failure under a real primary key. The promoted DOM fixture
has no `/me` body beside it, so fixture tests pass an explicit non-matching test urn; production
must pass `sessionUrnsOf(captures)`. A missing `/me` response is therefore visible drift rather
than an unchecked parse.

## D132 — parser metadata wraps store inputs; it never extends them (2026-08-09)

**Decision.** Parsed person and experience rows are `{ source: "dom-snapshot", value: ... }`
wrappers around Task 14's exact `PersonInput` / `ExperienceInput` shapes. Descriptions and
corroboration stay beside those values. `toPersonStoreInput` is the only projection into the
store interface and drops parser-only metadata explicitly.

**Why.** Every parsed row must remain visibly DOM-sourced (D130), and the live experience card
carries descriptions, but the applied schema has columns for neither source nor description.
Intersecting those fields onto `ExperienceInput` looks convenient and is unsafe: `upsertPerson`
spreads its input into the PostgREST payload, so an extra property becomes an unknown database
column and the whole write fails. Rejected: silently discarding descriptions during parsing —
raw-first means the projection may be narrower than the capture, but the parser should preserve
what it understood for a later migration or re-projection.

## D133 — a DOM identity needs a subject card and a recognizable card-name boundary (2026-08-09)

**Decision.** A card-ref profile urn is trusted only when at least one resolved card describes
the subject (not only `SuggestedForYou`) and unrecognized card names are no more than half of all
resolved cards. `checkDomIdentityScope` is the single implementation of that rule; both the
capture receipt's HTML wrapper and the profile parser delegate to it.

**Why.** `SuggestedForYou` is namespaced by the subject's id while carrying other people, so its
namespace alone cannot certify subject content. A majority of unknown names is D127's signal
that the longest-common-prefix cut may have moved into the card-name suffix, making the urn wrong
by the same characters. Rejected: recomputing these guards in the parser after
`checkDomIdentity` — two copies of a load-bearing identity rule can drift, and it parsed the same
875KB snapshot twice for no additional evidence.

## D140 — the log-query capabilities are named `log.<verb>`, not `log:<verb>`
2026-08-08, Task 18. Spec §5's table writes `log:why`, `log:errors`, `log:drift`, `log:runs`
with colons, and the task file quotes those names verbatim. Implemented as `log.why`,
`log.errors`, `log.drift`, `log.runs` instead.

D81's registry requires the directory name to equal the capability name, and Task 12 already
pinned a general invariant on every capability name — `tests/cli-registry.test.ts`, "scans a
real directory tree and every entry it finds is a well-formed capability" — asserting
`/^[a-z0-9]+(\.[a-z0-9]+)+$/` against `loadCapabilities()`'s real scan of `src/capabilities/`.
A colon fails that regex outright; landing `log:why` would either break an already-green
Task 12 test or require weakening an invariant written for every capability, present and
future, to fit four names whose punctuation was illustrative table formatting, not a
consumed contract — nothing parses `log:why` as a wire format anywhere in the codebase.
Dot notation keeps the CLI surface `cap log.why --run=<id> --item=<ref>` and costs nothing
else: no runtime dependency, no interface another task consumes, no change to the attach
surface or safety model.

## D141 — log queries read the run archive directly; they never call `RunContext.open({ runId })`
2026-08-08, Task 18. `src/core/log/queries.ts` reads `run.json` / `summary.json` /
`events.ndjson` with plain `fs` calls, reusing only `readEvents` from `core/run/events.ts`.

`RunContext.open({ runId })` is a resume, not a read: it appends a `resumed_at` timestamp to
`run.json` and logs a `checkpoint.resume` event into the run it opens (Task 6, D22). Every
log-query capability is a read of a run some other invocation owns — often one that failed
and is being inspected for exactly that reason — and mutating it to look at it would corrupt
the forensic record `log:why` exists to read faithfully, and would make `log:runs`'s own
scan of `runs/` change the very data it is scanning mid-query. A corrupt `run.json` for one
run degrades to a visible `status: "corrupt"` entry rather than throwing, so one damaged run
directory cannot take down a query spanning every run (`log:runs`, `log:drift`).

## D142 — `log:runs` excludes its own kind by default (2026-08-09)

**Decision.** `listRuns` skips runs whose capability matches `^log\.` unless `--include-queries`
is passed.

**Why.** Every `log.*` invocation goes through `execute()` and therefore creates a run
directory. Those runs sort newest-first, so they land at the top of the very answer they
produce, and each debugging session adds more. Measured against an archive of 250 real runs:
the query's own run occupied slot 0 and, past the cap, real runs get pushed out — `log.runs`
converges on reporting `log.runs`. A query that answers with its own history is not a debugging
tool.

Excluded rather than not-archived: the receipt trail for a local query still has value, and
dropping it would be a bigger change to `execute()` than the problem justifies.

## D143 — the result bound is bytes, not only a count (2026-08-09)

**Decision.** `MAX_RESULT_BYTES = 32_768` applies to every query result alongside the existing
count caps. Whichever bites first wins. Truncation still drops from the end furthest from
"now", so the two bounds never disagree about which rows survive, and never below one row.

**Why.** The count bound worked exactly as written and still missed. A live capture's events
run about 340 bytes each; 500 of them serialize to **170,142 bytes** on stdout — roughly 42k
tokens, for a capability whose stated objective is "debugging costs hundreds of tokens, not
hundreds of thousands", and against `CLAUDE.md`'s "never print large results". 500 was chosen
without anyone multiplying it by a row width.

After: the same probe returns **33,278 bytes**, 96 events, `dropped: 504`.

**Also here:** `LOG_RESULT_TRUNCATED`'s `n` was the number of rows *returned*, which reads as
the number dropped. It is now the number dropped, and `dropped` is on `data` as well.

**Never zero rows.** A single event wider than the whole budget is returned anyway. Returning
nothing because one row is too big would be the silent-empty result this capability exists to
prevent.

## D150 — the primary person write precedes its parse-drift mirror (2026-08-09)

**Decision.** `profile.get` writes the person and experience rows first, then inserts the
parser's warnings into `parse_drift`. If the second write fails, the run fails with the store
layer's unchanged classification and `partial.stored` names the exact person/experience rows
that already landed.

**Why this order.** `parse_drift` is the queryable mirror of `parse.miss` events; the event is
already on disk before either database write. Writing drift first creates a worse retry shape:
the primary write can then fail, and retrying appends the same drift observations again because
the table intentionally has no uniqueness key. Writing the primary rows first makes the only
partial state a complete, fresh person plus a missing auxiliary mirror; the receipt exposes it,
and the durable run event still feeds `log.drift`.

Rejected: swallowing the drift-store failure as an ok receipt. The task requires the mirror,
and reporting success would make a database outage indistinguishable from zero parser warnings.
Rejected: adding a transaction/RPC solely for these two writes — that would add schema and
runtime surface for an observability mirror whose source event is already durable.

## D151 — a vanity cache hit must be unambiguous (2026-08-09)

**Decision.** Before loading a `/in/<vanity>` page, `profile.get` serves a fresh cached person
only when `findPersonByVanity` reports exactly one match. More than one match falls through to
the live capture, whose card-ref namespace resolves the current subject urn. A Sales Navigator
lead id is looked up by its `urn:li:fsd_profile:<id>` spelling instead.

**Why.** D104 records that vanity is reassignable and deliberately non-unique. Returning the
newest row is useful for inspection, but it is not identity resolution; a cache shortcut that
treated it as one could serve the prior owner of a reclaimed slug without any page evidence.
The safe failure direction costs one page load and produces a real urn rather than returning a
fresh wrong person.

## D152 — M4 makes probe-first mandatory: no parser before a real-load fixture exists (2026-08-09)

**Decision.** Every M4 page surface gets a dedicated live probe task that runs *first* and
whose only deliverable is measurement — every response body and a DOM snapshot archived, a
`FIELD-MAP.md` whose every path is pinned by an offline test against the promoted fixture,
and a per-field source verdict. No parser or store task for that surface may start until its
fixture is on disk in the repo. A parser task file names its fixture; if the file is absent,
the task is blocked, not begun.

**Why.** Every expensive M1–M3 failure had one shape: a task built on an assumed LinkedIn
data shape that a live probe later falsified. The profile parser was planned twice against
Voyager JSON that does not exist on a cold load (D116, D121); the identity source was
falsified by its own first live run (D126); the scroll model assumed the document scrolls
(D115); the promoter shipped the operator's own inbox as the subject (D118/D119). Every task
that began from a live measurement landed on the first try; every task that began from an
assumption was re-cut and rebuilt. The sequence Task 15 → 16 → 17 → 19 is the one that
worked, so M4 makes it structural rather than a thing a diligent agent might do. The
alternative — embedding the probe inside each capability task — was rejected because it lets
probe evidence and parse code share a commit, which is exactly how an assumption slips back
in unreviewed.

## D153 — per-capability daily budget sub-caps (2026-08-09)

**Decision.** Each L1 reader gets its own daily spend cap in the budget ledger, evaluated in
addition to the existing global limits (§8: 60/hr, 400/day, etc.). A runaway loop on one
reader trips its own sub-cap at exit 7 long before it can exhaust the shared daily budget
that every other capability draws from. The §8 override rule is unchanged: an override lowers
a cap, never raises or bypasses it, and no flag bypasses the ledger.

**Why.** M4 multiplies the number of distinct readers that spend against one shared ledger.
With only global limits, a single mis-paced new reader — a pagination loop that does not
terminate, a `--limit` that bounds output but not work — could burn the whole account's daily
allowance before the global cap notices, taking every other capability down with it. A
per-capability cap turns that blast radius from "the account for the day" into "this one
reader for the day", which is a receipt the operator can act on. Rejected: relying on the
global cap alone (blast radius too large) and rejected: tighter global caps (would throttle
legitimate mixed workloads to protect against one bad actor).

## D160 — the global limit is evaluated before the sub-cap, and one exit code covers both (2026-08-09)

**Decision.** `evaluate` checks the §8 global limits first and the per-capability daily
sub-cap (D153) second. Both refuse with the same `BUDGET_EXCEEDED` / exit 7 /
`HALT_AND_NOTIFY` / non-retryable error; the *evidence* carries `scope: "global"` or
`scope: "capability"` plus the capability name, and the message names it in words.

**Why.** One code per distinct operator action: in both cases the operator stops and the
run is over, so splitting the code would make callers branch on something they cannot act
on differently. What *does* differ is the fix — wait out the day versus go look at one
runaway reader — and that is evidence, not classification. Global first because if the
account-wide budget is gone that is the larger fact, and because it keeps every message an
existing global refusal already produced unchanged now that a second cap exists.
Rejected: a separate `BUDGET_CAPABILITY_EXCEEDED` code (a new code for the same action) and
sub-cap-first (would report "one reader is out" while the whole account was actually out).

## D161 — `capability` is required on `check`, not optional (2026-08-09)

**Decision.** `CheckInput` requires `capability`, so `check()` and `spend()` take it alike;
`RunBudget` binds it from the run rather than accepting it from the caller.

**Why.** The sub-cap is keyed on the capability. An optional field means a caller that omits
it gets a preflight that silently evaluates only half the caps and returns "you have room" —
a fail-open in the one module whose entire job is to fail closed. Making it required moves
that from a runtime hazard to a compile error. The cost is a one-line change at the four
existing call sites. Rejected: defaulting to a `"unknown"` bucket (all uncredited spend
would then share one cap and the receipt would name a capability nobody ran).

## D162 — every capability is sub-capped, including ones absent from the table (2026-08-09)

**Decision.** `subCapsFor(name)` returns `CAPABILITY_SUB_CAPS[name] ?? DEFAULT_CAPABILITY_SUB_CAPS`
— 150 page loads, 25 search pages, 60 distinct profiles per day. A table entry is the
capability's own default and may sit *above* the fallback (`profile.capture` and
`profile.get` are at 200/0/90); the §8 lower-only rule governs per-invocation `subCaps`
overrides, which can never raise the resolved number.

**Why.** M4 adds ten readers. If absence from a constants table meant "uncapped", the first
new reader written by someone who did not read this file would land uncapped — and an
uncapped reader is exactly the failure D153 exists to prevent. Absence is not an exemption.
The fallback numbers are roughly a third of each §8 global, so one bad reader burns a third
of the day at worst. Rejected: requiring an entry per capability and throwing without one
(turns a missing constant into a runtime failure of an otherwise-correct capability).

## D163 — a profile another capability opened still costs this capability a sub-cap unit (2026-08-09)

**Decision.** `profile_open` dedupe is per scope. A ref already opened today is free against
the global 120; against the sub-cap it is free only if *this capability* already opened it.

**Why.** Global dedupe exists so the account is not charged twice for one view — that is a
LinkedIn-facing fact and it is unchanged. The sub-cap is a blast-radius guard, and with
shared dedupe a runaway reader could re-walk every profile another run opened today at zero
sub-cap cost, which is the exact loop the sub-cap exists to stop. Rejected: sharing the
dedupe set (leaves the runaway case uncapped).

## D164 — the launcher's reuse path requires a live target; the launch path is unchanged (2026-08-09)

**Decision.** B5 as settled: on the reuse path only, `ensureChrome` accepts an endpoint only
if `GET /json/list` returns at least one target. `hasLiveTarget` never throws — an
unreachable, non-200, non-array or empty list is all `false` — and any `false` falls through
to the existing launch path. Discovery on the launch path, and the attach surface, are
untouched.

**Why (for the "cannot tell" case, which BACKLOG did not settle).** Treating an unreadable
`/json/list` as healthy is the same reasoning that produced B5's misleading receipt: a
`false` costs at most one launch attempt, which reports the real environment problem with a
fatal code, while a wrong `true` hands preflight a browser on which every browser-level
command fails behind a retryable code no retry can fix.

**Residual, recorded rather than fixed.** In the B5 condition the fall-through spawns Chrome
against the same `--user-data-dir`; the running instance takes the handoff and normally opens
a window, which is what restores the target. If it does not, the launch path's discovery
(unchanged, by B5's terms) still answers and returns `launched: true` on a browser that may
still have no context — the next invocation then relaunches again rather than wedging. Making
the launch path also require a target would change discovery on that path, which B5 explicitly
put out of scope.

## D170 — the company probe is its own capability, not a `--probe` flag on a company reader (2026-08-09)

**Decision.** `src/capabilities/company.probe/`, registered like any other capability and
run through the same runner: preflight, tab lease, budget ledger, challenge gate,
raw-first archive, receipt. Task 21's alternative — a `--probe` face of the eventual
capture path — was rejected.

**Why.** A capability is the unit the ledger's per-capability sub-cap is keyed on (D153,
D161). A `--probe` flag on `company.get` would spend against `company.get`'s cap, so a
morning of probing would eat the reader's budget for the day, and no cap could be set that
was tight for the probe and loose for the reader. As its own name it takes
`{ pageLoadsPerDay: 12, searchPagesPerDay: 0, distinctProfilesPerDay: 0 }` — twelve is two
full probe runs, and the two zeroes are enforced assertions that this capability never
searches and never opens a profile.

It also keeps `company.get` (Task 22) from having to exist before it can be designed, which
is the ordering D152 exists to impose.

**Rejected: a script.** CONTEXT rule 8 forbids it, and correctly — an ad-hoc script has no
lease, so it can run beside another capability on the same Chrome, and no ledger, so its
loads are invisible to every limit that protects the account.

## D171 — one page load per sub-page, and the tab links are measured rather than clicked (2026-08-09)

**Decision.** The probe navigates to `/company/<slug>/`, `…/about/`, `…/posts/`,
`…/people/` and `…/jobs/` as five separate cold loads. It does **not** click LinkedIn's own
tabs, and it records, per sub-page, the url it asked for beside the url it landed on
(`SUBPAGE_REDIRECTED` when they differ).

The SPA question Task 21 asks — is a sub-page reachable only by an in-page route — is
answered from the DOM instead: the surface probe reports, per sub-page, whether the page
carries a real `a[href]` to it and how many. An `href` means a cold load is the page's own
navigation rather than something this toolkit invented.

**Why not click.** Clicking is more code, more state and more ways to be mid-transition
when the snapshot is taken, and its payoff is a page load saved — but the loads are already
inside a six-load budget and the probe's product is *comparable* per-sub-page evidence.
Five cold loads give five documents, five snapshots and five clean capture attributions; a
click gives a DOM that changed under a tap whose cursor cannot separate what the click
fetched from what was already there.

**Why measure the links anyway.** A sub-page with no `href` anywhere is a sub-page Tasks
22–25 cannot reach the way this probe did, and that is exactly the kind of thing that is
invisible until it is measured. Cheap: it rides on the one `Runtime.evaluate` already
being made.

## D172 — a sub-page that fetches nothing is a finding, not a failure (2026-08-09)

**Decision.** Where `profile.capture` throws `TAP_TIMEOUT` when the broad net answers
nothing, the probe records `api_response: false`, warns `SUBPAGE_NO_API_RESPONSE`, and
carries on to the scroll, the snapshot and the surface measurement.

**Why the two differ.** `profile.capture` exists to capture a payload, so no payload means
the page load was wasted and stopping is right. The probe exists to *find out where the
payload is*, and "this tab issues no API call, so its data is in the document response or
the DOM only" is one of the four answers it was built to return. Throwing would discard the
document response and the snapshot — the two artifacts that would have contained the answer.

The timeout is also shorter here (15s against 25s) for the same reason: the cost of waiting
is seconds on a question whose answer is informative either way.

## D173 — the sweep works backwards from values the operator states, not forwards from key names (2026-08-09)

**Decision.** `src/core/fixtures/sweep.ts`. The operator reads the rendered page and states
ground truth — "the website is `acme.example`" — and the sweep reports every place that
value actually appears, in which source, at which path. `scripts/sweep-sources.ts` runs it
over an archived run and renders the FIELD-MAP.

**Why not another probe list.** `buildFieldMap`'s `FieldProbe` (D-era Task 15) works
forwards: describe what a field might be *called* and report every path that matches. That
is the right tool for a surface nobody has seen, and it is also how D119's trap got into a
field map and how `location` came back as `105,570 followers` (D128) — a path can match the
shape of a field and hold something else.

Working backwards makes a hit meaning-checked by construction: it *is* the value, so it
cannot be the wrong field of the right shape. That is the property Task 21's acceptance
criteria ask for ("meaning-checked assertions, not shape-only") and it is not obtainable
from a key-name probe at all.

Both remain. The forward map inventories a surface; the backward sweep decides a source.

## D174 — the three sources are read strictly, and a snapshot's inline scripts are not "embedded json" (2026-08-09)

**Decision.** The sweep reads each document by exactly one rule:

- a captured JSON response → `voyager-body`, the whole body;
- the **initial document response** → `embedded-json` only, from
  `<script type="application/ld+json">` and `<script type="application/json">`, addressed
  by a path into the parsed JSON. Its markup is never read;
- the **DOM snapshot** → `dom-snapshot` only, from markup. Its inline scripts are never
  read as `embedded-json`.

**Why the last one needed saying.** A DOM snapshot is an HTML document and it contains the
same `<script type="application/json">` tags the original document did. Sweeping them and
labelling the result `embedded-json` would report a *DOM read* as the sanctioned source
D117 permits, and every consumer downstream reads that label to decide whether it may act
without an operator decision. The snapshot is post-hydration state, not something a server
sent. Both boundaries are regression-tested and both tests were verified to fail against
the unguarded version.

**Preference order** when several sources carry a field: `voyager-body` >
`embedded-json` > `dom-snapshot`, which is `CLAUDE.md`'s own order. An exact match sorts
ahead of a substring match, because an exact hit is a path a parser reads directly.

**Amended 2026-08-09, same day, in review: the embedded-json path comes from `cssPath`,
the same function the DOM walk uses.** It was hand-built as
`script[type="…"]:nth-of-type(<n>)` where `n` counted the scripts *this function had
collected so far* — across both types, across parents, skipping the ones that were empty
or did not parse. `:nth-of-type` counts siblings of the same **tag** within one parent and
the `[type=…]` predicate does not narrow that count, so on any page with a plain `<script>`
before the structured one, or with structured scripts under two parents, the committed
FIELD-MAP would have carried paths resolving to the wrong script or to nothing. A field map
whose paths do not resolve is the one thing this module's own contract forbids, and it
would have been discovered by Task 22 trying to use it. The regression test asserts sibling
numbering across two parents, numbering unaffected by a skipped unparseable script, and —
the property itself — that the emitted selector, fed back through cheerio, selects the
script the value came from.

## D175 — the committed FIELD-MAP carries no captured value (2026-08-09)

**Decision.** `renderSweep` prints field names, sources, files, paths and match kinds, and
**no sample values**, unless `--samples` is passed. The no-samples rendering is what goes
in `docs/capabilities/`; a `--samples` copy belongs in `fixtures/`, which is gitignored.

**Why.** Task 21 requires the FIELD-MAP to land in git while `fixtures/` stays out of it,
and RECORDING requires "never the captured value itself if it is personal data — name the
fixture and path instead". A company's own name is public business data, but the same
document maps the `people` sub-page, and there the values are individuals. A rule that
depended on classifying each field would be wrong the first time someone added a field.

Meaning is not lost: it moves to the pinning tests, which live beside the gitignored
fixture and already carry real values by established practice
(`parse.fixture.test.ts` asserts a real profile urn and a real city).

**Amended 2026-08-09, same day, in review: the `--samples` escape hatch is gone, not
fixed.** It rendered no samples at all — it only swapped the document's preamble for a
warning that the file "carries captured samples and must not be committed", which was
false in the one direction that matters. Reviewing the choice rather than the bug: a
samples column would have echoed the sweep's own input back, because every value in it is
one the operator wrote into `wanted.json`. So it bought nothing and turned a committable
file into one that leaks whoever the `people` sub-page listed. There is now no way to ask
for it, and a test asserts the parameter does not exist.

## D176 — the probe's receipt reports the page's construction, never its content (2026-08-09)

**Decision.** The surface measurement returns counts, tag names, element ids, and
`componentkey` values reduced to their **dotted namespace** — everything after the last `.`
is cut off, which is exactly where an id sits. `com.linkedin.sdui.organization.card.ref<ID>Topcard`
reports as `com.linkedin.sdui.organization.card`. A key with no dot at all is bucketed as
`(no dotted namespace)` rather than reported verbatim.

**Why.** §4.1/D3 keep captured data off stdout, and the obvious way to break that here is a
namespace inventory: it looks structural, and on the profile surface the analogous
attribute embeds the subject's profile id and, in one case, a `urn:li:member:` on a Connect
button. The values are all in the archived snapshot, where the offline sweep reads them
without printing them. Pinned by a test that asserts the rendered report contains neither
the id nor the member urn that were in the input.

The same rule governs the globals inventory: only names this build asked about
(`PAYLOAD_GLOBALS`) may come back, so a page answering with something else cannot put an
unreviewed string on the receipt.

## D177 — the scroller-selection rule is one implementation, embedded by both page scripts (2026-08-09)

**Decision.** `SCROLLER_SELECTION_JS` is extracted from `VIEWPORT_EXPRESSION` in
`profile.capture/read.ts` and embedded by both it and the company surface probe. Behaviour
is unchanged and the existing real-JS execution tests still pass against it.

**Why.** D115 is a measurement of *one* page; the rule that found it — the tallest element
with a real `overflow-y` and a viewport's worth of height — is what carries to a surface
nobody has measured. CONTEXT rule 3 says measure each surface's scroller rather than
assuming `main#workspace`, and two copies of the selection rule would be two answers the
day one of them was tuned. The company probe additionally reports *which* element won, so
the measurement is on the receipt rather than implied.

## D178 — `documentPattern` takes a name and `summarizeCaptures` takes a relevance rule (2026-08-09)

**Decision.** Two additive parameters on `profile.capture/patterns.ts`, both defaulted so
nothing existing changes: `documentPattern(url, name?)` and
`summarizeCaptures(captures, misses, patterns?, { isRelevant? })`.

**Why.** A run that loads five documents needs one watch per document or their hit counts
report as one row and answer nothing — D120 added the document watch precisely so the
question "did the payload arrive in the navigation response" became answerable per
document. And "does this body carry the subject's data" is the same machinery asked of a
company instead of a person; a second copy of `summarizeCaptures` is a copy that drifts,
which is the failure D120 itself was.

The `profile_ish` column keeps its name rather than being generalized. Renaming it would
touch `profile.capture`'s receipt shape, which `profile.get` and the live gates already
read; the company probe maps it to `company_ish` in its own receipt, which costs one line.

## D179 — the probe counts person-carrying bodies separately from company-carrying ones (2026-08-09)

**Decision.** Each sub-page reports both `company_ish` (`isCompanyIsh`, the company/job/post
urn family) and `person_ish` (`isProfileIsh`, unchanged).

**Why.** The `people` sub-page is the one surface in this family that carries person urns
and may carry no company marker at all. A probe reporting only company markers would say
"nothing here" about the surface with the most identity risk — Task 24 calls it a person-urn
minefield, and D119's trap has now been found in four separate places. Two columns cost
nothing and make the emptiness of one of them a fact rather than an absence. Pinned by a
test that gives the people sub-page a person-only body and asserts both columns.

## D180 (out-of-range, see note) — the tap is drained per sub-page, not once per run (2026-08-09, in review)

**Numbering note.** Task 21 owns D170–D179 (D18) and all ten are used. This is a Task 21
review fix that rises to a decision, so it takes the next free number; **Task 22's reserved
range becomes D181–D189.** Recorded here and in `STATE.md` so the next session does not
collide, exactly as D130 did for Task 17.

**Bug, found in review of `d5eb8d8`, before any live run.** `company.probe` summarized each
sub-page's captures *inside* the loop and drained the tap once, after it. A capture enters
the tap's list only when its body fetch and archive write have finished, so a body still in
flight at the moment of the slice was missing from its own sub-page's rows — and because
the next sub-page's cursor is taken after that body lands, it was then counted into the
**next** sub-page's window. On the last sub-page there is no next window and the row was
simply absent.

**Why it mattered more than it looked.** The run's totals are computed after the final
drain, so they were always right; only the per-sub-page attribution was wrong. Tasks 22–25
read `subpages[].endpoints` as "which endpoints does this tab fetch" — that is the probe's
primary deliverable, and a silently mis-attributed row is exactly the kind of measurement
error the probe exists to prevent downstream.

**Decision.** `await tap.drain()` immediately before each sub-page's slice, in addition to
the `finally` that covers the whole loop. Draining twice costs nothing — it settles
already-finished work — and the two answer different questions: the inner one makes
attribution complete, the outer one makes the archive complete on the throwing path (D2).

Pinned by a test where a fast body satisfies the api wait and a slow one is still on the
wire when the sub-page is summarized; verified to fail against the single-drain version.

## D181 (out-of-range) — a mid-probe halt is recorded in the event log, because it cannot be recorded on the receipt (2026-08-09, in review)

**Numbering note.** As D180: Task 22's range becomes D182–D189.

**Bug, found in review.** The probe pushed a `SUBPAGE_INCOMPLETE` warning describing which
sub-pages finished and where the failing one stopped. That warning was unreachable. A
sub-page can only fail by throwing out of the loop, and the runner builds an error receipt
from the error and the cost alone (`buildErr`) — a capability's warnings never reach it. The
README promised output that could not exist, and a live probe halting on sub-page three
would have left no record of which sub-pages completed.

**Decision.** The warning is deleted rather than made reachable, and the loop's `catch`
logs an `error` event naming the sub-page, the stage it stopped at, whether its page load
was spent, which sub-pages completed, and which were never attempted. `log:why` reads it.
The loads actually spent were already truthful on the error receipt's `cost`.

**Why not make it reachable** by catching and finishing with a partial ok receipt: a probe
halts for a challenge, a budget refusal or a failed navigation, and every one of those is a
reason to stop touching the account rather than to report success with a footnote. The
general shape, and the reason this is written down: **a warning added on a throwing path is
dead code**, because the receipt on that path is the runner's and is built from the error.

## D182 (out-of-range) — an unknown `--subpages` value is rejected by the args schema (2026-08-09, in review)

**Numbering note.** As D180/D181: Task 22's range becomes D183–D189.

**Bug, found in review.** `parseSubPages` threw `COMPANY_SUBPAGE_UNKNOWN`, and the README
documented that code — but the runner calls `def.cost(args)` before `run`, `cost` calls
`parseSubPages`, and `run.ts` wraps any throw from it as `COST_ESTIMATE_FAILED`. The
operator would never have seen the documented code, and the throw inside `run` was
unreachable behind it.

**Decision.** The schema validates it, via a `superRefine` that delegates to
`parseSubPages`. The runner checks args *before* it estimates cost, takes the lease or opens
a tab, so a typo now costs nothing and surfaces as `ARGS_INVALID` — the code the runner
actually emits for a bad argument. `parseSubPages` keeps its own throw for a caller that
invokes `run` directly, which Task 22's composition will, and the README documents both
paths rather than one that cannot happen.

## D183 (out-of-range) — a captcha selector match only halts when the widget is shown (2026-08-09)

The first live company probe (run 01KZKFR7RNRVA3FXPEJAKDQ30K) halted with
CHALLENGE_CAPTCHA on a perfectly normal, logged-in company page. The archived DOM
snapshot holds the culprit: LinkedIn's `pemberly.tracking.recaptcha.v3` experiment
mounts Google's invisible reCAPTCHA Enterprise on company pages — a
`display:none` `.grecaptcha-badge` whose anchor iframe (`size=invisible`) matches
both `iframe[src*="captcha" i]` and `iframe[title*="captcha" i]`, plus a sibling
iframe parked at `left:-9999px`. The three archived profile-surface snapshots
carry zero recaptcha references, which is why M1–M3 never tripped it: the widget
is surface-specific, and the company probe was the first time the selectors met
it.

The probe now requires a matched widget to be *shown*: a rect at least 2×2, not
entirely off-screen, and not hidden by computed `display`/`visibility`. The
alternative — dropping the two broad `captcha` substring selectors — narrows
detection, and narrowing is the unsafe direction. Visibility keeps every real
challenge (an interstitial someone must solve is by definition on-screen) while
excluding exactly the tracking badge. Every failure inside the visibility check
counts the widget as shown, so an unjudgeable page still halts; the URL and text
signals are untouched, so a checkpoint URL or challenge wording still halts
regardless of what the iframe looks like.

Numbering note: as D180–D182, this belongs to Task 21's live-run round and lands
out of range. **Task 22's reserved range becomes D184–D189.**

## D184 (out-of-range) — the company surface needs no DOM exception; LinkedIn's embedded JSON lives in `<code id="bpr-guid-N">` (2026-08-09)

The first company sweep reported nine fields as carried only by the rendered DOM —
`website`, `size_range`, `hq`, `about`, `hq_full`, `founded`, `post_reactions`,
`post_comments`, `job_posted` — and printed the `[DECISION NEEDED]` asking the
operator to extend CLAUDE.md's network-tap exception to a second surface.

That reading was wrong, and it was wrong in the expensive direction: it argued
for widening the project's central safety rule on evidence that does not support
it, and Tasks 22–25 would have been designed against DOM selectors when labeled
API fields were available the whole time.

The cause is that **LinkedIn puts its server-rendered JSON in neither script type
the sweep knew about.** It streams Big Pipe data islands — `<code style="display:
none" id="bpr-guid-586526">` — holding entity-escaped Voyager JSON, complete with
`$type` and a `meta.microSchema`. The About document alone carries 18 islands and
about 11,300 leaves. `embeddedJsonOf` looked only for
`script[type="application/ld+json"]` and `script[type="application/json"]`, found
zero, and every value in those islands fell through to the DOM snapshot, which of
course also contains them. The probe's own `embedded` surface measurement had the
same blind spot and reported `ldJson: 0, applicationJson: 0`, which is exactly
what made the gap invisible: the receipt said the document carried no embedded
JSON, and it carried nothing else.

Both now read the islands, with the id anchored (`/^bpr-guid-\d+$/`) so a `<code>`
block inside a post or an article — rendered content — is never laundered into the
labeled-field source. Re-running the sweep offline against the same archived run
moved `website`, `hq`, `about`, `founded` and `post_reactions` to `embedded-json`.

**Verdict: no exception is needed for the company surface.** Every §7 column
resolves to a labeled field in a captured body, which D117 already permits.

The four rows the map still marks DOM-only are **rendered composites, not missing
data**, and each has a structured constituent in the same embedded JSON:

| rendered | structured field a parser actually reads |
|---|---|
| `11-50 employees` | `employeeCountRange.{start,end}` = 11 / 50 |
| `Townsend St, San Francisco, California 94107, US` | `address.{line1,city,geographicArea,postalCode,country}` |
| `29 comments` | `numComments` = 29 (beside `numLikes` = 80) |
| `5 days ago` | `listedAt` = 1785517295000 (epoch ms) — the better field anyway |

The sweep is right to keep flagging them: it matches values, and those exact
strings genuinely exist only in the rendered DOM. The finding is that a composite
is not evidence of a missing source. Task 22 reads the structured field and
formats it, and never reads these strings.

Numbering note: as D180–D183, this belongs to Task 21 and lands out of range.
**Task 22's reserved range becomes D185–D189.**

## D185 — `company.get` delegates one `main` load to `company.probe` and resolves identity by corroboration (2026-08-09)

`company.get` calls the already-proven `company.probe` run path with `subpages=main`; it does
not add another navigator, tap, pacing loop, challenge gate or budget spend. The caller's
`RunBudget` remains bound to `company.get`, so the delegated load spends against the reader's
Task 20 sub-cap rather than the probe's cap. The main document carries the complete company
record in its Big Pipe islands, so loading `about` as well would spend a second page for no
additional §7 `companies` field.

Company identity is resolved-or-refused from agreement between independent captured bodies:
the initial document's embedded company record whose `universalName` equals the normalized
target vanity supplies the candidate, and a Voyager body from that same main load must carry
the same normalized company urn. A candidate present in the session/trap identity set, a non-company urn, no
candidate, disagreement, or missing corroboration is exit-5 drift and stores nothing. This
rejects the attractive but unsafe alternative of taking the first company urn in a body,
where related companies, jobs and tracking entities occur beside the subject.

## D186 — `company.get` has a 150-load reader cap and zero allowance for searches or profile opens (2026-08-09)

The Task 20 per-capability cap is explicit for `company.get`:
`{ pageLoadsPerDay: 150, searchPagesPerDay: 0, distinctProfilesPerDay: 0 }`. The page-load
number retains the bounded-reader fallback, while the two zeroes are assertions about this
reader's surface. Leaving it on the generic fallback would allow 25 search pages and 60
profile opens under its name, masking a composition regression until it had already spent.

## D187 — the company parser bounds bodies, nodes, and stored field length independently (2026-08-09)

The pure parser reads at most 256 captured bodies, walks at most 200,000 JSON nodes per
root, and stores at most 20,000 characters per text field. Crossing any bound is visible as
a typed exit-5 drift warning; a long field is truncated with the exact dropped-character
count instead of discarding an otherwise usable company. These are separate ceilings because
a small number of deeply nested bodies and a large number of tiny bodies are different drift
shapes, and neither should make parser memory or a PostgREST payload unbounded.

## D188 — numeric company targets resolve by exact id; legal embedded fields may fill a Voyager stub (2026-08-09, review)

A numeric `/company/<id>/` target resolves when the embedded candidate normalizes to exactly
`urn:li:fsd_company:<id>` and the Voyager body independently carries that same urn. Requiring
`universalName === <id>` rejected valid numeric URLs because `universalName` remains the
company's vanity slug. Cross-body corroboration remains mandatory. The numeric input itself
is never stored as `companies.vanity`: a real slug is taken from Voyager's company URL when
present, otherwise vanity is omitted.

For content projection, a labeled field in the initial document's Big Pipe JSON may fill a
missing field on the corroborating Voyager stub. In particular, `name` now prefers Voyager
and falls back to the embedded subject record instead of warning and silently upserting a
nameless company while the legal captured value is present. This is D184's source verdict,
not a DOM fallback. The session/trap-set refusal remains: Task 22 explicitly requires that
guard and its mutation proof, even though today's `sessionUrnsOf` normally yields person urns.

Fixture evidence is now durable inside the shared gitignored fixture library rather than
read from `runs/<id>/raw`. Fixture-only tests skip visibly when their two required files are
absent; all bounds and field-behavior tests are synthetic and run on every checkout.

## D190 — `company.posts` delegates exactly one measured posts-tab load (2026-08-09)

`company.posts` reuses `company.probe` with `subpages=posts` and six scroll passes, the exact
depth recorded by run `01KZKGD683T76H70YA4DMRCRZH`. It does not invent pagination: the measured
surface produced its feed body from one load, and `--limit` bounds parser work within that body.

## D191 — company-post identity requires a corroborated subject and a typed actor key (2026-08-09)

The parser resolves the subject company with `company.get`'s normalized, cross-body
corroboration rule, then admits only updates whose actor `detailData` has the
`*companyName` key equal to that subject. A `*profileFullName` actor is a stranger even when
some nested urn happens to resemble a company; author type comes from the measured key.

## D192 — company-post bounds are bodies, nodes, field text, and accepted-update work (2026-08-09)

The parser reads at most 256 bodies, walks 200,000 JSON nodes per root, stores 20,000
characters per post text, and stops update projection at `--limit`. Every exceeded structural
or field bound emits typed exit-5 drift; the requested limit is therefore a work ceiling, not
an output slice after all updates were parsed.

## D193 — post time and social counts follow stable identity and references (2026-08-09)

`posted_at` is the epoch milliseconds encoded in the activity snowflake (`id >> 22`), never
the run clock or rendered relative label. Counts follow Update `*socialDetail` and then
SocialDetail `*totalSocialActivityCounts`; constructing a counts urn from the activity id is
forbidden because it resolves for zero of the eleven measured updates.

## D194 — a post batch lands before its freshness marker (2026-08-09)

`company_posts` are batch-upserted on `urn` in one request, with `first_seen` omitted and
`last_seen` appended last to each payload. A failed request leaves the prior set stale; there
is no company-row foreign-key precondition, preserving D94's independent entity paths.

## D195 — `--since` is inclusive and fixture evidence is optional at test time (2026-08-09)

The boundary retains a post whose activity-derived timestamp equals `--since`; only older
posts are excluded. Measured-corpus tests skip visibly when the shared gitignored fixture is
absent, while identity, filtering, references, timestamps, limits, and all growth bounds remain
synthetic tests that run in a fresh clone.

## D196 — `company.posts` gets an explicit reader sub-cap with two zero assertions (2026-08-09)

Its daily cap is 150 page loads, 0 search pages, and 0 profile opens. Leaving it on the
generic fallback would silently authorize 25 searches and 60 profile opens under a reader
whose measured composition performs neither.

## D197 — `--no-store` changes storage only (2026-08-09)

Archive and parsing still run under `--no-store`; only the batch and drift writes are skipped.
This preserves raw-first evidence and makes the flag incapable of bypassing the budget ledger.

## D198 — an empty accepted set is a successful zero-row batch (2026-08-09)

A company tab can contain only stranger posts or all subject posts can precede `--since`.
That is a truthful success with zero stored rows, not identity drift and not an empty upsert
request; the store returns `{ rows: 0 }` without contacting PostgREST.

## D199 — receipts expose counts and work, never captured post content or company identity (2026-08-09)

The receipt reports usable rows, inspected updates, storage counts, and a SQL next step. It
does not copy post text, activity urns, or the resolved company urn into `data`; bulk values
remain in Supabase and raw archives under D3 and D100.

## D301 (out-of-range, infrastructure) — shared state is anchored to the repository root, never to the cwd (2026-08-09)

Three parser tasks — 22, 27 and 31 — each reported that the surface fixture they
depend on did not exist. All three were wrong in the same way, and the cause was
not in any of them.

`fixtures/` and `runs/` are gitignored at the repo root, deliberately: they hold
captured LinkedIn bytes. Tasks execute in linked git worktrees. `defaultRunsDir()`
and `promote-fixtures.ts` both resolved those directories against
`process.cwd()`, and the profile fixture test helper resolved its own directory
against `import.meta.url`. All three therefore pointed at the *worktree's* copy,
which is always empty, because nothing ever promotes into a worktree.

Two consequences, and the second is the serious one:

1. A promoted fixture sitting in the main checkout is invisible from every
   worktree, and a fixture suite that finds no files skips silently — which reads
   exactly like "the probe was never run". That is the false blocker.
2. **Every worktree got its own budget ledger.** The §8 daily caps are enforced by
   counting lines in `runs/budget.ndjson`. A per-worktree ledger multiplies the
   real cap by the number of worktrees open, without a flag, without a warning,
   and without any line in a receipt saying so. The rule is that the ledger cannot
   be bypassed by a flag; it must not be bypassable by a `cd` either.

`src/core/run/root.ts` resolves the main checkout from git's own linkage rather
than guessing: a linked worktree's `.git` is a file naming its gitdir, that gitdir
holds `commondir` pointing at the shared `.git`, and that `.git`'s parent is the
main checkout. An ordinary checkout stops at the first `.git` directory. Outside
any repository it falls back to the starting directory, so an unpacked copy still
runs with the old behaviour — which is correct when there are no worktrees to
disagree.

`LINKEDIN_OS_REPO_ROOT` overrides it for tests. `LINKEDIN_OS_RUNS_DIR` still
overrides the archive location on top of that, unchanged.

Numbering note: this is infrastructure discovered while unblocking three tasks at
once, so it belongs to none of their ranges. D300 is held by Task 26.
## D220 — the activity surface gets its own relevance predicate, and `summarizeCaptures` takes one (2026-08-09)

**Decision.** `summarizeCaptures` gains an optional `isRelevant` parameter, defaulting to
`isProfileIsh` so every existing caller is unchanged. `activity.capture` passes
`isActivityIsh`, which matches post, comment and reaction markers and deliberately does
**not** match `urn:li:fsd_profile`.

**Why.** Every post card names its author, so "carries person data" is true of essentially
every body on this surface. Under the profile predicate the two-tier pattern report (D110)
would say the same thing on every run, and `unmatched_profile_ish` — the number that exists
to tell us the endpoint guess was wrong — would be noise. Rejected: forking the summary
(two copies of the one function that produces this task's acceptance evidence).

## D221 — `activity.capture` is a probe capability with its own small daily sub-cap (2026-08-09)

**Decision.** The probe is a capability under `src/capabilities/`, not a script, and it
carries a `CAPABILITY_SUB_CAPS` entry of 30 page loads / 0 search pages / 20 distinct
profiles per day — well under the fallback (D162).

**Why.** M4 CONTEXT rule 8 requires probes through the normal runner: lease, ledger,
challenge gate, raw-first archive. Given that, D153's blast-radius argument applies to it
too, and it applies *harder*: this capability's whole job is a handful of supervised loads
per surface, so a number in the hundreds would let one mistyped loop spend a working
reader's day on pages nobody is reading. Zero search pages for `profile.capture`'s reason —
it never issues a search, so a search spend under this name means it is doing something it
was not built to do.

## D222 — a post permalink costs a page load and no `profile_open` (2026-08-09)

**Decision.** `activity.capture` spends `page_load` on every surface and `profile_open`
only on the three person surfaces. `cost()` branches on `looksLikePostPermalink`, which is
total and never throws.

**Why.** §8's `distinctProfilesPerDay` rations *how many people we looked at today*. A
permalink opens nobody's profile; charging it would ration the wrong thing, and would make
a day of post reads exhaust the budget that protects prospect views. The `cost` helper is
total because a throw there is reported by the runner as `COST_ESTIMATE_FAILED` and the
real `ACTIVITY_URL_INVALID` message is lost — the refusal belongs inside `run`, where it
reads properly.

## D223 — an activity page's `profile_open` ref is the profile's own ref (2026-08-09)

**Decision.** `ActivityTarget.personRef` is `in:<vanity>`, byte for byte what
`normalizeProfileUrl` produces, and that is the string passed to the ledger.

**Why.** The three person surfaces are three pages of one person. A different spelling
would count one prospect two or four times against `distinctProfilesPerDay`, and the
freshness dedupe would stop amortising loads across a profile read and an activity read of
the same person on the same day — which is exactly what M4 CONTEXT's "prefer targets
already in the store" is for. Pinned by a test that asserts the two functions agree rather
than asserting the literal.

## D224 — a field probe may match a number (2026-08-09)

**Decision.** `FieldProbe` gains `number?: (v: number) => boolean`, and `value` is widened
from `RegExp` to a `StringMatcher` so a shape predicate that is not expressible as a regex
(`looksIso8601` parses as well as matches) needs no cast.

**Why.** `matches()` only ever tested `value` against strings, and LinkedIn's timestamps
are epoch millis — numbers. Without this, the one question Task 26 exists to answer, *does
any source carry an absolute time*, would be answered "no" by a body full of
`createdAt: 1754697600000`, and `person_posts.posted_at` would get derived from the run
clock for no reason at all.

## D225 — the activity DOM map is shape-based, and it is an instrument, not a parser (2026-08-09)

**Decision.** `core/fixtures/activitymap.ts` reports what a snapshot *contains* by shape:
any attribute whose value holds a `urn:li:` is a candidate post-card marker whatever it is
called; any leaf whose text reads as a time is a candidate `posted_at`; the nearest
ancestor carrying a urn attribute is what binds the two. It resolves nothing and refuses
nothing. `dommap.ts` is left alone: it is the profile page's map and is written against
that page's card-ref namespace.

**Why.** Nothing about this surface has been measured. A map that looked for named fields
would confirm what someone expected instead of reporting what is there, which is the
failure D152 exists to prevent — and it would then be lifted into Tasks 27–29 as a parser.
So no part of this file may be lifted unchanged: those tasks are written against what it
measured, not against it. It also reports whether the profile card-ref namespace (D127)
exists here at all, as a measurement rather than an expectation.

## D226 — promotion selects a surface, and relevance, probes and DOM map move together (2026-08-09)

**Decision.** `promoteFixtures` gains `domMap: "profile" | "activity"`, and the promote
script gains `--surface=profile|activity` which sets `isRelevant`, `probes` and `domMap`
in one go. Default `profile`, so every existing invocation is unchanged. A post permalink
run yields no subject, and the script says so rather than falling through.

**Why.** They are one decision, not three. Promoting an activity run under the profile
settings drops every body that carries posts and no person urn — which is exactly the body
a post parser needs — and hands the snapshot to a map looking for cards that are not there.
Selected rather than sniffed from the archive: inferring which page a run captured is the
kind of guess that produced D118.

## D227 — the scroller is described, not only measured (2026-08-09)

**Decision.** `VIEWPORT_EXPRESSION` now returns a descriptor of the element it measured —
tag, `id`, `role`, `componentkey`, and its two heights — plus every candidate, tallest
first, capped at `MAX_SCROLLER_CANDIDATES` with the true total alongside. Class names are
excluded: they are content-hashed and churn on every deploy.

**Why.** M4 CONTEXT rule 3 says each new surface measures its own scroller. The expression
already picked the tallest genuinely-scrollable element rather than the document (D115), but
a height alone cannot tell an operator *which container* it came from, so a surface with two
nested scrollers could report a settled layout while scrolling the wrong box — and nothing
on the receipt would show it. Reporting the candidates is what makes "the feed is its own
scroll container" a measurement rather than a claim.

## D228 — a feed read only part of the way down is a warning, not a silent prefix (2026-08-09)

**Decision.** When the measured scroller still has distance below the last pass,
`activity.capture` raises `FEED_NOT_EXHAUSTED` with the remaining pixels.

**Why.** On a profile page a short read costs some lazy sections. On a feed it changes what
the numbers mean: the count of posts describes the scroll rather than the person, and a
short capture and a short feed produce the same receipt. That is the silent-loss shape
review has already caught here (the tap's forgotten-versus-never-arrived case) applied to a
page that is unbounded by construction.

**Revised the same day, after review, on both halves of the arithmetic. As first written
this warning was near-silent exactly when the capture was short.**

*The extent was measured once, before any scrolling.* `readLikeAHuman` took its scroll
budget from the viewport measured at layout-settle. A feed renders as it is read, so that
number is the height the page had before it had any cards: the reader stopped at the first
screenful-set and never issued whatever request the rest of the feed would have triggered —
the archive was a prefix *by construction*, and the fixture Tasks 27–29 receive would never
have shown how the feed pages. It now re-measures after every pass and keeps the latest
extent, with a failed re-measure leaving the previous one standing rather than collapsing
the budget mid-read. On a profile page — finite, and mostly rendered by the time layout
settles — this made no difference, which is why it survived to a feed surface.

*The shortfall was computed from distance travelled, not position.* `ReadResult.scrolled`
sums `Math.abs` over every pass and `readLikeAHuman` deliberately goes back up a quarter of
the time, so 600px down, 300 up, 300 down is 1200px of `scrolled` at position 600 — and on
a 900px page the warning fell silent from halfway down. `ReadResult` now carries
`travelled` (position) and `scrollable` (the last measured extent) alongside `scrolled`
(effort), and the check is the pure `feedShortfall`, which reads only the first two.

*Why `feedShortfall` is a function.* The capability cannot inject an rng into
`readLikeAHuman`, so no end-to-end test can force `scrolled` and `travelled` apart — the
original tests passed against the bug because the fake cursor never scrolled backwards. A
pure function can be handed the sequence directly. The property is now pinned where it is
decidable rather than where it happens to run.

## D229 — Tasks 27–29 stay blocked on the live probe and on the operator (2026-08-09)

**Decision.** The offline half of Task 26 — the probe capability, the measurement
instruments and their tests — ships now. The `FIELD-MAP.md`, the fixtures and the per-field
source verdicts do not exist and will not be written from expectation. Tasks 27–29 remain
blocked on two things: the supervised live run, and, if the run confirms that this surface's
content lives only in the rendered DOM, an operator decision extending `CLAUDE.md`'s
DOM-source exception to it (M4 CONTEXT rule 7).

**Why.** D152 forbids parse code before a real-load fixture, and the exception in
`CLAUDE.md` is the profile reader *and nothing else* — it is never silently inherited by a
new surface. Writing a field map now would produce exactly the artefact D152 exists to
prevent: a document that looks measured and is not.

## D300 — a `/posts/` permalink watches two document spellings (2026-08-09)

**Numbering:** Task 26's D220–D229 are used, so this takes the next free number outside the
plan's per-task ranges, per the M4 README's rule.

**Decision.** `activityDocumentPatterns` returns one document watch for a person surface or
an already-canonical permalink, and **two** for a `/posts/<slug>-activity-<id>-<hash>`
target: the slug as given, and `https://www.linkedin.com/feed/update/<urn>/`. Both are
`specific`, and they are named apart because the tap keys watches by name.

**Why.** LinkedIn 302s `/posts/<slug>` to `/feed/update/<urn>/`, so the document that
actually answers is at a path the target url never named. `documentPattern` matches on exact
pathname, and the broad net cannot cover the gap — it matches API paths and this is a page.
One watch would therefore have captured no document at all on the single surface where a
server-rendered payload is most likely (D116/D117's whole argument), and the probe would have
reported "nothing was server-rendered" about a body it never watched for. `documentPattern`
gained an optional name parameter to make this expressible; its default is unchanged.

**Also in this review round, and needing no decision:** the receipt's urn inventory is taken
across the run rather than summed per body (one author in ten feed bodies is one person, not
ten) and now carries `body_urns_total` and `body_urns_truncated`, so a family that hits
`MAX_URNS_PER_FAMILY` says so instead of under-reporting silently. `activitymap`'s per-family
sets are bounded the same way — they were the one structure in that file that grew with the
page. A no-op `isPostPermalink` branch was removed from the promote script: `normalizeProfileUrl`
already refuses a permalink and the catch already returns null, so the branch changed nothing
and its comment claimed a protection that was never running.

## D260 — the canonical job id is the bare numeric posting id (2026-08-09)

**Decision.** One form across every capability that touches a posting: the bare numeric id
as a **string**. `normalizeJobUrl` reduces `/jobs/view/<id>`, the slugged share url
(`/jobs/view/<title>-at-<co>-<id>`), a listing url's `currentJobId`, a bare id and
`urn:li:fsd_jobPosting:<id>` to it, and derives from it the canonical url
`https://www.linkedin.com/jobs/view/<id>/`, the event/ledger ref `job:<id>`, and the urn
`urn:li:fsd_jobPosting:<id>`. §7's `jobs.id` primary key holds that id. **Task 25
(`company.jobs`) must write the same form** — it is the same table.

**Why the bare id and not the urn.** §7 names the column `id`, not `urn`, and it is the one
entity in the data model whose key LinkedIn does not hand out as a urn everywhere: list
cards, `currentJobId`, and the detail url all carry the bare number, while the urn appears
only inside bodies. Storing the urn would mean re-deriving the number at every join. A
string, not a number: ids already exceed 2^53.

**Two refusals rather than guesses.** A listing url with no `currentJobId` names no posting —
opening it spends a page load on whichever job LinkedIn selects. A `/jobs/view/` segment with
no digit run is refused rather than navigated, because LinkedIn resolves some non-numeric
segments by redirect, and a target whose id is known only *after* the load cannot be
budget-deduped, keyed or dedupe-checked before it.

## D261 — the capture summariser takes the relevance predicate, rather than being copied (2026-08-09)

**Decision.** `summarizeCaptures` gains an optional fourth parameter, `isRelevant`, defaulting
to `isProfileIsh`. `job.capture` passes `isJobIsh` through `summarizeJobCaptures`. The
returned `profile_ish` / `unmatched_profile_ish` fields therefore mean "relevant by the given
predicate"; a non-profile caller renames them on its own receipt (`job_ish`,
`unmatched_job_ish`).

**Why.** "Which endpoints did the page hit, which of them carried what we came for, and which
of those did no specific pattern predict" is the same computation on every surface; only the
last clause differs. The alternative was a second copy in `job.capture`, which is 40 lines of
counting that would then drift from the one the profile probe is proven against. The default
keeps every existing caller byte-identical, and a test asserts that the same rows summarize
differently under the two predicates while the default still counts a person body.

**Not renamed.** Renaming the result fields would touch `profile.capture`'s receipt shape and
its tests for a cosmetic gain, on a surface that is already live — the mapping happens at the
one place that needs it.

## D262 — a job page costs a page load and never a profile open (2026-08-09)

**Decision.** `job.capture` declares `{ page_loads: 1, search_pages: 0, profile_opens: 0 }`.
§8's spend kinds stay a closed set of three; no `job_open` kind is added.

**Why.** `profile_open` exists because LinkedIn counts and surfaces profile views — it is a
LinkedIn-facing fact about the account, not a general "we opened a page" counter. A posting
view is not one. Recording one would inflate the distinct-profiles-per-day ledger against a
limit written about a different behaviour, refusing real profile work to pay for job reads.
Rejected: adding a fourth spend kind for job opens — it would need its own §8 limit, its own
dedupe scope and a ledger format change, for a surface with no evidence of per-posting
throttling. The daily blast-radius guard is already there: the capability's own sub-cap (D162).

## D263 — the description's source is measured passively, never by clicking (2026-08-09)

**Decision.** Whether a job description's "see more" is a CSS toggle over text already in the
DOM, or a control that fetches the rest, is decided by measuring geometry and computed style:
a clamped block whose `scrollHeight` exceeds its `clientHeight` by more than 40px means the
text is already there. The probe never clicks. Its verdict is one of `dom-toggle`,
`likely-request`, `not-truncated`, `unknown` — and `unknown` is a first-class answer that a
truncated element walk always returns.

**Why.** Clicking is an interaction with the page on the one account that cannot be burned,
and it is not needed: the two cases have different measurable shapes. The fourth verdict
exists because this measurement is what Task 31 will build on, and "we could not tell" must
never be readable as "no fetch" — that is the reading that would ship a `job.get` silently
storing a truncated description.

## D264 — promotion routes on a capability family, in one tested module (2026-08-09)

**Decision.** `src/core/fixtures/families.ts` owns the three things that differ per page
surface when an archive is promoted: how a run's own url becomes a subject, what counts as a
relevant body, and which field probes the map is built with. `scripts/promote-fixtures.ts`
keeps only the file reads around it. `familyOf` derives the family from the capability name
(`job.*` → job), and an unrecognized name falls back to the profile rules.

**Why.** Promotion was hardcoded to the profile surface — `normalizeProfileUrl`, `isProfileIsh`,
`PROFILE_PROBES` — so a job archive promoted with no subject at all and fell back to "any body
carrying person data", which is the D118 failure on a new surface. Putting the dispatch in a
module rather than in the script is what makes it testable: the script runs `main()` at import
and cannot be imported by a test. The fallback direction is the conservative one — a mistyped
`--capability` promotes *less*, never more.

## D302 (out-of-range, infrastructure) — a navigation settles on `interactive` when `complete` never comes (2026-08-09)

`WorkerTab.navigate` waited for `document.readyState === "complete"` and failed
`TAB_NAVIGATE_TIMEOUT` after 45s otherwise. The person-activity feed never reaches
it. On the measured run (`01KZKG24MBMNJ93YA4AWCCM4CV`,
`/in/<vanity>/recent-activity/all/`) the document response arrived at +2s at
1,467,847 bytes, every request had quiesced by +10s, and `readyState` was still
`interactive` when the deadline fired at 46.5s.

`complete` is the window load event, and a page holding a connection open — which
LinkedIn's realtime stream does — never fires it. So the wait was measuring
LinkedIn's connection lifetime, not whether the page was usable.

The cost of that is specific and bad: the capture had **already archived 37 bodies
including the 611KB `voyagerFeedDashProfileUpdates` response**, and still exited
transient with no receipt, no DOM snapshot and no promotable fixture — after
spending a metered page load. A page load that produced the data and reported
failure is the worst outcome available under §8.

Now `complete` still wins the instant it arrives, and `interactive` is accepted
once it has held for `INTERACTIVE_SETTLE_MS` (10s). `interactive` is
DOMContentLoaded: the document is parsed and scripts run, and every reader
confirms its own render afterwards, so this is a bounded fallback rather than a
shortcut past the render check. A drop back to `loading` — a client-side
navigation replacing the document — restarts the clock, so a stale page is never
credited with the wait.

`navigate` returns a `Navigation` (`settledOn`, `readyState`, `waitedMs`) instead
of `void`. Which of the two it settled on is a fact about the page worth putting
on a receipt, not one to swallow.

## D303 (out-of-range, infrastructure) — the broad net was a guess wearing a safety net's clothes (2026-08-09)

`isLinkedInApiUrl` matches `/voyager/api/`, `/sales-api/` and `/graphql`. It is
described as the net that makes the specific patterns *checkable* — an endpoint
nobody predicted is still archived and still counted.

It is not, and the job surface proved it. Run `01KZKMJS9FD0H18VAZMFFVPEYB`
captured 25 bodies on `/jobs/view/<id>`, reported `misses: 0`, and contained no
job endpoint at all. Read literally that says the posting's data never crossed
the network. What it actually said was that nothing was watching outside
`/voyager/`.

Re-running the same page with a wider net (`01KZKNJ16QD3WSFJ3XMHTG4V1W`) captured
21 bodies, **none of them under `/voyager/`**, on a stack the old net could not
see at all:

- `/flagship-web/rsc-action/actions/component?componentId=com.linkedin.sdui.…`
- `/flagship-web/rsc-action/actions/server-request?sduiid=…`
- `/preload/?_bprMode=vanilla`

A net that only catches what you predicted cannot tell you the prediction was
wrong. `isLinkedInDataUrl` accepts any same-origin LinkedIn response that is not
an asset and not telemetry, and is pinned as strictly wider than the API net so
swapping one for the other on a probe can only add captures. It is for probes
settling a source verdict, not for readers; the tap's total buffer bounds it.

**Every surface verdict reached with only the old net is provisional.** The
company and profile surfaces found their data because it genuinely is under
`/voyager/` — that is a result, not a validation of the net.

## D304 (out-of-range) — the job surface has no labeled-field source, and the RSC flight tree is not one (2026-08-09)

Measured twice on `/jobs/view/4450930857/`: once cold with the API net
(`01KZKMJS9FD0H18VAZMFFVPEYB`, 25 bodies) and once with the widest net
(`01KZKNJ16QD3WSFJ3XMHTG4V1W`, 21 bodies). The two runs share no endpoints and
agree on the finding.

**The description is on the network.** It is in a 6,654-byte
`/flagship-web/rsc-action/actions/component` response, in full.

**It is not in a labeled field.** That body is an RSC flight tree — numbered rows
of render output:

```
7:["$","$L8",null,{"textProps":{…"children":[["$","p","text-attr-2",
   {"children":["Our bet: every hospital in Southeast Asia …"]}]]}}]
```

The text is addressed only by its position in a render tree. There is no
`"description"` key, no `"title"`, no job urn in that body at all.

Across all 21 bodies, the labeled job fields §7 needs are **absent everywhere**:
no `listedAt`, no `originalListedAt`, no `workplaceTypes`, no
`workRemoteAllowed`, no `formattedLocation`, no `companyDetails`, no
`urn:li:fsd_company:`. The only structured job reference in the whole run is
`urn:li:jobPosting:<id>` ×10 in the document, and every one of those sits inside
a *report* action (`GenericReportedInfo.targetEntityUrn`) — identity, not
content.

So Task 31 has exactly two ways to read a posting, and both need a decision the
capability cannot make for itself:

1. **Extend the DOM-source exception to the job surface**, the way D123/D130
   extended it to the profile reader — read from the archived DOM snapshot,
   every row tagged DOM-sourced.
2. **Read the RSC flight tree by position**, which D121 forbids outright, and
   which is the DOM's fragility with worse ergonomics and no `data-testid` to
   anchor on.

**[DECISION NEEDED — operator.]** Task 31 stays blocked on this and nothing else.
Recommendation: option 1. It is the precedent that already exists, the snapshot
is already archived raw, and the job card carries `data-testid` attributes
(`expandable-text-box` on the description) that are stabler anchors than flight
row indices.

## D305 (out-of-range) — the DOM-source exception is extended to the job surface (2026-08-09, operator-approved)

D304 measured that `/jobs/view/<id>` carries no labeled job field anywhere: the
description crosses the network only as an RSC flight tree, and `listedAt`,
`workplaceTypes`, `formattedLocation` and the company urn appear in no captured
body at all. The two options were a DOM-source exception or positional reads of
the flight tree.

**The operator approved the DOM-source exception for the job surface.**

It inherits the profile reader's shape exactly, and the shape is the safety
argument — an exception is not permission to read pages loosely:

- The source is an **`outerHTML` snapshot**, captured after layout settles,
  archived raw like any body, and **parsed offline**. Never a live `innerHTML`
  read, never the RSC flight tree by position (D121 stands unchanged).
- Every row read this way is **tagged DOM-sourced**, so nothing downstream
  mistakes it for a labeled API field.
- Scope is anchored on `data-testid` attributes rather than container position or
  class names — LinkedIn's classes are hashed per build (`_5e09f4d5`) and change
  without notice. The description sits under `data-testid="expandable-text-box"`.
- Identity is still **resolved or refused**: the posting's id comes from the
  normalized url and is cross-checked against `urn:li:jobPosting:<id>` in the
  document. A snapshot whose id does not agree stores nothing rather than storing
  content under an invented key.

**The exception is the job surface and nothing else.** Every other capability,
and every other kind of field, still takes data only from captured network
bodies. This does not generalize to a surface that merely *looks* similar; the
next surface needs its own measurement and its own decision.

## D190a (review) — one activity is stored once, however many feed pages carried it (2026-08-09)

`company.posts` scrolls the posts tab, and consecutive pages of
`voyagerFeedDashOrganizationalPageUpdates` overlap — the same activity urn arrives in
more than one captured body. The parser keeps the first occurrence and drops the rest.

Without the guard `--limit` counts the same post twice, and the batch upsert fails
outright: Postgres refuses an `ON CONFLICT` statement that touches one row a second
time, so a company with more than one page of posts would never store at all. Verified
by mutation — removing the guard fails the overlapping-pages test.

## D200 — company people rows come only from the measured current-company search cluster (2026-08-09)

The people tab's list is the `voyagerSearchDashClusters` response. A profile urn merely
appearing in `included[]` is not membership evidence: the same response can carry suggestions,
actions and the session user. A row is eligible only when its entity-result reference occurs
in the search cluster and that response's filter metadata has `parameterName: currentCompany`
with the resolved subject company id selected. This is a labeled Voyager boundary, not a DOM
inference; removing it must admit the synthetic non-employee trap.

## D201 — company.people costs one page load and no search-page unit (2026-08-09)

Opening `/company/<vanity>/people/` is one reader page load. Although LinkedIn implements the
tab with its generic search response schema, the capability does not initiate search pagination
or forge a search request; the one UI-issued response belongs to that page load. Charging an
additional `search_page` would count the same interaction twice. Its explicit daily sub-cap is
therefore 150 page loads, 0 search pages and 0 profile opens; any separate search action fails
the zero cap.

## D202 — people identity is resolved-or-refused before association parsing (2026-08-09)

`company.people` reuses `company.get`'s cross-body company identity proof. No association is
projected until embedded company identity and Voyager company identity agree, and every person
urn is checked against the captured session-identity set. An unresolved or session company
refuses the whole write; a session person is excluded from rows.

## D203 — cluster references, not loose profile urns, define person rows (2026-08-09)

Rows are reached through `SearchItem.item.*entityResult` and resolved to the matching
`EntityResultViewModel`. Loose profile stubs, lazy actions, member-distance records and any
other profile-looking object in `included[]` are not rows. The stable person urn is parsed from
the referenced entity-result urn; the profile URL comes from its labeled `navigationUrl`, with
the urn as the `profile.get`-usable fallback.

## D204 — name/title filters and limit bound parser work (2026-08-09)

`--name` matches the result title and `--title` matches the primary subtitle,
case-insensitively, over captured data only. The parser stops walking result references as soon
as the accepted limit is reached. It does not forge filtered requests or parse every result and
slice afterward.

## D205 — company.people has explicit parser ceilings with typed drift (2026-08-09)

The pure parser reads at most 256 capture bodies, walks at most 200,000 JSON nodes per body and
retains at most 20,000 characters per projected field. Every crossed boundary emits a typed
exit-5 drift warning, and each ceiling has a synthetic test.

## D206 — company_people batches deduplicate the composite key (2026-08-09)

Before the one PostgREST upsert, rows are deduplicated by `(company_urn, person_urn)` with first
occurrence winning. This prevents Postgres from rejecting the entire `ON CONFLICT` statement
when overlapping captures repeat a pair. The store test fails when the dedupe is removed.

## D207 — discovered_at is database-owned and never resent (2026-08-09)

The association upsert sends only `company_urn` and `person_urn`, conflicting on that pair.
`discovered_at` is omitted on first discovery and rediscovery, so the database default creates
it once and a later observation cannot overwrite it.

## D208 — measured fixture tests skip visibly; contracts remain fixture-free (2026-08-09)

The 12-person real-body assertion lives in `parse.fixture.test.ts` behind `existsSync`.
Identity, stranger/session exclusion, filters, work limit and all bounds are synthetic in
`parse.test.ts`. Moving the gitignored company.people fixture away leaves eight tests passing
and one explicit skip.

## D209 — company.people returns bounded profile URLs while storing only associations (2026-08-09)

The result carries at most `--limit` normalized `/in/<vanity>` URLs or profile-urn fallbacks for
downstream `profile.get`; the database receives only §7's association columns. Composition
delegates one `/people/` page load with zero scrolls because the measured UI issued one 12-row
cluster response; no pagination mechanism is invented before a live measurement proves one.

## D200a (review) — an unmatched employee-scope filter is drift, not an empty company (2026-08-09)

`company.people` scopes a search result to an employee by finding a `currentCompany`
filter with the subject's id `selected: true`. If that filter's shape changes, every
captured body is skipped and the capability returns exit 0 with zero rows — which reads
exactly like a company that lists no employees.

The parser now emits `PARSE_SCOPE_UNMATCHED` when no captured body matched the scope at
all. Silence and emptiness must not be the same receipt. Verified by mutation.
## D210 — `company.jobs` reads labeled JobPosting values from the initial document (2026-08-09)

The archived `/company/wisprflow/jobs/` document contains 17 decoded Big Pipe islands.
After excluding every `$.meta.microSchema` subtree, 9 objects are actual
`com.linkedin.voyager.dash.jobs.JobPosting` values: each carries `entityUrn`, `title`,
`companyDetails`, `*location`, `listedAt`, `jobState`, `description`, and `numApplies`.
All 9 are `LISTED`, all 9 resolve their company reference to the subject company, and all
9 location references resolve. This is captured embedded Voyager JSON under D117, so
`company.jobs` needs no DOM exception and must not read the same page's DOM snapshot.

The document also contains 10 lighter objects with `entityUrn`, `trackingUrn`, `title`,
and `repostedJob`. Those are navigation stubs, not company-scoped JobPosting values. The
`trackingUrn` numeric id agrees with the fsd urn on every stub, but a stub has neither
company scope nor posting fields and therefore never becomes a row.

## D211 — the canonical `jobs.id` is the numeric posting id (2026-08-09)

Both `urn:li:fsd_jobPosting:<id>` and `urn:li:jobPosting:<id>` are wrappers around the
same numeric posting id where both occur. The 17-vs-10 count is a difference in object
sets (9 full records, 10 stubs, 2 ids overlap), not competing identity systems.
`company.jobs` strips only an exact recognized job urn to decimal digits and stores those
digits in §7 `jobs.id`; Task 31 can therefore enrich the same row. No urn is written into
the id column and no unrelated digit string is accepted as identity.

## D212 — a jobs-tab row is scoped by its typed company reference (2026-08-09)

Only a value record whose `companyDetails.jobCompany.*company` normalizes to the resolved
subject company can become a row. Title text, document position, and membership in the same
island are not scope. This excludes unscoped navigation stubs and any recommended or otherwise
embedded posting from another company.

## D213 — company.jobs stores the measured list fields and omits the rest (2026-08-09)

The 9 measured subject records carry title, a resolvable `*location`, `listedAt`, and full
`description.text`, so those fields are stored. They carry no workplace type, so
`workplace_type` is omitted rather than guessed; Task 31 may enrich it later on the same id.
A missing measured field emits typed exit-5 drift and stays absent — no urn, id, or neighboring
display string is substituted into a differently typed column.

## D214 — company.jobs has explicit body, node, and field bounds (2026-08-09)

The parser inspects at most 128 capture bodies and 150,000 decoded nodes per root, and stores
at most 20,000 characters per string field. Every crossed bound produces a typed exit-5
`PARSE_INPUT_TRUNCATED` or `PARSE_FIELD_TRUNCATED` warning, and every bound is crossed by a
synthetic test.

## D215 — one jobs-tab load is a reader page load, not a search page (2026-08-09)

The UI route looks like a listing but the measured action is an ordinary company tab load:
it spends no search credit and opens no profile. One scroll pass reached the measured end and
no pagination request appeared, so the capability charges 1 page load, 0 search pages, and
0 profile opens with a 150/0/0 daily sub-cap. `--limit` stops accepted-record parse work; it
cannot make the single fixed document load cheaper and does not pretend to.

## D216 — jobs are deduplicated before an ordered batch upsert (2026-08-09)

The store keeps the last input for each canonical id before issuing one `onConflict: id`
batch. Undefined fields are omitted so later Task 31 values survive a list capture that said
nothing about them. `first_seen` is never sent; one run timestamp is appended as `last_seen`
after every parser-owned field.

## D217 — unmatched company scope is observable drift, not an empty success (2026-08-09)

If JobPosting value records exist but none carries the resolved subject-company reference,
the parser emits `PARSE_SCOPE_UNMATCHED` with exit-5 drift semantics. A genuinely empty surface
and a broken scoping path therefore do not produce the same receipt.

## D218 — structured initial documents are first-class promoted fixtures (2026-08-09)

The fixture promoter previously classified every non-JSON network body as `not_json`, including
an initial HTML document whose Big Pipe islands are the D117 structured source. It now promotes
such a document byte-for-byte as `*-document.html`, maps only values returned by
`embeddedJsonOf`, and keeps a separate dedupe namespace from the rendered DOM snapshot. HTML
without parseable structured islands remains rejected. The company.jobs fixture test is gated
by `existsSync`; all contract and bound tests are synthetic.

## D219 — company.jobs receipts remain bounded and identifier-free (2026-08-09)

The receipt reports counts, source kind, storage counts, warnings, and a verification query;
it returns neither job ids nor the company urn. `--no-store` still captures and parses because
it is a storage switch, not a budget bypass. Drift persistence follows the established partial
write contract: if it fails after jobs land, the error carries the already-stored row count.

## D210a (review) — zero jobs has two causes and they do not share a receipt (2026-08-09)

`company.jobs` selects postings by `entityUrn` being a job urn AND the record carrying
`listedAt`. If LinkedIn renames or restructures that field, nothing is selected and the
capability returns exit 0 with zero rows — indistinguishable from a company with no
openings.

The parser now separates the two: job urns present in the document but no record
matching the expected posting shape emits `PARSE_SCOPE_UNMATCHED` on `job_posting_shape`;
no job urn anywhere stays silent, because that genuinely is an empty company. This is
D200a applied one layer in. Verified by mutation, and by a companion test proving the
empty-company case emits nothing.

## D230 — `profile.posts` parses only the feed's referenced update graph (2026-08-09)

The parser starts at `data.data.feedDashProfileUpdatesByMemberShareFeed.*elements`, resolves
those references against `included[]`, and reads value fields only from the resolved update
and count entities. It never recursively searches the response and never reads `meta`, so a
microSchema declaration such as `{type:"string"}` cannot become a post body. The feed order
is retained because it is the only measured ordering contract in the Task 26 body.

## D231 — The subject urn is an input to the offline post parser (2026-08-09)

Author identity comes only from the resolved update's
`actor.name.attributesV2[].detailData.*profileFullName`. The parser accepts the already
resolved subject urn and retains a row only on exact agreement. Subject resolution remains
the capability composition's responsibility; the parser does not infer a subject from the
most frequent actor, the first card, or any session identity.

## D232 — Activity snowflakes are the sole post clock (2026-08-09)

`posted_at` is `new Date(Number(BigInt(activityId) >> 22n))`, where `activityId` is taken
from `urn:li:activity:<id>`. Relative labels and CDN `expiresAt` values are ignored. This is
the Task 26 verdict, recorded here as the implementation boundary rather than re-derived.

## D233 — `--limit` caps referenced feed items examined and scroll work (2026-08-09)

The default and one captured Voyager page are both 20 items. The reader converts the requested
limit to zero scroll passes through 20 items, then one additional pass per next 20, capped by
the activity capture's existing 12-pass safety ceiling. Independently, it stops resolving feed
references once exactly `limit` items have been examined across captured bodies. Filtering
strangers or `--since` happens after that work debit, so neither can turn a small limit into an
unbounded crawl.

## D234 — Subject resolution uses the captured viewee identity, without forcing a person row (2026-08-09)

The reader takes subject candidates only from the captured profile-components body's
`included[].*vieweeProfile`, removes every urn in `sessionUrnsOf`, and proceeds only with one
remaining `urn:li:fsd_profile` value. It does not require a `persons` row because the schema has
no foreign key (D94), and it does not infer identity from author frequency. Zero, multiple, or
session-owned candidates store nothing and return parse drift.

## D235 — The shared post projection owns both post-table upserts (2026-08-09)

`src/core/store/posts.ts` defines the common activity row and a generic owner key for
`person_urn` or `company_urn`. One batch upsert path selects `person_posts` or `company_posts`,
keys on `urn`, and stamps `last_seen`; Task 23 can reuse it without duplicating row projection
or write semantics.

## D236 — `--since` is inclusive on the snowflake-derived stored instant (2026-08-09)

A row whose derived `posted_at` equals `--since` is retained; only an older row is filtered.
The comparison uses the same ISO instant written to `person_posts`, not capture time or the
rendered relative label. Filtering does not replenish `--limit` work.

## D237 — `profile.posts` delegates the complete live capture composition (2026-08-09)

The reader invokes `activity.capture.run` with the caller's context and reads only bodies the
shared tap archived during that invocation. It adds no navigation, request, tap watch, budget
spend, challenge gate, or raw archive path of its own. Consequently every load remains metered
under the outer `profile.posts` RunBudget and raw-first behavior holds on failures too.

## D238 — Post subject ambiguity is parse drift and stores zero rows (2026-08-09)

Zero or multiple non-session viewee urns, or a viewee that is only the logged-in account, is
`PROFILE_POSTS_SUBJECT_UNRESOLVED` / exit 5 / `HALT_AND_NOTIFY`. This is not retryable: retrying
the same shape cannot make an ambiguous identity trustworthy. The refusal happens before the
single batch write.

## D239 — Task 27 stops before its operator-supervised live gate (2026-08-09)

Offline fixture, composition, shared-store, registry/full-suite and type verification are the
implementation gate. The real-profile gate is deliberately left unspent for the operator, as
the task requires; no development command in Task 27 opens LinkedIn.

### Task 27 review follow-up — capture boundary and social-count graph (2026-08-09)

The tap cursor is the next capture index: a response archived after a saved cursor may have
`seq === cursor`, so `profile.posts` selects `seq >= cursor`. This makes D237 exact and prevents
the first subject-identity or feed body from disappearing.

Count entities are joined through each update's `*socialDetail` urn, preserving whether the
social activity is keyed by `activity`, `ugcPost`, or `share`; activity ids are never rewritten
into ugcPost ids. A missing detail falls back to the activity urn. The promoted fixture now
proves all 14 retained subject rows have both reaction and comment counts.

Malformed feed references, activity ids, and non-activity backend urns are per-item parse misses:
non-string refs never enter the entity map, an unusable backend falls back to the update entity
urn, and an invalid snowflake increments `unresolved` without discarding other rows. Since-filtered
rows are counted as skipped so receipt counts account for every examined item.

## D240 — `profile.activity` keeps the activity actor separate from the target author (2026-08-09)

The acting subject is read from each referenced update's
`header.text.attributesV2[].detailData.*profileFullName`. The target content author is read
separately from `actor.name.attributesV2[].detailData.*profileFullName`; it is never used as
the activity actor or as the subject identity. This follows the two labeled edges in the
promoted comments and reactions fixtures and prevents engagement with another person's post
from being attributed to that post's author.

## D241 — `profile.activity` is archive-only with fixed-size receipt counts pending a schema decision (2026-08-09)

Spec section 7 has no table for a person's outbound comments or reactions, and
`person_posts` is reserved for authored posts. The capability therefore performs no store
write: it reports bounded counts by activity kind plus an archive-reparse hint. Adding a
`person_activity` table remains an operator decision and cannot be implied by the existing
post tables.

## D242 — Comments and reactions are parsed as two explicit feed envelopes (2026-08-09)

The parser accepts only `feedDashProfileUpdatesByMemberComments` and
`feedDashProfileUpdatesByMemberReactions`, assigning the activity kind from the envelope that
LinkedIn's UI requested. It does not infer reaction versus comment from prose or recursively
search `included[]`, and it ignores `meta.microSchema` declarations entirely.

## D243 — `--limit` is a per-tab work bound (2026-08-09)

`profile.activity` reads two independently paged surfaces, so `--limit=N` permits at most N
referenced comments items and N referenced reactions items, for a total bound of 2N. Each tab
gets the same Task 27 conversion from item limit to scroll passes. Filtering by actor or
inclusive `--since` happens after examination and never replenishes either tab's allowance.

## D244 — The reader delegates two complete `activity.capture` runs (2026-08-09)

One comments capture and one reactions capture retain the proven raw-first, navigation,
pacing, challenge and ledger composition. The outer cost is two page loads and one distinct
profile open; the ledger's profile reference dedupes the second tab while both page loads and
the Task 20 sub-cap remain charged. A subject refused after the first capture prevents the
second page load rather than spending it for unusable output.

## D245 — Activity target fields reuse Task 27's post graph projection (2026-08-09)

Task 27 now exports the pure included-entity graph index and target-post projector it already
used internally. `profile.activity` composes those functions for the target urn, text,
snowflake timestamp, and social counts, then adds activity kind, actor urn and target-author
urn. This keeps `ugcPost`/`share` social-detail resolution and malformed-snowflake behavior in
one implementation rather than allowing the two readers to drift.

## D246 — Session identity is checked twice, at subject and item actor boundaries (2026-08-09)

The composition refuses a viewee subject left in the session identity set before the second
load. The pure parser independently excludes any item whose header actor is session-owned
before testing subject equality. The second check is intentional defense in depth for
archived reparse and is mutation-pinned independently of composition.

## D247 — Promoted activity fixtures are optional to a fresh clone, not to this worktree (2026-08-09)

Fixture tests resolve `fixtures/profile.activity` through `repoRoot()` and guard all required
files with `existsSync`. A checkout without the gitignored promoted library reports the suite
as skipped rather than throwing `ENOENT`; this worktree has the fixtures, so all field and
mutation assertions execute rather than skip.

## D248 — The activity receipt exposes counts and an archive hint, never activity rows (2026-08-09)

The receipt reports usable comments and reactions separately, total work accounting, source,
and a fixed reparse instruction. Actor urns, target urns, post text, and captured URLs remain
in the raw archive and parser result only; none reaches stdout or structured logs. This keeps
the receipt fixed-size while retaining enough information to choose and later execute storage.

## D249 — Task 28 stops before the two-load live gate (2026-08-09)

Offline fixtures, named mutation failures, the full suite, typecheck and registry discovery
are the implementation gate. The real-profile comments/reactions run is operator-supervised
and remains deliberately unspent; no Task 28 development command opens LinkedIn.

### Task 28 review follow-up — exact envelopes, unique counts, and anchored actors (2026-08-09)

The composition admits only the comments envelope on the comments capture and the reactions
envelope on the reactions capture. The pure parser independently returns zero examined work
for any other envelope, so an unrelated body cannot consume a tab's allowance. Non-JSON
bodies likewise return zero work in the shared post parser rather than leaking a raw
`SyntaxError` out of either reader.

Receipt counts are unique by activity kind plus target activity urn across all captured bodies.
Repeated pagination-boundary rows still consume examined work, and are accounted as skipped,
but do not inflate usable comments or reactions. The actor resolver scans every attributed
profile urn in the header for the already-proven subject rather than trusting attribute order;
a header with no resolvable actor is parse drift (`unresolved`), not a stranger exclusion.

`--since` remains the settled snowflake comparison but is now labeled in every receipt as
`target_post.posted_at`. The archive has no absolute comment/reaction event time, so renaming
the flag would not create the missing timestamp and would diverge from the other activity
readers without improving accuracy.

## D306 — Person activity stays archive-only; no `person_activity` table (2026-08-09)

Task 28's range D240–D249 is spent, so this takes the next free number (D18's rule, as
D130 and D185 did before it).

Task 28 ended with an open storage question: add a `person_activity` table via migration,
or keep outbound reactions and comments as receipt counts plus the raw archive. **The
operator chose archive-only.** Spec §7 defines no table for activity-on-others, the value
of this capability is the engagement signal rather than the rows, and forty fixture rows
are not enough to design columns from.

The choice is deliberately reversible and costs no re-scrape to reverse: every captured
body is archived under D2, the receipt already carries `storage: { mode: "archive-only" }`
and an `archive_hint` naming offline reparse, and the parser is pure. If a table is wanted
later, it is a migration plus a reparse of bodies already on disk — not another metered
pass over LinkedIn.

`profile.activity` therefore writes no database rows, and Task 28's deliverable is
complete without one.

## D307 — A capture releases its watches; watch registration is scoped to one capture (2026-08-09)

Found by the Task 28 live gate on 2026-08-09, not by any fixture. `profile.activity` opens
the comments tab and then the reactions tab through `activity.capture`, and both share one
`NetworkTap`. Watch names are unique within a tap — registering a duplicate is fatal
`TAP_DUPLICATE_PATTERN` by design (D-tap: replacing silently would redefine what an already
waiting `waitFor` is waiting for). `activity.capture` registered its patterns and never
released them, so the second capture died exit 1 *after the first had already spent a page
load*.

`tap.watch` has always returned an unsubscribe; nothing called it. It is now called, in the
same `finally` that drains, and deliberately **after** the drain: releasing a watch stops
bodies being fetched for it, so releasing earlier would drop exactly the late responses that
raw-first (D2) requires. Captures already taken are untouched — `unwatch` reads no archive.

The general rule this sets: **watch registration is scoped to one capture, not to a session.**
A capability that delegates to a capture more than once may now do so freely.

Why no fixture caught it: every offline test constructs a fresh tap per run, so the collision
needs two real captures over one session. The regression test injects the tap through
`makeTap` and asserts `watching` is empty after the run; it fails when the release line is
removed (verified).

## D308 — The post permalink still will not load, and the URL-spelling hypothesis is dead (2026-08-09)

Task 29's task file named one thing to try before starting: the `/posts/<slug>-activity-<id>-<hash>`
spelling instead of `/feed/update/`, on the theory that the two document paths behave
differently (D300 already watches both). **Tried and disproven.**

Run `01KZKVYA4JH3TXN1W26CN3RY4A` used the real permalink for the *same post* the two earlier
attempts used — activity `7491197577439141888`, harvested out of Task 27's own live archive,
so the slug and hash are LinkedIn's own, not constructed. It failed identically to runs
`01KZKM4HC3V94H761M65KPCFM7` and `01KZKMDFGDM48683YJ0P2S5NSM`: `CDP_SOCKET_ERROR`, exit 6,
2,402ms. Three failures, two URL spellings, one behaviour.

The event trace localises it. The document response arrives, then `capture.miss` fires on the
`activity-document` pattern — the body is not retrievable — and the *browser-level* socket
errors immediately after. The failure is in fetching that document's body, not in navigation
and not in the page rendering.

**A second hypothesis is also dead: CDP frame size.** The client uses Node's global
`WebSocket`, and a 100 MB message over a local socket round-trips fine — measured at 1 MB,
5 MB, 10 MB, 20 MB, 50 MB and 100 MB, all OK. A large `Network.getResponseBody` result is
not what kills the connection.

What is *not* yet excluded: browser state. The automation Chrome is holding 9 pages, 27
iframes and 60 workers, including 8 LinkedIn tabs left open by earlier probe runs. Chrome
itself survives every failure — `/json/version` answers normally afterwards — so this is the
socket dropping, not a crash. The task file's other suggestion, a fresh Chrome with no other
tabs, is the one variable still untested, and it needs the operator: it discards whatever
they have open.

**Task 29 therefore remains blocked**, now with two fewer candidate explanations and a
narrower target: the body fetch for this one document type.

## D309 — The permalink failure is UTF-8 validation in Node's WebSocket, not LinkedIn (2026-08-09)

**Root cause, measured, after four live failures.** The post permalink page is fine. Chrome
is fine. The operator loaded the page by hand while watching this run and it rendered
normally, and `/json/version` answers after every failure. What dies is *our CDP socket*, and
the reason is in our own transport.

`CdpClient` uses Node's **global** `WebSocket` (undici). Undici performs strict UTF-8
validation on inbound text frames and **fails the entire connection** when a frame is not
valid UTF-8 — it does not drop the frame, it kills the socket. `Network.getResponseBody`
relays the document body as a text frame, and this post's document body is not valid UTF-8,
so fetching it destroys the browser-level connection.

The socket `error` listener was discarding the event, which is why four runs produced no
cause. It now records one (D15 always said the raw CDP error is kept as evidence). With that
in place the live run reported `TypeError: ` — a TypeError with an empty message.

Reproduced offline, no LinkedIn involved:

| frame | global `WebSocket` |
|---|---|
| valid UTF-8 with emoji | delivered |
| `0xED 0xA0 0x80` (lone surrogate) | `TypeError: ""` |
| `0xC3 0x28` (bad continuation) | `TypeError: ""` |

That empty-message `TypeError` is a byte-for-byte match with the live evidence.

Frame size is **not** the cause and is formally excluded: 1, 5, 10, 20, 50 and 100 MB
messages all round-trip. Browser state is **not** the cause: attempt four ran on a Chrome
launched seconds earlier holding 11 targets.

**The fix, verified offline:** the `ws` package with `skipUTF8Validation: true` delivers the
same frame intact and the payload still parses as JSON. `ws` default validation fails it with
`Invalid WebSocket frame: invalid UTF-8 sequence` — same defect, clearer message.

Not yet implemented: `ws` is currently a devDependency, and promoting it to a runtime
dependency swaps the transport under every capability. That is the operator's call, recorded
here rather than taken unilaterally.

**Scope of the bug is wider than Task 29.** Any capability fetching any body with invalid
UTF-8 loses its connection mid-run. Task 29 is where it was first cornered, not where it ends.

## D310 — The CDP transport is `ws` with UTF-8 validation off, and lossy bodies are tagged (2026-08-09)

**Decided (operator-approved).** `CdpClient` now opens its socket with the `ws` package,
`skipUTF8Validation: true`, an explicit `maxPayload` of 512 MB, and `perMessageDeflate: false`.
`ws` moves from devDependency to runtime dependency; it was already installed and already used
by the test suite, so nothing new enters the supply chain.

**Why.** D309 measured the cause: Node's global `WebSocket` (undici) fails the *connection* —
not the frame — on an inbound text frame that is not valid UTF-8, which RFC 6455 permits and
which is fatal here, because `Network.getResponseBody` relays document bodies as text frames.
The suite now reproduces it offline: before the swap, a reply frame carrying `0xED 0xA0 0x80`
or `0xC3 0x28` killed the client with `CDP_SOCKET_ERROR`; after it, the reply is dispatched and
the connection still round-trips. This was never specific to Task 29 — any capability fetching
any such body lost its connection mid-run.

**Blast radius is one constructor.** `new WebSocket(...)` appears only in `src/core/cdp/client.ts`.
The tap, the tab, and the session take a `CdpClient` and were not touched.

**The cost, and what is done about it.** `skipUTF8Validation` does not preserve the bad bytes.
The frame is still decoded with `Buffer.toString("utf8")`, so invalid sequences arrive as
U+FFFD. The payload parses as JSON, but the archived body is then **not byte-exact**, and
"raw first" (D2) would quietly become false on exactly these pages.

So a text body that comes back containing U+FFFD is tagged `lossyUtf8` on the capture, on the
archive sidecar, and on the `capture.hit` event. The flag is deliberately conservative: a body
that genuinely contains U+FFFD is tagged too, because by the time we hold a string the two are
indistinguishable. A base64 body is never tagged — those bytes are exact by construction. The
point is that a parser drift chased months from now can tell "LinkedIn changed the field" from
"we lost bytes reading it".

**Rejected: byte-exact capture via `Fetch.takeResponseBodyAsStream`.** It would preserve the
bytes, but it requires `Fetch.enable` — request interception on the one account we have. The
detection surface is not worth an edge case in a handful of documents, when the alternative is
knowing precisely which captures were affected.

## D311 — Correction to D309: the transport fix is right, its stated cause is not proven (2026-08-09)

The `ws` swap (D310) works — the permalink captured cleanly on the first attempt after it,
run `01KZKXSGNE4XRQMJRK241YQS6Q`, exit 0, 26 captures, 0 misses, after four consecutive
failures. That result stands and is not in question.

**What does not stand is D309's specific claim that this post's document body is not valid
UTF-8.** Measured on the body now archived:

- **Zero** U+FFFD replacement characters in all 4,750,447 bytes. Had the bytes been invalid,
  `Buffer.toString("utf8")` under `skipUTF8Validation` would have produced one per bad
  sequence. It produced none.
- The obvious follow-up theory — valid UTF-8 with a multi-byte character straddling a frame
  boundary, which RFC 6455 permits — is **also disproven**. A hand-built server that splits
  `🎉` across a text frame and its continuation is handled correctly by the global
  `WebSocket`: message delivered intact.

So what is established is narrower than D309 said, and should be read as the real finding:
the global `WebSocket` fails the *connection* with an empty-message `TypeError` on some frame
in this exchange; invalid UTF-8 in a single frame reproduces that exact signature offline; and
`ws` with validation off survives where it did not. The precise trigger in the live exchange
is **not** identified. It may not even be the document body — the socket death was only
correlated with that fetch.

**Consequence for D310's `lossyUtf8` tagging:** on the one capture we now have, nothing is
lossy. The flag is harmless and correctly conservative, but it should not be read as evidence
that LinkedIn serves malformed bodies. No archived body has yet been shown to be lossy.

Left open deliberately rather than closed with a tidy story. The fix is proven; the mechanism
is not, and writing it down as proven would be the kind of thing that costs an account later.

## D312 — `post.get` reads the DOM snapshot; this needs a third exception (2026-08-09)

**Source verdict for Task 29, measured on run `01KZKXSGNE4XRQMJRK241YQS6Q`.**

The permalink carries **no labeled JSON for the post**. Measured in the 4,750,447-byte
document response and all 26 captured bodies:

- `bpr-guid` embedded data islands: **0**. D117's "embedded structured data in the initial
  document" route does not exist on this surface.
- `socialActivityCounts`: **0** occurrences. No reaction or comment counts as labeled fields.
- No `urn:li:ugcPost` anywhere in the document.
- The `gql-social-reactions`, `gql-social-comments`, `gql-social-detail` and
  `gql-social-activity-counts` watches all recorded **0 hits**. Those panels are not fetched
  on a cold load; they need interaction we have not designed yet.

What *is* there is the rendered DOM, and it is anchored the way D305's job reader is:

- `data-testid="ReactionFacepileCollection-urn:li:activity:7491197577439141888"` — the
  subject's identity, in a `data-testid`, resolvable-or-refusable against the requested urn.
- `data-testid="…-commentList…FeedType_FEED_DETAIL"` — the comment list scope.
- 15 `expandable-text-box` nodes (post body and comment bodies), 56 `urn:li:comment:` urns in
  the snapshot and 900 in the document.
- `card_ref_scope_resolved: false` — the `/in/<vanity>` card-ref identity rule (D127) does
  **not** carry over here, exactly as on the activity surface.

**[DECISION NEEDED] — this would be the third DOM-source exception**, after the profile reader
(D123/D130) and the job reader (D305). CLAUDE.md currently says "those two exceptions are the
profile reader and the job reader, and nothing else". Task 29 cannot be written without either
amending that sentence or abandoning `post.get`. The operator decides; this entry does not
grant the exception.

If granted, the shape is already settled by precedent and should not be re-derived: `outerHTML`
snapshot, archived raw, parsed **offline**, every row tagged DOM-sourced, scope anchored on
`data-testid` rather than container position or hashed classes, identity resolved-or-refused
against `urn:li:activity:<id>`.

**`--reactors` / `--commenters` are a separate and harder question** and should not ride along
with the above. Those lists are not on the page at load; they require opening a panel, which
is interaction, and the standing rule is that we never forge a request the UI did not issue.
Task 29's file already scopes them to "people the panel actually loaded". Recommend splitting:
post detail first under the exception above, reactor/commenter lists as their own measured
task.

## D313 — The post reader gets the third DOM exception, and it is opt-in and bounded (2026-08-10)

**Granted by the operator**, superseding D312's open question. `post.get` may read the rendered
DOM for the post's own fields, its comments and its reactions. CLAUDE.md's "two exceptions"
sentence is amended to three in the same commit.

The exception is granted **with conditions attached to spend, not to correctness**, and the
conditions are the operator's words: comments are not necessary by default, we must not send
the request again and again to get the whole thread, and reactions rank below comments. So:

1. **A default `post.get` reads the post only.** No comments, no reactions, no panel opened.
2. **Comments are opt-in and bounded** — `--comments` with `--comments-limit` (default 10).
   Whatever is rendered on the cold load is what gets read.
3. **Reactions are opt-in and bounded, and rank below comments** — `--reactions` with
   `--reactions-limit` (default 10). Never fetched unless named.
4. **Nothing loops "load more".** The reader takes one bounded pass over what is present. Any
   growth in the thread is a later, explicitly-requested run — never an implicit one.
5. **A partial read is always flagged as partial.** When the page states a comment or reaction
   total higher than the number of rows read, the receipt carries `COMMENTS_PARTIAL` /
   `REACTIONS_PARTIAL` naming both numbers. Silence would let a caller mistake the first ten
   comments for the thread, which is the specific failure the operator called out.

Why the bound is a rule and not a default: exhausting a comment thread means repeated
interaction with the page, and every one of those is spend against a single irreplaceable
account for data the operator has said is low value. The cheap read is the point.

Shape is inherited from D123/D130 and D305 and is not re-derived: `outerHTML` snapshot,
archived raw, parsed offline, every row tagged DOM-sourced, scope anchored on `data-testid`
rather than container position or LinkedIn's per-build hashed classes, identity
resolved-or-refused against `urn:li:activity:<id>`.

**Still out of scope: `--reactors` / `--commenters` as people-lists.** D312 recommended
splitting them and that stands. Reading the reactions *count* and the reaction rows rendered
on the page is inside this exception; opening a panel to enumerate every reactor is
interaction, is unmeasured, and stays its own task.

## D314 — `post.get` stores nothing yet, because the snapshot carries no author urn (2026-08-10)

Task 29's file asks the post row to route into `person_posts` or `company_posts` by author
type. **It cannot, and the reason is measured, not preferential.**

The snapshot carries no author urn anywhere. Twelve `urn:li:member:<id>` values appear, all in
follow-state components and none anchored to the author; there is no urn within 3,000
characters of the author's own profile link. The author is identifiable only as a **vanity**
(`tankots`), resolved by eliminating comment rows, the reaction facepile, and the session's own
public identifiers.

`person_posts.person_urn` and `company_posts.company_urn` are both `not null`. Writing a row
would mean inventing an author key, which is the one thing the identity rules never permit —
and the task file already anticipated exactly this with "refusing an unresolvable author".

So `post.get` returns the post on the receipt and leaves the raw snapshot archived.
`storage: { mode: "archive-only" }`, the same shape D306 settled for `profile.activity`, and
reversible the same way: the bytes are on disk, the parser is pure, and a later write path is a
reparse rather than another metered pass.

**The route that would work, deliberately not taken here:** resolve the author vanity against
an existing `persons` row via `findPersonByVanity`, refuse when absent. That is a real storage
decision with a real ambiguity case — `findPersonByVanity` already reports `vanityMatches`
because a vanity can match more than one person — and it deserves its own entry and its own
tests rather than being slipped into this one.

## D315 — Comments and reactions are bounded by construction, not by discipline (2026-08-10)

D313 set the policy; this records how it is enforced, because a policy that lives only in a
README is one refactor from gone.

- The parser takes `comments` / `reactions` as **optional option objects**. Absent means the
  section is not read at all — not read-then-discarded. A default run cannot produce a comment
  row, because no code path builds one.
- Each section is bounded twice: by the caller's `--*-limit`, and by a parser-local
  `MAX_*_ROWS` of 200 so a malformed snapshot cannot grow the output without limit.
- The reader takes **one** bounded pass. There is no "load more" call anywhere in the
  capability, and a limit above what the page rendered returns what the page rendered — proven
  by test: limit 500 against a 73-comment post returns the 14 rows present.
- Partial reads are flagged with both numbers (`COMMENTS_PARTIAL`, `REACTIONS_PARTIAL`) and
  restated as booleans (`read.comments_complete`). Silence is never allowed to read as
  completeness — that was the operator's specific concern.

Mutation-verified: removing the session-vanity exclusion, the comment-limit slice, or the
identity-mismatch refusal each fails its own named test.

## D316 — Capability schema keys are camelCase, and the registry enforces it (2026-08-10)

**A defect that shipped twice before anything caught it.** `parseArgv` camel-cases every flag
name before a schema ever sees it, and every capability schema is `.strict()`. So a key written
`"comments-limit"` is **unreachable**: the CLI accepts `--comments-limit`, hands the schema
`commentsLimit`, and strict mode rejects it as an unrecognized key. The flag simply does not
work, and nothing in the suite noticed.

Two instances, both fixed here: `log.runs`'s `include-queries` (pre-existing, and documented in
its own README as though it worked) and `post.get`'s `comments-limit` / `reactions-limit`.

**Why the suite missed it, which is the more important half.** Capability tests build argument
objects by hand — `rawArgs: { "include-queries": "true" }` — so every one of them asserted
against a shape the CLI cannot produce. `cap list` made it worse rather than better: the
manifest prints schema keys verbatim, so it advertised the broken spelling as the contract.
A capability could be green in tests, green in `cap list`, and unusable.

**The guard: `tests/cli-schema-keys.test.ts`.** It walks the whole registry and requires
`camel(key) === key` for every schema key of every capability, then round-trips real argv
through the real `parseArgv` into the real schema for both capabilities that had the bug. A new
capability with a kebab-case key now fails on the day it is written rather than the day someone
first types the flag. Mutation-verified: restoring either kebab key fails two of its three
tests.

CLI spelling is unchanged and stays kebab — `--comments-limit` is what an operator types. Only
the schema key had to move.

## D317 — The post's totals are scoped outside the comment rows (2026-08-10)

`totalFrom` took the first leaf element whose whole text is `<n> <noun>`, anywhere in the
document. Comments render their own reaction counts ("8 reactions"), so the search could return
a comment's number as the post's. It read correctly on the fixture only because the post's
totals bar happens to render above the comment list — a layout accident, not a promise.

The existing `outsideComments` predicate — the same identity-based exclusion the author
resolution already uses — is now applied to all three totals. Zero cost, and it removes a
silent-wrong-number path rather than a loud one.

## D318 — A permalink names itself; `post.get` passes no surface hint down (2026-08-10)

Found by the live gate on 2026-08-10, and by nothing before it. `post.get` delegated to
`activity.capture` with `surface: "post"`, which `normalizeActivityUrl` refuses —
`--surface=post` "names no page on its own", because the flag exists to disambiguate a *bare
vanity slug*, and a permalink already carries its own identity.

The composition tests could not see it: they inject a fake capture, so the real
`normalizeActivityUrl` was never reached with the real arguments. The same blind spot as D316,
one layer down — a seam mocked in tests and unmocked in production.

The failure direction was right, which is the only comfort here: refusal happened before the
budget was touched, so the run cost **0 page loads**. Now pinned by a test asserting the
delegated capture receives no `surface` property at all.

## D270 — DOM field maps are routed by fixture family (2026-08-09)

Fixture relevance, subject resolution and JSON probes were already selected through
`familyOf`, but DOM maps always used the profile card-ref mapper. DOM mapping and rendering
now follow that same family decision: profiles retain card-ref scope; jobs resolve one
job-posting urn and expose content only through the `expandable-text-box` test id beneath
the `About the job` heading. A document naming zero or multiple job ids has no subject scope.

The widest-net run contains the 21 network bodies but no archived DOM-snapshot entry. Its
promotion was attempted and produced no fixture. The existing snapshot from the first
measured run was therefore re-mapped with the corrected job rule; no page was loaded.

## D271 — job detail parsing stores only observed detail fields (2026-08-09)

The detail snapshot proves a description and a job identity. It does not prove title,
location, posting time, workplace type or company identity on the measured page, so the
parser omits them instead of copying display text into labeled columns. Description is read
only from the `About the job` block containing `data-testid="expandable-text-box"`; all output
is tagged `dom-snapshot`. A sole company urn may be normalized to `urn:li:fsd_company:<id>`,
but ambiguity or agreement with a supplied session/trap urn refuses that field.

## D272 — job list and detail writes share one partial upsert on `jobs.id` (2026-08-09)

The jobs writer uses the bare numeric posting id as its sole conflict target and omits every
field the caller did not observe. A list write can therefore establish title/location and a
later detail write can add description to the same row without nulling list fields or creating
a duplicate. `last_seen` is stamped with the write and `first_seen` remains the database default.

## D273 — job identity is URL agreement, not document-wide urn uniqueness (2026-08-09)

D270's zero-or-multiple refusal is superseded here. The capture deliberately scrolls far
enough to lazy-load recommendation rails, which may name other postings. The reader now
requires that the normalized requested id is among the document's job-posting urns; an absent
target is refused, while unrelated document-wide candidates neither become identity nor
invalidate the target. The field map inventories all candidates and states the URL cross-check.

## D274 — no company urn is stored until the job surface exposes subject scope (2026-08-09)

The measured fixture contains no company urn. Sweeping the whole document would let an ad or
recommendation module become the employer, and comparing those urns with `sessionUrnsOf` was a
dead guard because that helper returns person urns only. Therefore every unscoped company-urn
candidate is refused and warned; a future company identity requires a measured subject anchor.

## D275 — jobs enrichment is monotonic across both undefined and null (2026-08-09)

D272's omission promise is extended to explicit `null`: the writer drops both nullish forms.
This prevents a sparse `company.jobs` observation from erasing a description previously stored
by `job.get`. Clearing a jobs field is not supported without a future explicit operation whose
contract distinguishes deletion from absence.

## D320 — A profile is read to its end, not for a fixed number of passes (2026-08-10)

The live gate on 2026-08-10 stored Tanay Kothari with `current_company_urn: null` and zero
experience rows, on a clean exit 0, from a profile whose headline is "CEO at Wispr Flow". The
capability that qualifies leads returned a lead with no employer and warned once, quietly, in
`parse.miss`.

The cause is not the parser and not the scroll pacing. LinkedIn defers everything below the
Activity card into seven numbered containers —
`<div id="profileCardsBelowActivityPart3tankots">` — each carrying an `onComponentAppear`
trigger at `visibilityRatio: 0` whose action is an `AsyncComponentRequest` for its own content.
Read out of the initial document of run `01KZMMFNSMFJ8CKHV9R9JJZ1GY`. A container never
scrolled into view never fetches, and stays an empty div. Experience, Education and Skills live
in those containers.

The page grows as it is read: `main#workspace` laid out at 2145px and finished at 7348px. A
pass count fixed before the read therefore cannot express "all of it" — the randomized 3-6
passes covered 3366px, and all seven containers were still empty at snapshot time. Every
profile run ever recorded, back to 2026-08-08, has the same hole: no capture has ever archived
an Experience card. This was never a regression; the field never worked, and the M3 gate passed
without it.

Measured, not assumed: a live read with `--scrolls=12` on the same profile hydrated 6 of the 7
containers and archived 23 cards including `ExperienceTopLevelSection` and
`EducationTopLevelSection`.

So `readLikeAHuman` gains an opt-in `untilBottom`, which scrolls until the page stops having
more, bounded by `SCROLL_PASSES_CEILING` (20). Only `profile.capture` asks for it. A feed does
not end, and a bottom-seeking read of one would mean "scroll to the ceiling" every time, so
`activity.capture`, `job.capture` and `company.probe` keep the fixed-pass behaviour they pass
explicitly. An explicit `--scrolls` still wins everywhere: a count from the operator is an
instruction, not a hint.

Two silences are now warnings. `PAGE_NOT_READ_TO_BOTTOM` when the ceiling is reached with page
below it. `DEFERRED_SECTIONS_EMPTY` when every deferred container is still empty after
`DEFERRED_SECTIONS_TIMEOUT_MS` — counted by a render-confirmation DOM read, which D1 permits
everywhere, that asks only whether containers are empty and never reads a field out of one.
`hydrated === total` is deliberately *not* the bar: a container whose section the person has
nothing in stays empty however long anyone waits.

Verified live after the change: `cap profile.get` on default flags stored 6 experience rows and
`current_company_urn: urn:li:fsd_company:79835899`, confirmed by direct Supabase query rather
than by the receipt.

## D321 — The profile readiness gate accepts the document, not only an API body (2026-08-10)

Twice on 2026-08-10, on two different profiles, the page answered with its server-rendered
document — 1.0MB, fully populated, captured and archived — and issued no Voyager call at all
within the 25s window. `profile.capture` waited on the broad `linkedin-api` pattern alone, so
both runs failed `CAPTURE_TIMEOUT` at exit 6 and spent the page load for nothing.

Nothing was wrong with either page. This reader's source is the rendered DOM (D123 content,
D130 identity); no Voyager endpoint carries a stranger's profile on a cold load, which is why
the exception exists at all (D126). A load that answers with the document and nothing else is
a load it can read.

The gate now waits for whichever arrives first, the broad API pattern or this target's own
document pattern, and fails only when neither does. It is a readiness gate, not a safety gate:
no rule is loosened, nothing new is requested, and the challenge gates on either side of it are
untouched.
