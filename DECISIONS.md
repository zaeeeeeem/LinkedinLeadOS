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
