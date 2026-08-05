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
path is fatal `TAB_LEASE_UNWRITABLE` / exit 1 (D13's question). Proven: 69/69 tests pass offline
(the entry first read 64, which counted the lease work before 868e612's reclaim fix added
five; corrected 2026-08-08 during the Task 4 review — 28 new; dead pids taken from exited child processes, four real racing processes on one lockfile,
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
itself; a tab this session closed is fatal and non-retryable while one that detached on its
own stays transient (D17, revised after review), and teardown's timeout timers are unref'd so
a fast close does not hold the event loop. Proven: 14 offline tests against a recording CDP
double pin the attach surface and the escalation order (added beyond the task file, which asked for none — those two are safety
properties a passing live check cannot see); 83/83 tests pass, typecheck clean. Live against
the automation Chrome: worker tab created in the background, `https://example.com/` read back
with title `Example Domain`, foreground reached at `via: "already"` without touching
`activateTarget`, a 41,550-byte screenshot written, and a fresh reconnect saw the target count
back at its starting value. A second live probe confirmed emulation is load-bearing — with it
`hidden: false`, with it dropped `hidden: true`, and `ensureForeground` recovered at step one.

Task 6 — event logger and run context (Tasks 4/5 were being built in parallel worktrees;
see their own entries for status when merged, not restated here). `src/core/run/
{events,paths,context}.ts`: `EventLogger` appends NDJSON synchronously over a held fd
(closed set of event names, seq continuing past resumes); `RunContext.open()` mints a
ULID run and `raw/`/`shots/` dirs on create, or reuses the directory and appends a
`resumed_at` timestamp + logs `checkpoint.resume` on resume; rejects an unknown run id as
`RUN_NOT_FOUND` and a capability swap as `RUN_CAPABILITY_MISMATCH` (both exit 1);
`checkpoint()`/`lastCheckpoint()` round-trip arbitrary state via atomic tmp+rename with
latest-wins (D20); `screenshot()` writes zero-padded, collision-free names under
`shots/`; `artifacts()` matches spec §5's `runs/<id>/events.ndjson` / `runs/<id>/raw/`
shape; `finish()` writes `summary.json` and is idempotent. Proven: 58/58 tests pass
offline (22 new, all in `fs.mkdtempSync` temp dirs), typecheck clean.
Reviewed 2026-08-08 — screenshot counter now seeds from the highest surviving `NNN-`
prefix instead of the file count (a triaged-away screenshot no longer causes the next
one to overwrite a survivor); `run.json`/`checkpoint.json` parse failures are now
classified `CapabilityError`s (`RUN_META_CORRUPT` / `RUN_CHECKPOINT_CORRUPT`, exit 1)
instead of raw `SyntaxError`s escaping; all three archive writes (`run.json` on create,
`run.json` on resume, `summary.json` on finish) go through the same atomic tmp+rename
path; added a doc comment on `RunContext`/`EventLogger` stating that `seq` is unique
only within one process's hold on a run id and nothing enforces single-writer access.
Proven: 61/61 tests pass offline (3 new), typecheck clean.

Task 7 — raw archive and structural shape hashing. `src/core/archive/shape.ts` (pre-existing):
`canonicalShape`/`shapeHash`/`shapeHashOfBody`/`NON_JSON_SHAPE`. `src/core/archive/raw.ts`
(new): `RawArchive` over a plain directory string — `archive(input)` gzips the body, writes it
first as `<seq>-<shapeHash>.json.gz` with metadata beside it in a `.meta.json` sidecar (D30),
then `list()`, `read()`, `readText()`. `seq` seeds from the directory so a resumed run keeps
numbering; writes claim their filename with `wx` so two instances over one directory can't
clobber each other. Errors are `ARCHIVE_WRITE_FAILED` / `ARCHIVE_ENTRY_MISSING`, both
`HALT_AND_NOTIFY`/non-retryable, via the shared `CapabilityError`. No Task 6 event logging
yet — the branch forked before Task 6 reached main; Task 9's network tap is the natural place
to emit `capture.hit`/`capture.miss`, and wiring it there rather than here stays the plan.
Proven: 27 new tests pass offline (135/135 across the suite after merging into main; 16 in
`tests/archive-shape.test.ts` pinning every shape-hash rule, 11 in `tests/archive-raw.test.ts`
covering gzip-on-disk, byte-identical read-back of string/`Uint8Array`/emoji bodies,
no-dedupe on identical shapes, `list()` metadata and empty/missing-directory cases,
seed-from-disk resume, and `ARCHIVE_ENTRY_MISSING` on an unknown id), all in `mkdtemp` temp
dirs cleaned up per test; typecheck clean.

Task 7 follow-up (2026-08-08, in the Task 8 commit) — three review findings closed, see D31:
a failed sidecar write is now `warning: ARCHIVE_SIDECAR_FAILED` on the returned
`ArchivedCapture` (message states the body is archived and readable) instead of a run-halting
`ARCHIVE_WRITE_FAILED`; read paths split into `ARCHIVE_READ_FAILED` (`readFile`/`readdir`) and
`ARCHIVE_CORRUPT` (not valid gzip) so `log:why` stops counting corrupt reads as write failures;
the pre-write shape hash stays as it is, with the reasoning written down rather than left implicit.
Proven: 4 new tests (degraded sidecar keeps a readable body and warns, clean path warns nothing,
`EISDIR` read → `ARCHIVE_READ_FAILED`, non-gzip body → `ARCHIVE_CORRUPT`).

Task 8 — human input primitives. `src/core/input/{constants,random,cursor}.ts`:
`HumanCursor` over a structural `InputTarget` (the Task 4 `WorkerTab`'s `send`), with
`moveTo`, `click`, `wheel`, `pause` and a `position` getter. Moves are quadratic Bézier paths
with a randomly signed bow, eased timing, 8–20 points, ±3px per-point jitter and a corrected
overshoot on ~20% of moves, always settling on a final unjittered dispatch at the exact target
so hit-testing is unchanged. Wheel dispatches real `Input.dispatchMouseEvent` `mouseWheel`
notches in the 40–120px band, planned so they sum exactly to the request rather than rounding
the last one up (D40 — deviation from the reference worker, which overshot by up to 39px); an
ask below one notch still rounds up and `WheelResult.scrolled` reports the truth. `buttons: 0`
on `mouseReleased`, matching a real mouseup (the reference sent 1). No delay anywhere is a
constant. `rng` and `sleep` are injectable seams so the statistical properties are provable
offline (D41); nothing in production passes them. Non-finite coordinates are refused before
dispatch as fatal `INPUT_INVALID_COORDINATE`; transport errors pass through unclassified (D17).
Reviewed 2026-08-08 — the recorded position now updates after *each* successful dispatch rather
than once the whole path completes: a mid-path transport failure used to leave `#at` on the
origin while the real pointer sat partway along the curve, so the next `moveTo` planned from a
position the browser did not share and opened with a teleport — right after a retryable failure,
which is when a caller retries. Also, a `moveTo` to the point the pointer is already on now
dispatches nothing, instead of emitting 8–20 identical one-pixel moves via the `dist || 1` path.
Proven: 25 offline tests against a recording fake tab (164/164 across the suite), typecheck
clean, no browser involved. Live against the automation Chrome on a local `file://` probe page,
never LinkedIn: one click produced 21 real `mousemove` events, all `isTrusted`, starting at
(623, 320) and settling on exactly (360, 230), with the button receiving a trusted `click` at
that point; `wheel(…, 640)` produced 9 notches, every delta inside the band, summing to exactly
640, and the page's `scrollY` read back 640.

Task 9 — network tap. `src/core/tap/{constants,network-tap}.ts`: `NetworkTap` over a
structural `TapTransport` (the Task 3 `CdpClient`) plus the worker tab's `sessionId`, a
`RawArchive`, and an optional event sink — `watch`/`unwatch`/`watching`, `start`/`stop`/
`running`, `captures()`/`misses()`/`cursor`/`stats()`, `waitFor(pattern, {timeoutMs, since})`
and `drain()`. Purely passive (D1): it enables no CDP domain — `Network` is already on from
`WorkerTab.attach`, which stays the one place the attach surface is decided (D8) — and it
only ever reads bodies the page fetched itself. A response is fetched only once both its
`responseReceived` (which carries the URL, and so whether we care) and its `loadingFinished`
have been seen, in either order, because CDP orders events within a type and not across them;
a duplicate finish cannot re-fetch a claimed body. Every body is archived (D2) before the
capture is handed to anyone or a waiter wakes. Events are filtered on `sessionId`, so another
target's traffic cannot leak in, and the per-request bookkeeping is capped at
`SEEN_REQUEST_CAP` so an hours-long run cannot leak. Reviewed 2026-08-08 — the cap did not
cover the map that actually accumulates and the overflow was invisible: `#inflight` was
unbounded, and because *every* unmatched `loadingFinished` took a slot in the early-finish
map, one of our own early finishes could be evicted before its response arrived and the
response was then dropped with no capture, no miss, and a `waitFor` timing out reporting zero
misses. Early finishes are now remembered only for requests already matched at
`requestWillBeSent`, `#inflight` is capped, and both of its loss paths (cap eviction, and
anything still in flight at `stop()`) record an `abandoned` miss (D52). Also fixed: `waitFor`'s
`since` lookback matches captures by URL rather than by the pattern names recorded on them, so
a pattern registered after a capture landed — every inline pattern — can actually look back
instead of silently degrading into "wait for the next one". Lost bodies (evicted buffer,
`loadingFailed`, archive write failure) are recorded misses + `capture.miss`, never throws,
and they do not fail a pending wait — the `CAPTURE_TIMEOUT` message names how many misses that
pattern saw instead (D51). `waitFor` defaults to the *next* capture and takes a `since` cursor
for the click-then-await race (D50); it fails as transient `CAPTURE_TIMEOUT` (exit 6), fatal
`TAP_UNKNOWN_PATTERN` on a typo'd name, and fatal `TAP_STOPPED` when the tap is stopped under
it (same reasoning as `CDP_CLIENT_CLOSED` / `TAB_CLOSED`). Proven: 37 offline tests against
a fake CDP emitting synthetic protocol sequences, four of them regressions for the review
findings — our early finish survives a 2,000-request flood, unwatched traffic takes no
early-finish slot at all, the inflight cap reports what it drops, and an inline pattern looks
back over history (201/201 across the suite, three consecutive runs with no flake), typecheck clean. No live check — the task file assigns real-traffic proof
to Task 15's live capture.

Task 10 — challenge and auth detection. `src/core/challenge/{constants,classify,detect}.ts`:
pure classifiers `classifyUrl` / `classifyText` / `classifyResponse` / `worstVerdict` /
`challengeError`, plus a live-tab detector `probeTab` / `detectChallenge` and the halt
helpers `recordChallenge` / `assertNoChallenge`. Seven kinds — `clean`, `captcha`,
`checkpoint`, `login`, `rate-limited`, `restricted`, `unrecognized` — each with its own
code and one operator action: exit 2 `HALT_AND_NOTIFY` for captcha/checkpoint/restricted/
unrecognized, exit 4 `REAUTH` for login, exit 3 `RETRY_BACKOFF` (the only `retryable`
one) for rate limiting. The gate **denies by default** (D60): a linkedin.com path that is
neither a known challenge nor on the coarse app allowlist, an unparseable URL, and a page
whose body could not be read all classify `unrecognized` and halt, because a false
positive costs a manual restart and a false negative costs the account. `classifyResponse`
deliberately does not deny by default (D61) — it runs the deny list plus HTTP status, since
no allowlist of LinkedIn's API paths could be kept current. The DOM read is a single
`Runtime.evaluate` so URL, text and captcha-widget presence describe the same instant, and
only a matched marker ever reaches a verdict, never page text. `recordChallenge` guards
every evidence step individually and checkpoints before it screenshots, so a read-only
shots/ or a dying browser degrades the receipt and never the halt. Also fixed here:
`RunContext`'s `Screenshotter` returned `Promise<void>` while `WorkerTab.screenshot`
returns `Promise<string>`, so Task 4 and Task 6 did not actually compose (D62) — widened
to `Promise<unknown>`.
Proven: 80 new offline tests (281/281 across the suite), typecheck clean. Among them:
every URL, status and text classification above pinned both ways; three unseen-challenge
cases (`/verify/identity`, `/security/hold`, an unparseable URL) proven not to read as a
normal page; an unreadable body proven not to certify clean; `PROBE_EXPRESSION` executed
as real JS against a stub document to pin its shape and its 20,000-char cap; the
screenshot-fails, checkpoint-fails, no-run-context and hostile-run-context paths all
proven to still return the halt; and compile-time assertions that `WorkerTab` and
`RunContext` satisfy the structural types, verified to fail when D62's widening is
reverted. Live against the automation Chrome on local `file://` probe pages, never
LinkedIn: `PROBE_EXPRESSION` ran in a real page and read back `readable: true`,
`captcha: true`, 60 chars of text; the blocked page classified `captcha` and the clean
page `clean`.
Reviewed 2026-08-08 — four changes, all in the direction of not guessing. Two signals
that claimed `login` now classify `unrecognized` (D63): bare `/` as a bounce, and HTTP
403. Both were explicitly unverified, and exit 4 is not a neutral guess — it instructs a
re-login, and a needless re-login on a healthy session is itself an event LinkedIn
watches; `unrecognized` halts just as hard without prescribing it. 401 keeps `login`,
being unambiguous. The three throttle text markers are now `soft` and skipped above
`SOFT_MARKER_MAX_TEXT` (D64) — LinkedIn shows "couldn't load this content" on one broken
feed card, so on a 20,000-char feed they were near-certain to halt a healthy run with a
receipt indistinguishable from a real throttle; HTTP 429 remains the authoritative
signal and is untouched. The deny list is now normalized at module load, lower-cased and
sorted longest-prefix-first: `/checkpoint/challengesV2` was unreachable twice over — once
behind its own shorter prefix, once because prefixes were compared against a lower-cased
path without being lower-cased themselves — and neither showed up in a URL-level test,
since a shadowed entry is still caught by whatever shadows it. `worstVerdict()` over zero
signals returns `unrecognized` rather than clean, the one place the module certified
something it had not checked. Proven: 285/285 (4 new, including an invariant test that
every deny-list entry is reachable — verified to fail with either the sort or the
lower-casing removed), typecheck clean.

Task 11 — budget ledger. `src/core/budget/{constants,ledger}.ts`: file-backed,
append-only NDJSON at `runs/budget.ndjson` (D11) tracking three spend kinds — `page_load`
(hourly + daily limits), `search_page` (daily), `profile_open` (daily, deduped by `ref`
so the same profile opened twice in a day counts once) — against §8's defaults (60/hr,
400/day, 50/day, 120/day). `check()` is a read-only preflight peek; `spend()`
re-evaluates every limit itself and appends only if none would be crossed, so a caller
that skipped `check()` still cannot spend past a limit (D71); `BudgetLedger.open()`
binds a path once for both. A per-invocation `limits` override can only lower a
default, never raise or bypass one (§8) — an override above the default is silently
ignored rather than trusted. Daily windows are rolling 24h, not calendar-day (D70). A
corrupt or structurally-wrong ledger line fails every read closed (`BUDGET_LEDGER_CORRUPT`,
with only the line number and reason as evidence — never the line's own bytes, which can
carry a profile URN) rather than being skipped toward a lower count. The read-evaluate-write
sequence inside `spend()` runs under a lockfile mutex (`<path>.lock`, stale after 5s,
reclaimed by rename-to-quarantine rather than unlink so several racers judging the same
lock stale cannot all "win" it) so two racing spends against the same limit cannot both
observe "under limit" and both commit; a lock that can never be stolen (unwritable
directory) reports fatal `BUDGET_LEDGER_UNWRITABLE` instead of spinning, and one that is
genuinely held reports retryable `BUDGET_LEDGER_BUSY` after a bounded wait.
`spend()` also compacts the ledger to `COMPACTION_RETENTION_MS` (7 days — wider than the
24h any limit enforces, because nothing mirrors this file until Task 14; B3 tracks
narrowing it once that lands) plus the new record on every write (D72), fsyncing the tmp
file before the rename that publishes it so a crash between the two cannot surface as an
empty ledger granting a fresh quota (D72 revision). Proven: 31 tests pass offline in
`mkdtemp` temp dirs (316/316 across the suite), typecheck clean, three consecutive clean
runs — among them, each of the four limits tripping exactly at its boundary and not one
spend earlier, window expiry for both the hourly and daily windows, distinct-profile
dedupe including reopening an already-counted profile at a full quota, a corrupt line
failing both `usage()` and `spend()` closed (and staying closed rather than being
compacted past), an override above the default being ignored while one below it is
honored, an uncreatable ledger directory classified fatal and non-retryable, ten spends
racing a limit of five landing exactly five recorded ledger lines, eight trials of six
racers finding one pre-planted stale lock each landing exactly one recorded spend, a live
lock that never ages into stale timing out at the configured deadline rather than
hanging, and compaction dropping an entry past the retention window while keeping one
inside it (both a 25-hour-old entry, kept, and one just past `COMPACTION_RETENTION_MS`,
dropped) alongside the new spend.
Task 13 — Supabase local and the M1–M3 schema. `supabase/config.toml` (project
`linkedinleadsos`, ports 5532x — 5432x and 5632x are already held by two other local
stacks on this machine, D90), one migration
`supabase/migrations/20260808120000_m1_m3_schema.sql` establishing all 13 spec §7
tables in `public` (D92), `supabase/schema.spec.json` as the machine-readable §7 table
list both checks read, `scripts/verify-schema.mjs` behind `npm run db:verify`,
`.env.example` + gitignored `.env`. Identity is LinkedIn's own URN throughout: the four
entity tables are keyed on `urn`, `search_results` carries no unique key and stays
append-only, and `person_experience` holds full history with a `NULLS NOT DISTINCT`
upsert index (D93). Foreign keys exist only on `runs` and `searches`, never on a URN
column, because a person's employer is routinely known before that company is scraped
(D94); ids are `text` everywhere (D95). `budget_ledger` carries a table comment saying
it is a reporting mirror and that `runs/budget.ndjson` is the ledger of record (D11).
RLS is on with no policies, anon and authenticated are explicitly revoked, and the only
grants are to `service_role` (D91, corrected by D97).

Proven: 52 new offline tests (337/337 across the suite), typecheck clean — they pin the
table and column coverage against `schema.spec.json`, the urn keying, the append-only
property of `search_results`, the no-FK-on-URN rule, RLS on all 13 tables, grants going
to `service_role` and nothing else, the budget-mirror comment, and that every `create`
is `if not exists`; verified to bite by mutation (dropping one `if not exists`, one
`enable row level security`, and re-pointing a grant at `anon` failed 7 tests).
Operational: `npm run db:verify` ran green — `supabase db reset` applied the migration
to a dropped database, 13 tables with every §7 column present, the same file applied a
second time through psql with `ON_ERROR_STOP=1` without error and with an identical
catalog fingerprint, then a smoke transaction inserted and read back one row in each of
the 13 tables and rolled back, leaving `runs` empty (D96). Verified to bite: adding a
column to `schema.spec.json` that the migration does not create failed the run at step 3
naming `persons.nonexistent_column`.

Reviewed 2026-08-08 — one real bug, and it was in a property the tests claimed to prove.
The migration and `STATE.md` both said anon and authenticated reach nothing; the live
database granted both of them TRUNCATE, REFERENCES and TRIGGER on all 13 tables, and
`set role anon; truncate persons;` emptied the table. RLS does not cover TRUNCATE, and
the privileges came from Supabase's bootstrap default ACL for role `postgres`, which a
`grant` can only add to, never remove. The offline test regexed the migration text for
`to anon`, found nothing and passed — a privilege the file never wrote is invisible to a
test that reads the file (D97). Fixed: explicit `revoke all … from anon, authenticated`
on tables and sequences, plus `alter default privileges` so later migrations inherit the
revokes and pick up the `service_role` grants that `on all tables` could not give them.
Also: `raw_captures.run_id` loses `on delete cascade`, which deleted the index into the
raw archive while the gzipped bodies stayed on disk — a run delete with captures now
fails instead of orphaning files (D98); the migration header states it is never to be
edited once applied, since `if not exists` makes an added column a silent no-op that
`db:verify` cannot catch because it resets first (D99); and the "exactly one migration
file" assertion is gone, having been set to break on the next schema change.

Proven: 342/342 (5 new offline tests, typecheck clean). The grants claim moved into
`npm run db:verify`, which now queries `information_schema.role_table_grants`,
`has_table_privilege` for TRUNCATE specifically, and creates a probe table inside a
rolled-back transaction to prove future tables inherit the rules. Both new live checks
were verified to bite against the pre-fix migration: 78 leaked privileges at step 6, and
6 privileges on a newly created table at step 7. Full run green at 9 steps.

Task 12 — capability registry, CLI, preflight, and `health.check` (the M1 gate).
`src/cli/{types,registry,flags,budget,preflight,run,index}.ts` plus
`src/capabilities/health.check/`. A capability declares name, risk (`local` /
`read-cheap` / `read-metered`, D84), a zod args schema, `needsBrowser`/`needsAuth`, a cost
function over the three §8 spend kinds, and a `run` receiving a prepared context (run
context, args, flags, run-scoped budget, login state, and — only when it asked for one —
session, worker tab, network tap, human cursor, raw archive and its lease record).
`cap list` emits the §4.5 manifest (name, risk, summary, JSON-schema args, cost at
default args, plus the lease state and the exit-code table). The registry is built by
scanning `src/capabilities/`, so adding a capability is adding one directory and no CLI
wiring exists to forget (D81); the directory name must equal the capability name.
Universal flags §4.4 are handled once, for every capability: `--run-id`, `--dry-run`,
`--fields`, `--no-store`, `--budget` (D83), plus `--force-release` — D16's escape hatch,
which drops a wedged lease after naming its holder on the receipt, backed by a new
`forceReleaseLease()` in the lease module. Preflight runs §8's order (Chrome → CDP →
logged in → budget → lease → worker tab), determining login from the `li_at` cookie via
`Storage.getCookies` with zero LinkedIn requests (D80). Capabilities return a result, not
a receipt: the runner owns run_id, artifacts, measured cost, the exit code and teardown
(D82).

Proven: 51 new offline tests (424/424 across the suite), typecheck clean. Among them —
all seven failure classes thrown from a capability body reach the exit code their receipt
names *and* leave the lease free and the tab closed; an unclassified throw becomes
`CAPABILITY_FAILED`/exit 1 the same way; preflight stops at login with exit 4 and at
budget with exit 7, in both cases having opened no tab and taken no lease, and having
closed the session it did open; a failed login probe is exit 6, not exit 4; a lease held
by another live run refuses with exit 6 and survives the refusal; `--dry-run` opens no
session at all (the fake's `openSession` is never called), takes no lease, and reports a
budget that would refuse rather than pretending; `--budget` bites twice, refusing the
second page load of `--budget=1` with `BUDGET_INVOCATION_CAP` while `--budget=10000`
still cannot buy past the §8 hourly default; receipt cost is measured from real ledger
spends; the crash-cleanup thunk releases the tab and lease from mid-run; and
`checkLogin` never returns the cookie's value. The tests fake only Chrome — lease,
budget, run context, tap, cursor and archive are the real modules over temp paths — and
six compile-time assertions pin that `WorkerTab`, `BrowserSession`, `CdpClient` and
`RunContext` satisfy the structural types the runner consumes (verified to fail: breaking
`TabLike.screenshot` breaks the build). Two subprocess tests exercise the real CLI:
`cap list` returns the manifest, and `emitReceipt` exits 2/3/4/5/6/7/1 for the matching
failure class.

Live, M1 gate, against the automation Chrome (151.0.7922.76): `health.check` with Chrome
already up returned `ok`, exit 0, `launched: false` in 230ms; with the automation Chrome
killed first it returned `ok`, exit 0, `launched: true` in 1801ms. Both reported
`login.cookie: "present"` (expires 2027-08-07), `foreground.via: "already"` — so
`Target.activateTarget`, the only path that touches the operator's window, was never
reached — five events on disk (`cdp.send`, `nav.start`, `nav.done`, `render.wait`,
`cdp.send`), `summary.json` written, `runs/tab.lock` gone afterwards, and the automation
Chrome's page-target count back at 1, its starting value, with no leftover worker tab.
The cold start reached a working CDP endpoint in 1.8s on the unchanged D14 flag set, with
nothing blocking it. Also live: `cap list` returned the manifest; a wedged lease (a
recycled pid, D16's exact scenario) showed up in `cap list`, blocked a run with
`TAB_LEASE_HELD`/exit 6, and `--force-release` recovered it while naming
`run wedged-01 (pid 1, salesnav.leads.list)` on the receipt; an unknown argument exited 1
with `ARGS_INVALID`; an unknown capability exited 1 with `CAPABILITY_UNKNOWN` naming what
does exist.

Reviewed 2026-08-08 — one real bug and two partial-failure windows, all three now pinned
by tests verified to fail against the pre-fix code. `--budget` no longer doubles as a
ledger limit override (D83 revision): the override was measured against *every* run's
spend, so with 40 page loads already in the hour a run wanting 2 under `--budget=5` was
refused with "limit is 5, already at 40" — a limit nobody hit — which made the flag
unusable on any account that had done work that hour. The invocation cap alone remains,
and the effective ceiling is still min(cap, ledger limit). The teardown thunk is now
registered from inside preflight the moment anything is held, closing the window between
taking the lease and opening the worker tab in which a CDP-listener throw reached
`uncaughtException` with nothing to run — it left the wedged lease `--force-release`
exists for. And the browser bundle is published before `tap.start()` rather than after,
so a throw from attaching the tap's listener still reaches teardown holding the tap the
`catch` believed it had stopped. Proven: 427/427 (3 new), typecheck clean; live
`health.check --budget=5` returned ok / exit 0 with the lease released and the page-target
count back at 1.
Task 14 — store client, freshness, and the person write path. `src/core/store/
{constants,config,client,freshness,types,persons,index}.ts`: `readStoreConfig` /
`isStoreConfigured` / `requireStoreConfig` (a `.env` read through Node's own
`process.loadEnvFile`, no dependency added) so a `--skip-store` run can ask whether the
store exists without a missing `.env` ending it; `getStore()` memoizing one service-role
client per configuration; `parseDuration` / `isFresh` for the `--max-age` grammar (§7);
`upsertPerson` / `findPersonByUrn` / `findPersonByVanity` plus row types matching the
Task 13 migration. Failures map to one code per operator action — `STORE_UNAVAILABLE`
(transient, exit 6), `STORE_UNAUTHORIZED`, `STORE_SCHEMA_MISMATCH`, `STORE_WRITE_REJECTED`,
`STORE_{READ,WRITE}_FAILED` (all fatal, exit 1) — and carry **no string the database
wrote**, because Postgres puts the offending urn straight into its own error text and
receipts go to stdout (D100); the driver error survives as a non-enumerable `cause`.
`upsertPerson` is three ordered requests, not a transaction: experience upsert, then the
delete of rows this capture no longer lists, then the person row **last**. Two properties
fix that order — a failure between them leaves *extra* rows and never missing ones (D101),
and `last_seen` is written last because it is the record's claim to be complete and
`isFresh` reads it, so every failure leaves the person stale and the next run repairs it
rather than serving a half-written record for a whole `--max-age` window (D105).
`StoreWriteError.stored` names what actually landed, for the receipt's `partial.stored`. Omitted fields are left alone
and explicit nulls overwrite; `first_seen` is never sent, so a re-scrape cannot reset it
(D102). Nonsense durations are fatal rather than defaults, and a missing `last_seen` is
always stale (D103). The vanity lookup returns the newest match and reports how many
matched, since vanity is reassignable and not unique (D104).

Reviewed 2026-08-08 — one real bug, in the property the ordering doc claimed. The person
row was written first, so its `last_seen` bumped before the rows it describes existed: a
failed experience write left a record that was incomplete *and* fresh, which the next run
served instead of re-fetching, for up to `--max-age`. Worst case was a person never stored
before — zero experience rows, marked fresh, indistinguishable from someone who lists no
jobs. The person write moved last (D105); every failure now leaves the person stale or
absent, and `findPersonByUrn` reads absent as stale. Also: SQLSTATE class 22 (bad date,
overflow, string too long) now classifies `STORE_WRITE_REJECTED` alongside class 23 instead
of falling into the "error this build does not recognize" catch-all — same operator action,
so same code (D106). Also fixed: `getStore`'s memo key held a literal NUL byte, which made
git treat `client.ts` as a binary file; it is a `JSON.stringify` of the pair now.

Proven: 82 new tests (455/455 across the suite, three consecutive runs with no flake),
typecheck clean. 33 offline pin the duration grammar and every freshness edge; 25 offline
pin the configuration probe and each failure classification, including that a synthetic
23505 carrying a urn and a name leaks neither into the message nor the evidence nor
`JSON.stringify` of the error; 11 offline drive the **real** supabase-js against a stub
PostgREST on loopback — a hand-written fake of the query builder would let a request shape
PostgREST rejects pass as correct — pinning the conflict targets, uniform bulk-row keys,
the exact three-request order ending on `persons`, the no-experience-touched path,
byte-identical retries, the stored count at each failure point, and that neither a failed
experience write nor a failed delete sends anything to `persons` at all. 13 integration
tests run against the local stack and skip visibly without it (`[skip] store integration
tests — local Supabase is not reachable at …`): full suite is 455/455 with Supabase up and
442 passed / 13 skipped with it unreachable. Two of them are the review regression, driven
by a real 22007 rejection from Postgres (`started_on: "not-a-date"`): a never-stored person
stays absent and an already-stored one keeps its old `last_seen` and still reads stale. The
rest prove `last_seen` bumping with `first_seen` held, omitted-vs-null,
that the `nulls not distinct` natural key collapses a re-scraped all-nulls experience row
onto the same id through PostgREST's `on_conflict`, experience replacement keeping the
surviving row's id, `[]` clearing and omitted touching nothing, a retry converging to one
person and two experience rows, both lookups, and `vanityMatches: 2` on a shared handle.
Verified to bite by mutation: relaxing the freshness boundary to `<=` failed 1 test, adding
the driver's `details` to the evidence failed 2, dropping the omitted-experience guard
failed 9, dropping class 22 from the rejected branch failed 3 (one of them live), and
restoring the reviewed bug — bumping `last_seen` before the experience write — failed 11,
including both live regression tests.

Not done here, and not asked for by the task file: nothing yet writes `runs`,
`raw_captures`, `budget_ledger` or `parse_drift` — B3 (narrowing the budget ledger's
compaction window once Supabase mirrors it) therefore stays open. B4 records that two
concurrent `upsertPerson` calls for one person would delete each other's experience rows;
not reachable while runs are sequential under one tab lease, with the fix settled at
capture time.

## In progress
Task 15 — capture fixture. **Offline complete; one live run done and it found a real bug in
this task's own code, now fixed. A second live run is needed before this is Built.**

`src/capabilities/profile.capture/{url,patterns,read,constants,index}.ts` + README, and
`src/core/fixtures/{fieldmap,promote}.ts` + `scripts/promote-fixtures.ts`
(`npm run fixtures:promote`). Decisions D110–D114.

**Live run 1 — `01KZH9VVPKB5JEVEBW7G2JJ6F3`, 2026-08-08, against `/in/tankots/`.** Exit 0, no
challenge, 19.1s, 1 page load + 1 profile open recorded, 25 responses archived, 0 misses,
lease released. Everything the safety model promised held. What it did **not** get is the
profile: LinkedIn answered `readyState: "complete"` with `scrollHeight === innerHeight === 798`
— an empty SPA shell — so nothing scrolled, no lazily-loaded section fetched, and the one
profile endpoint that did answer (`voyagerIdentityDashProfiles`, 1,335 bytes) was a
urn-resolution call carrying `entityUrn` + `versionTag` and nothing else. The receipt said
`passes: 0` and warned about none of it. See D114.

Fixed here: `waitForLayout` polls the document height until it exceeds the viewport *and*
stops changing before anything is measured or scrolled, and a page that never lays out now
raises `PAGE_NOT_LAID_OUT` on the receipt. `--layout-timeout-ms` exposes the window.

Also learned live, and now recorded on `patterns.ts`' guesses: 6 of the 7 `specific` patterns
have never fired. The real profile page hits `/voyager/api/graphql` with
`queryId=voyagerIdentityDashProfiles.b5c27c04968c409fc0ed3546575b9b7a`, plus
`/voyager/api/me`, `/voyager/api/voyagerIdentityDashNotificationCards`,
`voyagerFeedDashGlobalNavs`, and messaging endpoints — 8 profile-carrying responses that no
specific pattern matched (`PATTERN_MISMATCH`). Per the task file this was reported, not
retried.

Proven: 607/607 tests pass offline (98 new), typecheck clean. Mutations verified to bite:
moving `drain()` out of the `finally` fails the halt-mid-capture archive test (staged with a
body still on the wire); halting on `unrecognized` response statuses fails the 403 warning
test; dropping the pre-navigation `profile_open` check fails the daily-limit refusal test;
re-tiering the broad net as specific fails three pattern tests; reverting `waitForLayout` to
a single measurement fails six, including the live regression staged verbatim
(1333×798, scrollHeight 798).

`fixtures/profile.get/` currently holds 9 promoted fixtures + `FIELD-MAP.md` from run 1.
They are **not sufficient for Task 16** — the field map finds the target's urn, and finds
name/headline/title only in the operator's own `/voyager/api/me`, the global nav and the
notification cards. No `location`, no `experience`, no `about`, no `skills` for the target.

## Next
Task 15's second live run, operator-supervised, with the layout fix in:
`cap profile.capture --url=https://www.linkedin.com/in/tankots/` (the profile_open is already
deduped for today, so it costs 1 page load and 0 profile opens), then
`npm run fixtures:promote -- --latest`. Task 16 is blocked until the field map names real
paths to the target's name, headline, location and experience.
