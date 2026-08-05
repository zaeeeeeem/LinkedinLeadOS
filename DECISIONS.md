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

## D114 — `readyState: "complete"` is not layout; the capture waits for the document to grow
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
