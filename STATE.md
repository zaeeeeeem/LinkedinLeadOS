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

Task 16 — DOM snapshot capture + profile fixture. **Built. One live run, exit 0, no
challenge. It produced the content fixture — and it falsified D123's identity half (D126).**

Code: `src/capabilities/profile.capture/{snapshot,identity}.ts` + wiring in `index.ts` and
`constants.ts`, `src/core/fixtures/dommap.ts`, the snapshot branch in
`src/core/fixtures/promote.ts`, `domSections` in `fieldmap.ts`. New dependency: `cheerio`
1.2.0 (operator-approved, D125). Decisions D124–D128.

**Live run `01KZJ5N27BPGY3AWGQ8FTB0C3J`, `/in/tankots/`.** Exit 0, 27.9s, no challenge, 1
page load, 0 profile opens (ref inside its 24h dedupe window), 26 responses archived, 0
misses, lease released. `main#workspace` measured `scrollHeight 2145 / scrollerHeight 746`,
laid out in 1550ms over 3 polls, scrolled 1399px in 2 passes — the full scrollable extent.

- **The snapshot works.** 875,285 bytes of `outerHTML` archived as
  `0026-438312a3d613045a.json.gz`, `status: 0`, `pattern: "dom-snapshot"`. The subject's
  container rendered: 833,736 chars, 30,562 chars of text, 23 sections. Promotion produced
  `fixtures/profile.get/438312a3d613045a-dom-snapshot.html` + `FIELD-MAP.md`, and
  `fixtures/profile.get/` is no longer empty for the first time.
- **The field map names real paths, verified against the fixture.** `headline` →
  `CEO at Wispr Flow | IOI Medalist | …`, `location` → `San Francisco, California, United
  States`, `experience` → the `ExperienceTopLevelSection` card holding 1,379 chars (6
  positions with titles, companies, dates and descriptions), plus `education`, `skills`,
  `about`, `full_name`, `current_company`, `vanity`. Every path resolves in the snapshot it
  was built from — pinned by a test that runs each one back through a selector.
- **`voyagerIdentityDashProfiles` returns the operator's own urn, not the subject's (D126).**
  The request settles it structurally, not just the response:
  `variables=(memberIdentity:ACoAAE1JGFIB…)` — the operator's own urn is the **input**. That
  call is the session resolving itself on every page; it could never have returned the
  prospect. The body's urn is byte-identical to the one in `/voyager/api/me`
  (`publicIdentifier: "zaeem-dev"`). D121 recorded that path as the subject's identity without
  ever comparing the two. Sweeping all 27 archived bodies: no non-operator profile urn outside
  the notifications card and the messaging thread list, both private endpoints, neither the
  subject. `IDENTITY_URN_IS_SESSION` fired on the receipt, which is the "not a silent zero"
  outcome the task file asked for. (That warning is gone as of the D130 follow-up below — it
  would have fired on every run forever. The check remains as a receipt field.)
- **The subject's identity is in the DOM (D127).** Every one of the 23 profile cards carries
  `componentkey="com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>"` namespaced by one
  id — `ACoAABJLCOAB…`, which is not the operator's — corroborated by
  `urn:li:member:306907360` on the top card's own Connect and Follow buttons. **Choosing the
  replacement identity source is the operator's call and is open**; `CLAUDE.md`'s D123 rule is
  annotated, not rewritten.
- Also measured, and it contradicts D123's stated reasoning: the page's only `aside` is
  *inside* `main#workspace`, so container position does not separate the subject from the
  "people also viewed" suggestions. The card name does (`SuggestedForYou`). The capture warns
  `SUBJECT_CONTAINER_NOT_SCOPED` for this, and it fired.

Two bugs in this task's own code were found by running it against the real page rather than
against a synthetic one, both now regression-tested: `member_urn` was collected unscoped and
returned 17 urns of which 16 were sidebar strangers (D119's trap inside the function meant to
expose it), and `location` matched `105,570 followers`, which satisfies the comma-shape rule
cleanly. A third was found by a test: a snapshot in which only one card rendered resolved a
profile id of `<id>Topcard`, which passes the id shape and would have produced a confidently
wrong urn for a real person. A fourth was found during verification, in the fix for the third:
a single card whose name `KNOWN_CARDS` does not list escaped the same way, resolving a urn
wrong by seventeen characters with an empty card list and no warning. A candidate id that
names no cards is now `null`; the regression test is verified to fail against the unguarded
version.

Proven: 704/704 offline, typecheck clean (78 new tests). Among them — `SNAPSHOT_EXPRESSION`
executed as real JavaScript against a stub document carrying the live probe's own numbers,
including the null-on-a-dead-context path; `captureDomSnapshot` against the real `RawArchive`
in temp dirs, with byte-identical read-back and the probe-failed / archive-failed split;
`findSubjectUrn` refusing a company urn, an A/B tracking urn and a sidebar suggestion at the
same path; the capability's not-rendered, not-scoped, snapshot-failed, identity-absent,
identity-urn-absent and identity-is-session branches each proven to warn rather than pass
quietly (the last three replaced by the D130 follow-up below), and a lost snapshot proven to
log `capture.miss` rather than a `capture.hit` with a
null filename; the promoter proven not to let the document response and the snapshot suppress
each other through their shared `NON_JSON_SHAPE` hash; and compile-time assertions that
`WorkerTab` and `RawArchive` satisfy the snapshot step's structural types and that the tap's
`Capture` satisfies the identity check's. Bounds (`MAX_HITS_PER_PROBE`, `MAX_LEAVES_PER_CARD`,
`MAX_SAMPLE_CHARS`, `IDENTITY_MAX_NODES`) are exceeded by tests rather than assumed roomy.

**Follow-up 2026-08-09, after D130 — the receipt now says what D130 decided (D130 amendment).**
D130 moved identity to the DOM and left the receipt describing the old arrangement. The three
Voyager identity warnings are gone: `IDENTITY_BODY_ABSENT` said a run without that body "has no
subject urn to key the profile on", which is now false, and `IDENTITY_URN_IS_SESSION` was going
to fire on **every capture forever** — per D126 that endpoint answers about the session on every
page, so it is a measurement, not a warning. The check is demoted to `data.identity.voyager`,
raising nothing.

In its place, three that can only fire when something is wrong: `SUBJECT_IDENTITY_UNRESOLVED`
(snapshot archived, no id resolved — the capture cannot be keyed and nothing may be stored),
`SUBJECT_IDENTITY_IS_SESSION` (the id is the operator's own; must never fire), and
`SUBJECT_CARD_NAMES_UNRECOGNISED` (the id boundary seen from the other side). New:
`checkDomIdentity` / `sessionUrnsOf` in `identity.ts`; `data.identity` now carries the DOM
outcome, never the id itself. `CLAUDE.md`'s network-tap bullet names the profile-reader
exception in its first sentence rather than ten lines below it.

Proven: 717/717 offline, typecheck clean (15 new). No live run — this changes what the receipt
says, not what the capture does. Two mutations verified to bite: re-adding the always-firing
warning fails the demotion test, and removing the cards-confirm-the-id guard fails the refusal
tests at both the `dommap` and the `checkDomIdentity` layer.

Task 17 — pure profile parser. `src/capabilities/profile.capture/{parse,fixture.test-helper}.ts`
turns an archived DOM snapshot into DOM-sourced wrappers around Task 14's `PersonInput` and
`ExperienceInput`, preserving descriptions and corroboration outside the explicit
`toPersonStoreInput` projection (D132). Identity comes only from the card-ref namespace and is
refused when the cards disagree, only `SuggestedForYou` is present, the id is the session's, or
the caller cannot supply the `/voyager/api/me` comparison set (D131); the subject-card and
card-name-boundary trust rule has one implementation shared by capture and parser (D133).
Missing fields carry typed exit-5 drift warnings; absent experience stays distinct from
observed-empty; output is bounded
at 100 positions with every dropped candidate reported. Numeric company paths are normalized to
`urn:li:fsd_company:<id>` before reaching either store field. Proven: 741/741 offline (24 new),
typecheck clean. The promoted fixture yields the required urn, name, headline, location and six
newest-first positions with company, dates and descriptions; all five populated company ids are
urn-shaped, and its 16 non-subject member urns are
absent from parser output. Four guards were mutation-verified: suggestion-only refusal, required
session comparison, missing-headline drift, and truncation visibility. No live run — this parser
is pure and Task 17 specifies fixture verification, so it spent zero page loads.

Budget spent 2026-08-09: 2 page loads, 0 profile opens beyond the earlier dedupe window.

Task 18 — bounded log queries. `src/core/log/queries.ts` (pure, offline): `listRuns` /
`queryWhy` / `queryErrors` / `queryDrift` read `runs/<id>/{run.json,summary.json,
events.ndjson}` directly with plain `fs` calls — never `RunContext.open({ runId })`, which
mutates the run it opens (D141). `src/capabilities/log.{runs,why,errors,drift}/` wrap them as
`risk: local` capabilities, `needsBrowser: false`, zero cost, named with dots rather than the
spec table's colons to satisfy Task 12's existing capability-name invariant (D140). `--since`
reuses Task 14's `parseDuration`; `log.runs` default `24h`, `log.drift` default `7d`, matching
spec §5's examples. Every result is capped (200 runs, 500 events, 200 drift groups) and marks
`truncated` rather than growing unbounded, per D3's fixed-size intent — truncation always
drops the least-relevant end (oldest runs/events, smallest drift counts), keeping the most
recently active. A run whose `run.json` cannot be attributed still contributes: `listRuns`
surfaces it as `status: "corrupt"` with no timestamp rather than being silently dropped by
the time filter it has no readable timestamp to be judged against, and `queryDrift` groups
its `parse.miss` events under capability `"(unknown)"` rather than losing them; an event
missing `detail.field` groups under field `"(unknown)"` for the same reason.

Proven: 38 new offline tests (534 passed / 13 skipped across the full suite without local
Supabase running — three consecutive clean runs), typecheck clean. 26 in `tests/log-queries.
test.ts` pin the pure query functions directly: ordered event readback, a truncated trailing
NDJSON line not erasing the complete events before it (both for `log:why` on one item and
`log:errors` on a whole run — proven against a run that failed outright and one that partly
succeeded, per the task's discipline gate), per-item filtering excluding other items'
events, warn/error-only filtering excluding info/debug, since-window filtering of run
summaries including the corrupt-`run.json` and corrupt-`summary.json` cases, drift grouping
by capability and field across multiple runs and multiple capabilities, and every truncation
bound proven by exceeding it (501 events, 201 runs, 201 drift groups) and checking which end
survived. 12 in `tests/log-capabilities.test.ts` drive the real `execute()` pipeline end to
end — registry lookup, args validation, `RunContext`, receipt assembly — with no fake browser
deps, since `needsBrowser: false` means `preflight` never opens a session or a lease; this is
the first place `execute()` and `core/log/queries.ts` compose, including the real edge case
of `log:runs` observing its own just-started invocation as `status: "incomplete"` because it
scans before it has written its own `summary.json`. Live via the real CLI subprocess: `cap
list` shows all four; `cap log.runs` returns `ok`/exit 0 and a second invocation lists the
first as `status: "ok"`; `cap log.why --run=<real-id> --item=<unmatched>` returns `ok`/exit 0
with an empty list; `cap log.why` missing `--item` returns `ARGS_INVALID`/exit 1; `cap
log.errors --run=<unknown>` returns `RUN_NOT_FOUND`/exit 1; `cap log.drift` returns `ok`/exit
0 with an empty group list against an archive with no `parse.miss` events yet (Task 16/17,
which will produce them, are not built).

Task 19 — `profile.get` end to end, the M3 gate. `src/capabilities/profile.get/` composes the
Task 14 freshness/store path, Task 16's existing `profile.capture.run`, and Task 17's pure DOM
snapshot parser. A fresh unambiguous vanity (or Sales Navigator urn) returns from Supabase with
zero page loads; a miss cold-loads and archives, refuses untrusted identity at exit 5 with the
snapshot path as evidence, stores person plus full experience, writes parser warnings as both
`parse.miss` events and `parse_drift` rows, and reports identity/content as the single
`dom-snapshot` source (D130). `--no-store` still archives, parses and logs. Store partial failures
reach `partial.stored` through Task 14's `StoreWriteError` count; primary rows precede the drift
mirror (D150), and vanity cache hits require exactly one match (D151). The README documents flags,
cost, failure mapping and SQL recipes.

Proven offline 2026-08-09: 797/797 tests pass, typecheck clean. Ten new `profile.get` tests cover
the freshness short-circuit, capture→parse→store composition, DOM-source receipt, non-fatal
warning persistence, unresolved/session identity and lost-snapshot exit-5 mappings, archive-only
`--no-store`, and a post-person drift failure reporting 2 stored rows. Four drift-writer tests
drive the real current `supabase-js` over stub PostgREST, including its 512-row bound; the runner
regression proves `StoreWriteError.stored` reaches the receipt.

Live M3 gate 2026-08-09, operator-supervised, `/in/tankots/`: run
`01KZK3ZNTMAKNK80R2YY39KSBQ` with the supported `--scrolls=12` returned exit 0 in 34.4s,
archived 26 network responses plus one DOM snapshot, missed 0, spent exactly 1 page load and 1
deduped profile open, and stored 1 person + 6 experience rows (7 total), with identity and content
both reported `dom-snapshot`. An independent Supabase query confirmed 1 person, 6 experience
rows, headline and location present; the ledger held the two expected spend records; 27 gzip
bodies and 27 sidecars were present; the lease was free. Immediate run
`01KZK41VAHD3905545T3HABFDT` returned from cache in 136ms with captured 0, page loads 0,
experience rows 6 and no budget record. The first live attempt used the capture's randomized
default of 3 scroll passes, archived truthfully, and surfaced `PARSE_FIELD_MISSING(experience)`;
it did not satisfy the gate, so the verified gate used the existing full-read flag rather than
changing Task 16's pacing/safety defaults.

Task 20 — per-capability daily budget sub-caps, and the launcher's empty-context reuse bug
(M4 unblocker). Decisions D160–D164; closes B5.

**Sub-caps (D153).** `src/core/budget/constants.ts` gains `CapabilitySubCaps`,
`DEFAULT_CAPABILITY_SUB_CAPS` (150 page loads / 25 search pages / 60 distinct profiles per
day), a `CAPABILITY_SUB_CAPS` table (`profile.capture` and `profile.get` at 200/0/90) and
`subCapsFor()`, which never returns uncapped — a capability absent from the table gets the
fallback (D162). `evaluate` in `ledger.ts` now checks the global §8 limits first and the
capability's own daily sub-cap second, counted over that capability's own ledger lines only;
both refuse with `BUDGET_EXCEEDED` / exit 7, and the evidence carries
`scope: "global" | "capability"` (D160). `capability` is required on `CheckInput`, so a
preflight cannot silently skip half the caps (D161); `RunBudget.check` binds it from the run.
`profile_open` dedupe is per scope (D163). No ledger format change — spend records already
carried `capability`.

**B5/D164.** `hasLiveTarget()` in `src/core/chrome/discovery.ts` (a plain `/json/list` GET,
never throws); `ensureChrome`'s reuse path accepts an endpoint only if it returns at least one
target, otherwise falls through to the unchanged launch path. Attach surface untouched.

Proven: 818/818 offline (45 new — 31→45 in `budget-ledger.test.ts`, 17→23 in
`chrome-discovery.test.ts`, 1 new compose test in `cli-registry.test.ts`), typecheck clean, no
LinkedIn or browser contact anywhere in them. Tests pin: the sub-cap trips exactly at its
boundary while the global limits stay open for other capabilities; the global limit still trips
and still says "global" when sub-caps are roomy; 6 racing spends against a sub-cap of 2 land
exactly 2, over 5 trials; an override above a sub-cap is ignored and one below is honoured; a
capability's own lines are the only ones its sub-cap counts. The **pre-Task-20 ledger** case runs
against `tests/fixtures-budget/pre-task-20-budget.ndjson` — the real M3 ledger copied verbatim
except that `ref` values are redacted (captured LinkedIn data is never committed) — and asserts it
parses, counts, evaluates per capability, and is appended to without its old records changing.
The compose test walks every capability the CLI actually loads and asserts its declared cost fits
inside its own sub-cap (`profile.get` spends under its own name despite delegating to
`profile.capture`, which is the omission this catches). Both new guards were verified to bite by
reverting them: the B5 revert fails 2 launcher tests, a too-small sub-cap fails the compose test.

Not verified live, and it does not need a live run: both changes are pure L0. The launcher guard's
real-Chrome behaviour is the operator's next cold start (see Next).

## In progress
Task 15 — capture fixture. **Offline complete. Two live runs done. Both found bugs in this
task's own code. Not Built: the captures do not contain the profile, and D116 is open.**

Code: `src/capabilities/profile.capture/{url,patterns,read,constants,index}.ts` + README,
`src/core/fixtures/{fieldmap,promote}.ts`, `scripts/promote-fixtures.ts`. Decisions D110–D116.

**Live run 1 — `01KZH9VVPKB5JEVEBW7G2JJ6F3`, `/in/tankots/`.** Exit 0, no challenge, 19.1s,
1 page load + 1 profile open, 25 responses archived, 0 misses, lease released. Every safety
property held. It did not capture the profile, and warned about none of it.

**Probe run 2 — `01KZHAHJ7504QSV57YC5RBZEV3`, same profile, tab visible to the operator.**
Run because run 1's diagnosis was an inference, not a check. It falsified that diagnosis.

What is now measured, not assumed:
- `document.documentElement.scrollHeight` is **798 and never changes** — `body` computes
  `overflow-y: hidden`. The page is nonetheless fully rendered: 875,004 chars of DOM, 23
  `main section`s, 30,963 chars of text. The real scroller is `main#workspace`,
  `overflow-y: scroll`, `scrollHeight 7348`, `clientHeight 746`. (D115)
- Scrolling that scroller rendered 14 more sections and produced **zero** new network
  responses.
- Across both runs, **no captured response carries the person's profile content.** The only
  profile endpoint that answers is `voyagerIdentityDashProfiles` at 1,335 bytes — a urn
  resolution (`entityUrn` + `versionTag`). The rest is app chrome and messaging. (D116)
- `outerHTML` contained `urn:li:fsd_profile` at 3.1s and not at 4.6s — consistent with the
  payload arriving in the **main document response** and being consumed on hydration.

Fixed here: `VIEWPORT_EXPRESSION` measures the tallest genuinely-scrollable element
(`overflow-y` auto/scroll/overlay, `clientHeight >= 200`) and falls back to the document, so
the scroll budget is `scrollHeight - scrollerHeight`; `waitForLayout` polls until that
settles; `PAGE_NOT_LAID_OUT` warns when it never does. D114's fix as first written would have
raised that warning on **every** LinkedIn capture — a false alarm on a rendered page.

Proven: 611/611 offline, typecheck clean (102 new tests). `VIEWPORT_EXPRESSION` is executed
as real JavaScript against a stub page carrying the probe's exact numbers (1333×798, document
798, `main#workspace` 7348/746, plus the clamped `overflow:hidden` `<p>`s that must not count
as scrollers). Mutations verified to bite: measuring the document instead of the scroller;
`drain()` out of the `finally`; halting on `unrecognized` response statuses; dropping the
pre-navigation `profile_open` check; re-tiering the broad net; reverting `waitForLayout` to a
single measurement.

`fixtures/profile.get/` is **empty**, and that is the corrected, honest state. It previously
held 9 fixtures + `FIELD-MAP.md`, none of them the subject: 339KB of the operator's own
message threads, 106KB of notification cards, 62KB of A/B config, and a field map offering
`$.data.elements[].lixTracking.urn` as `person_urn` with the operator's own member id as its
sample. Promotion now filters on the subject and excludes private endpoints (D118), and the
field map marks paths that resolve to the session's own identity (D119). Re-promoting the
same archive: 0 promoted, 14 private endpoints, 3 person-data-but-not-the-subject, 8 none.

`CLAUDE.md`'s "never from parsed HTML" rule is amended by D117: structured JSON embedded in
the initial document response is readable; markup, element text and CSS selectors are not.
That gives the D116 probe below a defined success condition.

Budget spent so far today: 2 page loads, 1 profile open (deduped by ref).

Task 16 (old numbering) — profile parser. **Blocker lifted 2026-08-09 by D123.** The parser
premise below was correct — no addressable *Voyager* content on a cold load — and the operator
resolved it: identity from the Voyager identity body, content from the rendered DOM, both on
the cold load already shipped. No SPA navigation. The tail is re-cut (new Task 16 = DOM
snapshot capture, Task 17 = parser, Task 19 = wire e2e). History below stands as the measured
record that forced the decision. Decisions D120–D123.

> The identity half of that decision was falsified by Task 16's own live run and replaced by
> D130 — identity comes from the DOM too. See the Task 16 entry above and `Task 21 (part 1 of 2) — **company surface probe: the instrument is built and tested; the live
run has not happened.** `src/capabilities/company.probe/` (url, patterns, surface, constants,
index, README), `src/core/fixtures/sweep.ts`, `scripts/sweep-sources.ts` (`npm run sweep`).
Decisions D170–D179.

`company.probe` loads `/company/<slug>/` and its `about` / `posts` / `people` / `jobs`
sub-pages as five cold loads, one page load each and **no profile_open**, archiving every
response body and one DOM snapshot per sub-page, with the challenge gate before and after
each sub-page and `tap.drain()` in a `finally` covering the whole loop. Its own daily
sub-cap is 12 page loads and **zero** search pages and profile opens (D170); the task's
six-load per-invocation ceiling is in code and not raisable by a flag.

What is genuinely new rather than reused: a per-sub-page **structural measurement** — which
element actually scrolls (D115 discipline, not `main#workspace` assumed), whether the page's
own tab links are real `a[href]`s or SPA routes, how much embedded `ld+json` /
`application/json` the document carries, and the `componentkey` namespace inventory — all of
it counts, tag names and dotted namespaces only, never a value (D176). And the **sweep**,
which works backwards from values the operator reads off the page to the source and path
that carries them (D173), with the three sources read strictly apart (D174).

Reused, not forked: `profile.capture`'s pacing constants, `readLikeAHuman`,
`captureDomSnapshot`, `summarizeCaptures`, `documentPattern`, `isLinkedInApiUrl`,
`sessionUrnsOf`. Two additive parameters were added to `profile.capture/patterns.ts`
(D178) and the scroller-selection rule was extracted so both surfaces ask it the same way
(D177) — behaviour unchanged, existing tests still green.

Proven: **927/927 offline (109 new), typecheck clean.** Mutations verified to bite: reading a
DOM snapshot's inline scripts as `embedded-json`; reading the document response's markup;
dropping the per-sub-page drain so a late body is attributed to the wrong tab. `surfaceExpression`
is executed as real JavaScript against a cheerio-parsed document, so the selectors are tested
against markup rather than against a stub that agrees with them.

**Reviewed 2026-08-09, high effort, before any live run — six findings, all fixed.** Two
would have corrupted the deliverable and are worth knowing about:

- **Per-sub-page capture attribution could put a row on the wrong tab** (D180). The tap was
  drained once per run but summarized once per sub-page, and a capture only lands after its
  archive write finishes. Run totals were always right; `subpages[].endpoints` — the probe's
  primary deliverable — was not. Now drained before each slice.
- **Every embedded-json path in the FIELD-MAP would have been wrong** (D174, amended).
  `:nth-of-type` counts same-tag siblings within one parent and the `[type=…]` predicate
  does not narrow it; the index was an accumulator across both types and all parents. Paths
  now come from `cssPath`, and a test feeds the emitted selector back through cheerio to
  prove it selects the script the value came from.

The other four: an unreachable `SUBPAGE_INCOMPLETE` warning promising a partial-failure
receipt the runner can never build (D181 — replaced by an `error` event, which is where a
halt is actually diagnosable); a `--samples` flag that rendered no samples and only swapped
in a false warning (D175, amended — deleted); an unknown `--subpages` value surfacing as
`COST_ESTIMATE_FAILED` rather than the documented code (D182 — now rejected by the args
schema, before a tab or the lease); and page-controlled strings (`url`, scroller `tag`/`id`,
namespace prefixes, the `tabs` list) reaching the receipt unbounded despite the module's own
contract.

**Numbering: D180–D182 were taken by the review round and D183–D184 by the live run, so
Task 22's reserved range is D185–D189.**

**First live run halted on a false positive, fixed (D183).** Run
`01KZKFR7RNRVA3FXPEJAKDQ30K` against `company/wisprflow` exited 2 `CHALLENGE_CAPTCHA` on
sub-page 1 of 5, on a normal logged-in page. Cause, from the archived snapshot, not the
receipt: LinkedIn's `pemberly.tracking.recaptcha.v3` experiment mounts Google's *invisible*
reCAPTCHA on company pages, and its hidden badge matches two of `CAPTCHA_SELECTORS`. The
probe now requires a matched widget to be shown (sized, on-screen, not
`display:none`/`visibility:hidden`); an unjudgeable widget still counts as shown. URL and
text signals untouched. The three archived profile snapshots carry zero recaptcha
references, which is why M1–M3 never met it.

**Live run done, and the surface is fully network-sourced (D184).** Run
`01KZKGD683T76H70YA4DMRCRZH` — company/wisprflow, 5 sub-pages, exit 0, 5 page loads,
0 profile opens, 5 DOM snapshots, 274 archived files, `PATTERN_MISMATCH` × 17 as expected
on a first probe. Verified from `runs/<id>/raw` and `runs/budget.ndjson`, not the receipt.

The first sweep called nine fields DOM-only and printed the `[DECISION NEEDED]`. **It was
wrong.** LinkedIn's server-rendered JSON is in Big Pipe data islands — `<code
id="bpr-guid-N">`, entity-escaped — and neither `embeddedJsonOf` nor the probe's `embedded`
measurement knew that carrier existed, so both reported zero embedded JSON on documents
holding ~11,300 labeled leaves. Both now read the islands, id-anchored so a rendered
`<code>` block is never laundered into the labeled-field source. **Verdict: no DOM
exception is needed for the company surface.** The four rows still flagged are rendered
composites whose structured constituents are in the same embedded JSON (see D184's table).

**Task 22 is unblocked.** Fixtures at `fixtures/company.get/`, map at
`docs/capabilities/company-surface-field-map.md`.

Now: **938/938 offline, typecheck clean.**

**Not built, and blocked on the live run:** fixtures, `FIELD-MAP.md`, the pinning tests, the
company identity verdict, and the source verdicts Tasks 22–25 are waiting on. Per D152 none
of it may be written from an assumption. **Spend so far: 0 of 6 budgeted page loads.**

## Next`.

**D116 probe — run `01KZJ09FEEYGY8WYDD3RQA0BH2`, `/in/tankots/`.** Exit 0, no challenge,
29.9s, 1 page load, **0 profile opens** (the ref was inside its 24h dedupe window), 26
responses archived, 0 misses, lease released. `documentPattern` worked: the navigation
response was captured, 200, 1,004,191 bytes, `profile_ish: true`.

**What it settled (D121).** The document *does* carry the subject's headline, location,
current company and name — inside `window.__como_rehydration__`, a React Server Components
flight stream (174 chunks, 376 rows, 38,419 nodes, depth 75). But none of it is addressed by
a field name. The headline sits at `$[162].value[3].textProps.children[0]`; a **stranger's**
headline from the "people also viewed" sidebar sits at `$[169].value[3]` in a node with the
same keys and the same shape. Nothing marks which is the subject except flight-row order.
There is no `headline` key, no `positions` array, and no subject urn in the document at all —
the only person urns in it are the operator's own, in A/B tracking (D119's trap, found again).
Reading it would be element text at a hardcoded position, which is exactly what D117 kept
forbidden when it permitted embedded JSON.

**What is solved:** identity. `voyagerIdentityDashProfiles` returns the subject's urn
(`identityDashProfilesByMemberIdentity["*elements"][0]`) from a real Voyager body on a
`specific` pattern. Content is not solved.

Also shipped in this commit, offline and tested: `documentPattern`, and a fix to
`summarizeCaptures`, which read "which patterns are specific" from the module constant
instead of the list it was passed — so the document capture counted as `unpredicted` and
raised `PATTERN_MISMATCH` on the very receipt the probe existed to read (D120).

`fixtures/profile.get/` is still **empty**, and still honestly so. A diagnostic
`--all` promotion of this run promoted 8 bodies with **subject_match: 0** — including the
operator's own `/voyager/api/me` — and was reverted; the document body itself is not JSON, so
promotion skips it as `not_json`.

Proven: 626/626 offline (15 new), typecheck clean. The new tests pin the document pattern's
matching (trailing slash, query, fragment, subdomain; not another profile, not a sub-page, not
the API calls, not a non-LinkedIn host), that an unparseable url returns false instead of
throwing inside the tap's listener, and that a run-time `specific` pattern is not counted as
unpredicted — that last one fails against the pre-fix `summarizeCaptures`.

Task 26 — person-activity + post surface probe. **Offline half built; the live probe has
NOT run, so this task is not complete and Tasks 27–29 stay blocked (D229).**

Code: `src/capabilities/activity.capture/{url,patterns,constants,index}.ts` + README,
`src/core/fixtures/{timeshape,activity-probes,activitymap}.ts`, plus additive extensions to
`profile.capture/{patterns,read}.ts`, `core/fixtures/{fieldmap,promote}.ts`,
`core/budget/constants.ts` and `scripts/promote-fixtures.ts`.
Contract doc: `docs/capabilities/activity.capture.md`. Decisions D220–D229.

`activity.capture` opens **one** page of the family — `/in/<vanity>/recent-activity/`
`all|shares|posts|comments|reactions/`, or a `/feed/update/urn:li:activity:…` or `/posts/…`
permalink — through the normal runner: lease, ledger, both challenge gates, raw-first
archive with `finally { drain() }`, DOM snapshot. It reuses `profile.capture`'s reader,
scroller, snapshot and `sessionUrnsOf` rather than forking them. It parses nothing.

What is deliberately its own, each with a decision behind it: a url module that does **not**
collapse `/recent-activity/…` onto the profile the way `normalizeProfileUrl` does on
purpose, and refuses an unmeasured tab rather than guessing (D220–D223); a relevance
predicate that is not `isProfileIsh`, because every post names its author and the profile
predicate would make the pattern-vs-reality answer identical on every run (D220); a
`profile_open` ref byte-identical to `profile.capture`'s, so a profile read and an activity
read of one person on one day are one distinct person (D223); and no `profile_open` at all
for a permalink, which opens nobody's profile (D222).

Three measurement instruments, all pure and offline, all shape-based rather than name-based
so they report what a page contains instead of confirming what someone expected (D225):
`timeshape.ts` classifies a value as epoch-ms / epoch-s / ISO-8601 / relative; `ACTIVITY_PROBES`
locates post urn, author urn, text, counts and timestamps in a JSON body — and `FieldProbe`
gained a `number` matcher, without which a body full of `createdAt: 1754697600000` reports as
carrying no timestamp at all (D224); `activitymap.ts` reports, from a DOM snapshot, every
attribute carrying a `urn:li:` (candidate post-card markers, whatever they are called), every
leaf whose text reads as a time, and what each time binds to.

`VIEWPORT_EXPRESSION` now also **describes** the element it measured and every candidate,
capped and with the true total (D227). It already picked the tallest scrollable element
rather than the document (D115), but a height alone cannot say which container it came from,
so a surface with two nested scrollers could report a settled layout while scrolling the
wrong box.

Promotion is surface-selected: `--surface=activity` moves relevance, probes and DOM map
together, because promoting an activity run under the profile settings drops every body that
carries posts and no person urn — exactly the body a post parser needs (D226).

Proven: **927/927 offline (124 new), typecheck clean.** Mutations verified to bite: reverting
the relevance predicate to `isProfileIsh` (4 failures); charging a permalink a `profile_open`
(1); dropping the `SESSION_IDENTITY_UNAVAILABLE` warning (1); removing the scroller
descriptor (4). Pinned by test, not by prose: the `profile_open` ref *agrees with*
`normalizeProfileUrl` rather than matching a literal; every bound (`MAX_URNS_PER_FAMILY`,
`MAX_URN_ATTRIBUTES`, `MAX_TIME_LEAVES`, `MAX_SCROLLER_CANDIDATES`) is exceeded by a test
that also asserts the truncation flag; the receipt carries no urn, name, post text or query
string; the lease is released on the challenge, the transient and the bad-url paths; a body
still on the wire when the run halts is still archived. A compile-time block asserts the
three `profile.capture` modules and the activity map compose — this capability is the first
place they meet (review shape 4).

**Reviewed the same day; two real defects found, both in scroll accounting, both landing on
exactly the surface this probe exists to measure. Fixed before any live run (D228 revised,
D300).**

- *The scroll budget was measured once, before scrolling.* A feed renders as it is read, so
  that number was the height the page had before it had any cards: the reader stopped at the
  first screenful-set and never issued whatever request the rest of the feed would trigger.
  The archive would have been a prefix **by construction**, and the fixture Tasks 27–29
  receive would never have shown how the feed pages. Now re-measured after every pass.
- *The "not exhausted" warning compared distance travelled, not position.* `scrolled` sums
  absolute movement and the reader goes back up a quarter of the time, so a 900px page read
  from position 600 looked finished. Now `travelled` vs the last measured extent, via the
  pure `feedShortfall` — the capability cannot inject an rng, so the property is pinned
  where the sequence can be chosen instead of rolled.

Also fixed: the urn inventory summed distinct counts per body, so one author across ten feed
bodies counted ten; truncation of the urn sets was dropped from the receipt; a `/posts/`
permalink watched only the spelling it was given, though LinkedIn 302s it to `/feed/update/`
— which would have captured no document at all on the one surface where a server-rendered
payload is most likely (D300); `activitymap`'s per-family sets were unbounded; a no-op branch
in the promote script claimed a protection that never ran.

**The original tests passed against all of it**, which is the finding worth keeping: the fake
cursor never scrolled backwards, and the growing-page case did not exist. Each fix is now
mutation-verified — reverting it fails a named test — and the flaky assertion that turned up
while checking (a two-pass read can legitimately end back at position 0) is gone. Suite run
eight times clean.

**Spend: 0 of the 5 budgeted page loads.** No live run happened; the operator supervises
every live run.

**`fixtures/` holds nothing for this surface, there is no `FIELD-MAP.md`, and no source
verdict is written — honestly so (D229).** Tasks 27–29 carry the blocked note and the exact
unblock sequence.

---

## The live probe Task 26 is waiting on (operator-supervised)

Task 26 is **not complete** until this runs. Budget: **max 5 page loads**; each command
below is one load. Prefer a target already in the store so the freshness cache and the
`profile_open` dedupe amortise, and **never the operator's own profile** — its captures are
the session-identity trap the parser must refuse (D119/D126).

Run them one at a time, reading the receipt between each. Stop on any non-zero exit; exit 2
is a challenge and means stop entirely, not retry.

```
# 1-3 — the three person surfaces of one chosen prospect
npm run cap -- activity.capture --url='https://www.linkedin.com/in/<vanity>/recent-activity/all/'
npm run cap -- activity.capture --url='https://www.linkedin.com/in/<vanity>/recent-activity/comments/'
npm run cap -- activity.capture --url='https://www.linkedin.com/in/<vanity>/recent-activity/reactions/'

# 4 — one post permalink, ideally one seen on the feed above (spends no profile_open)
npm run cap -- activity.capture --url='https://www.linkedin.com/feed/update/urn:li:activity:<id>/'

# 5 — spare

# then, per run id, promote (no LinkedIn traffic; safe to re-run)
npm run fixtures:promote -- --run=<runId> --capability=profile.posts    --surface=activity
npm run fixtures:promote -- --run=<runId> --capability=profile.activity --surface=activity
npm run fixtures:promote -- --run=<runId> --capability=post.get         --surface=activity
```

**Default flags on purpose** (M4 CONTEXT rule 5). If a surface needs `--scrolls=12` to
capture anything, the default is wrong and gets fixed with the pacing trade-off recorded —
the flag is not blessed.

**What to read on each receipt, in this order:**

1. `warnings` — `POSTED_AT_RELATIVE_ONLY` and `SESSION_IDENTITY_UNAVAILABLE` are the two
   that change what the next tasks may do. `FEED_NOT_EXHAUSTED` means the capture is a
   prefix, so its counts describe the scroll rather than the person.
2. `data.reading.viewport.scroller` / `scrollerCandidates` — **is the activity feed its own
   scroll container?** This is the measurement M4 CONTEXT rule 3 asks for. More than one
   candidate is worth recording either way.
3. `data.capture.patterns` and `unmatched_activity_ish` — a specific pattern with zero hits
   next to a non-zero unmatched count is the finding: the endpoint guess was wrong, and the
   body is on disk regardless.
4. `data.probe.body_session_urn_hits` and `dom.session_urns_present` — non-zero on the
   *actor* of a post would be D119 in a fourth place.
5. `data.probe.dom.urn_attributes` — whether a post card is bound to a post urn through an
   attribute at all. If not, the subject/stranger boundary on this surface has no DOM
   anchor and that is a finding in itself.

**Verify independently of the receipt** (M4 CONTEXT rule 6): list `runs/<runId>/raw/`,
read the ledger lines for `capability: "activity.capture"`, and confirm `runs/tab.lock` is
free afterwards. Do not take the receipt's word for any of it.

**Then, and only then:** fill the source verdict into Tasks 27–29, and if the content
proves DOM-only, decide whether to extend `CLAUDE.md`'s DOM-source exception to this
surface (D229, M4 CONTEXT rule 7). Until that decision lands in `DECISIONS.md`, Tasks 27–29
do not start.

## Next


M1–M3 are complete. **The M4 plan is written and approved** (`docs/plans/m4-l1-readers/`,
2026-08-09): the remaining eleven L1 readers across five page surfaces, probe-first (D152) with
per-capability daily sub-caps (D153). Fourteen task files (20–33): Task 20 (budget sub-caps +
launcher B5 fix) is the unblocker and runs first; then per surface a live probe task feeds
offline parser+store tasks and a live default-flags gate. Execution has not started — Task 20 is
the first to dispatch, on Opus, per the m1-m3 execution protocol (fresh subagent, TDD, Opus
reviewer after each). Read `docs/plans/m4-l1-readers/README.md` then `CONTEXT.md` before
dispatching.

**Task 20 is done. Task 21 is done, live-verified. Tasks 26 and 30's offline halves are
done and their live probes have run.**

## 2026-08-09 — three tasks unblocked at once, and one infrastructure bug behind all of them

Tasks 22, 27 and 31 each reported "my surface fixture does not exist". All three were
wrong in the same way and the cause was in none of them: `fixtures/` and `runs/` are
gitignored at the repo root, tasks execute in linked git worktrees, and both directories
were resolved against `process.cwd()`. Every worktree therefore had an empty fixture
library — and, worse, **its own budget ledger**, multiplying the section 8 daily caps by
the number of worktrees open (D301, fixed).

Landed on `plan-m4-l1-readers`, nothing merged from a task branch:

| commit | what |
|---|---|
| `0439bfb` | D301 — fixtures/runs/ledger anchored to the repo root via git worktree linkage |
| `69076c1` | D302 — a navigation settles on `interactive` when `complete` never arrives |
| `ba21df2` | a dead tab or socket fails the navigation wait at once, not 45s later under the wrong code |
| `576bb62` | `activity.capture` / `job.capture` were on the 150-load *reader* fallback; now probe-capped |
| `e64b1df` | D303 — `isLinkedInDataUrl`, a net wide enough to disprove the net |
| `afcecac` | D303/D304 recorded |

Worktrees `three` (Task 26) and `four` (Task 30) are rebased and merged up to all of it,
green, and carry the captcha fix `ea029aa` they were missing.

### Ready to start in parallel

- **Task 22 — `company.get`.** Fixture and field map were always on disk; only D301 was
  hiding them.
- **Task 27 — `profile.posts`.** `fixtures/profile.posts/` from run
  `01KZKKZZJ91XX4KX2Z3772QRHH`. Voyager JSON, no DOM exception. `posted_at` is derived
  from the activity urn (`Number(BigInt(id) >> 22n)`), verified against 11 rendered
  labels in the fixture.
- **Task 28 — `profile.activity`.** `fixtures/profile.activity/` from runs
  `01KZKM1E5AX4WJ91BKA8GRWSK4` and `01KZKM2QPPR35QSW0WSA134EZD`. Same verdict as 27.

### Blocked, each on one named thing

- **Task 31 — `job.get`:** needs the operator's DOM-source decision. The job surface has
  **no labeled-field source** — measured twice, D304. Recommendation in the task file.
- **Task 29 — `post.get`:** the `/feed/update/<urn>/` permalink drops the CDP socket
  ~2.5s in, twice. Needs one clean capture; try the `/posts/<slug>` spelling first.

Spend on 2026-08-09: 9 page loads (3 activity surfaces, 2 permalink attempts, 2 job
probes, 2 earlier company/activity runs), 1 distinct profile (`in:tankots`).


**The next action is a live, operator-supervised probe run** — Task 21 cannot finish without
it, and Tasks 22–25 stay blocked until it does. Nothing about the company surface has been
measured yet; every field's source is currently unknown, not assumed.

Run, with the operator watching and a company already linked from the stored M3 profile as
the target:

```
npm run cap -- company.probe --url=<company url>
```

Then, offline:

```
npm run fixtures:promote -- --run=<runId> --capability=company.get --subject=<vanity>
npm run sweep -- --run=<runId> --want-file=fixtures/company.get/wanted.json \
  --out=docs/capabilities/company-surface-field-map.md
```

`wanted.json` is the operator's ground truth read off the rendered page — `[{"field":
"name", "value": "…"}, …]` for each §7 column of `companies`, `company_posts`,
`company_people` and `jobs`. It is gitignored along with the rest of `fixtures/`.

Budget: 5 page loads for the probe (6 allowed), 0 profile opens. Expect
`PATTERN_MISMATCH` — on a first probe of an unmeasured surface that is the reading the
patterns exist to produce, not an alarm.

**Operator check on the next real Chrome use:** the launcher's reuse decision changed. A normal
run should behave exactly as before (`launched: false` against the Chrome already on 9223). The
new path only shows up if that Chrome ever has all its windows closed — it will now relaunch
instead of attaching to a browser that fails every command. Nothing else in this commit touches
the browser.

**Leftover:** none. The live M3 gate and cache check both exited 0, `runs/tab.lock` is absent,
and the automation Chrome remains available on port 9223.
Task 27 — `profile.posts` (in progress, checkpoint 1, 2026-08-09). Governing docs, the
Task 26 field map, shared fixtures, `profile.get` composition, activity capture, store and
budget surfaces have been read. The fixture is correctly resolved from the main checkout
through `repoRoot()` (D301); parser tests are the next checkpoint. No live page was loaded.

Task 27 — `profile.posts` (in progress, checkpoint 2, 2026-08-09). Offline parser and
composition are implemented TDD against the promoted 611,559-byte Voyager fixture. The
shared post projection/write path is factored for person/company owners; author exclusion,
snowflake time, inclusive since, subject refusal and limit-to-scroll/examination bounds are
pinned. Full-suite and type verification are next. No live page was loaded.

Task 27 — `profile.posts` (implementation complete; live gate pending operator, checkpoint 3,
2026-08-09). Delivered README, pure Voyager parser, exact subject/stranger boundary,
snowflake `posted_at`, inclusive `--since`, work-bounded `--limit`, delegated raw-first capture,
and the shared person/company post projection with batch `person_posts` upsert. Mutation checks
proved the repost equality, since comparator and limit slice are each killed by their named
test. Typecheck is clean; the full offline suite is 1,084 passed / 13 skipped, with the 13 store
integration checks skipped because Supabase env vars are absent. Stopped before the metered live
gate as instructed; no LinkedIn page was loaded.

Task 27 — `profile.posts` (review fixes complete; live gate pending operator, checkpoint 4,
2026-08-09). Fixed the first-capture cursor boundary and joined social counts through
`*socialDetail`, eliminating null reaction/comment counts on all 14 retained fixture rows.
Also fixed backend-urn fallback, per-row malformed-snowflake degradation, null entity-map keys,
post-permalink preflight refusal, since-filter receipt accounting, and post-table constants.
Six new regressions bring the focused suite to 16 passing; typecheck is clean. Full-suite
verification is next. No LinkedIn page was loaded.

Task 27 — `profile.posts` (review fixes verified; live gate pending operator, checkpoint 5,
2026-08-09). Full offline suite passes: 1,090 tests passed and 13 store-integration tests
skipped because Supabase environment variables are absent. Typecheck and `git diff --check`
are clean. The operator-supervised metered live gate remains the only pending acceptance step;
no LinkedIn page was loaded.

Task 28 — `profile.activity` (in progress, checkpoint 1, 2026-08-09). Governing docs,
Task 26's promoted comments/reactions field map, Task 27's parser/composition, and the shared
capture, budget, root and post projection modules have been read. The actor-vs-target boundary
and archive-only storage contract are recorded in D240-D242; parser tests are next. No live
page was loaded.

Task 28 — `profile.activity` (in progress, checkpoint 2, 2026-08-09). The pure comments and
reactions parser, shared Task 27 post projection, two-tab capture composition, fixed-size
archive-only receipt and README are implemented TDD. The focused suite passes 15 tests and
typecheck is clean; the two required mutation checks and full offline suite are next. No live
page was loaded.

Task 28 — `profile.activity` (implementation complete; live gate pending operator, checkpoint 3,
2026-08-09). Delivered the pure Voyager comments/reactions parser and archive-only two-tab
reader. Named mutation tests kill actor/target conflation and removal of session-actor exclusion.
The full offline suite passes 1,098 tests with 13 store-integration skips; typecheck, registry
discovery and diff hygiene are clean. No LinkedIn page was loaded.

Task 28 — `profile.activity` (review fixes in progress, checkpoint 4, 2026-08-09). Tightened
per-tab envelope selection, added cross-body unique counting, anchored actor resolution to the
subject across all header attributes, classified null actors as unresolved, and made both feed
parsers tolerate non-JSON captures. The focused suite passes 22 tests and typecheck is clean;
mutation checks and the full offline suite are next. No LinkedIn page was loaded.

Task 28 — `profile.activity` (review fixes verified; live gate pending operator, checkpoint 5,
2026-08-09). Exact per-tab envelopes and unique cross-body counts now protect the receipt;
subject-anchored header scanning and safe non-JSON parsing protect identity and capture drift.
The two review mutations are killed by named tests. The full offline suite passes 1,104 tests
with 13 store-integration skips; typecheck, registry discovery and diff hygiene are clean. No
LinkedIn page was loaded.

Task 28 — `profile.activity` (storage decision landed, 2026-08-09). The operator chose
archive-only: no `person_activity` table, no migration, no write path (D306, taking the
next free number because D240–D249 are spent). The capability is offline-complete —
1,104 tests passed, 13 store integration tests skipped for absent Supabase env vars,
typecheck clean. Only the two-load supervised live gate remains.

Task 27 — `profile.posts` (**live gate passed**, 2026-08-09). Run `01KZKVER7T71P0GYQA9NHZ4RE6`
against `https://www.linkedin.com/in/tankots/recent-activity/all/`: exit 0, 1 page load,
20 examined / 14 usable / 6 skipped, 14 rows upserted into `person_posts`. Verified by query —
all 14 rows carry non-null `reactions`, `comments` and `text`, spanning 2026-06-12 to
2026-08-07. That is the review round's null-counts defect proven fixed against live data.
Warnings were the expected three: `FEED_NOT_EXHAUSTED` (limit 20, zero scroll passes),
`PATTERN_MISMATCH` (3), and `SESSION_IDENTITY_UNAVAILABLE` — no `/voyager/api/me` body was
captured on this load, so the D119 trap is **unmeasured on this run**. Task 27 is complete.

Task 28 — `profile.activity` (**live gate passed on the second attempt**, 2026-08-09).
The first attempt, run `01KZKVHN75FJCKMNRQ23DC1QPR`, failed fatally with
`TAP_DUPLICATE_PATTERN` after spending one page load: the reactions capture could not
register watches the comments capture had left on the shared tap. Fixed under D307. Re-run
`01KZKVQN8BDFD5J2558NVF63VR`: exit 0, 2 page loads, 40 examined / 40 usable / 0 skipped,
**20 comments and 20 reactions**. Independently counted the archived bodies' `*elements`
arrays — 20 and 20, matching the receipt exactly, which is this task's stated acceptance
criterion. Nothing was written to the database, per D306. `POSTED_AT_RELATIVE_ONLY` fired on
the comments tab as Task 26 predicted, and `SESSION_IDENTITY_UNAVAILABLE` fired on both tabs
for the same reason as Task 27. Task 28 is complete.

**Open, carried into Task 29:** `SESSION_IDENTITY_UNAVAILABLE` fired on all three activity
loads. The session-identity trap (D119) is real code and is exercised offline, but no live
activity run has yet captured a `/voyager/api/me` body to check against, so it remains
unproven live on this surface.

Task 29 — `post.get` (**still blocked**, 2026-08-09). The permalink probe named in the task
file was run and failed: same post, LinkedIn's own `/posts/` spelling, identical
`CDP_SOCKET_ERROR` at 2.4s (run `01KZKVYA4JH3TXN1W26CN3RY4A`). Three failures across two URL
spellings. Two hypotheses are now disproven and written up in D308 — the URL spelling, and
CDP frame size (100 MB messages round-trip fine). The failure is localised to fetching the
document's *body*; Chrome survives every attempt. The one untested variable is a fresh Chrome
with no other tabs, which needs the operator because it discards their open tabs.

## 2026-08-09 — CDP transport fix (branch `fix-cdp-transport`, off `main`)

Out of band with the M4 task numbering, because it is core transport, not a capability.

**Built.** `CdpClient` opens its socket with the `ws` package and `skipUTF8Validation: true`
(plus an explicit 512 MB `maxPayload`, no permessage-deflate). `ws` is now a runtime
dependency. Fixes D309: Node's global `WebSocket` killed the *connection* on any inbound text
frame that was not valid UTF-8, which is how `Network.getResponseBody` relays document bodies —
so any capability fetching such a body lost its CDP socket mid-run, not just Task 29.

Bodies that decode lossily are tagged `lossyUtf8` on the capture, the archive sidecar, and the
`capture.hit` event, because the decoded string substitutes U+FFFD for the bad bytes and D2's
"raw first" would otherwise become quietly false (D310).

Blast radius: `src/core/cdp/client.ts` only — it holds the sole `new WebSocket(...)`. The tap,
tab and session take a `CdpClient` and were untouched.

Proven offline: 788/788 pass on this branch, typecheck clean. Two new tests reproduce D309 in
the suite — a reply frame carrying `0xED 0xA0 0x80` or `0xC3 0x28` killed the client before the
swap and dispatches normally after it. The socket-error test now drives `ws` instead of
monkeypatching the global, and asserts the cause survives as `evidence`.

**Not done: the live re-probe.** No LinkedIn contact was made. Task 29's permalink has not been
re-attempted, so Task 29 is not yet unblocked — that needs one operator-supervised page load.

**Note on branch state.** This sits on `main`, which is behind the M4 task branches
(`task-22`…`task-30`, `plan-m4-l1-readers`). Each of those carries the same latent transport bug
and should be rebased onto this before its next live run.
