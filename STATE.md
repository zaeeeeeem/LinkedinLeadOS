# STATE

## In progress — Task 39 `salesnav.leads.list` end to end (2026-08-11)

Research and offline implementation checkpoints are complete; both supervised live gates remain. The
fixture-backed baseline is **1679 passing / 14 skipped**, exactly the handoff count, and
`fixtures/salesnav.probe/` contains both pinned leads pages. The chosen composition is recorded
in `docs/plans/m5-l2-salesnav/tasks/task-39-approach.md`: the tap returns exact archive ids to
`runPaged`, body offsets and `sessionId` prove arrival, and final storage re-reads every page
the archive-backed checkpoint proves so prior/adopted pages converge after a kill.

No shared pager edit: Task 37 currently has uncommitted changes in
`src/capabilities/salesnav.probe/pager.ts`; Task 39 consumes its stable export only.

**[BUG] fixed before live use (D383):** the default budget ledger already resolves all linked
worktrees to the main repository, but the tab lease used each process's current directory.
Parallel Task 37/39 processes could therefore hold different lock files while driving the
same dedicated Chrome. The lease now uses the shared run root too; a test pins the two paths
to the same parent.

The capability now runs through the lease, budget, tap, archive-backed paged loop and store.
It proves arrivals from the named lead-search body's offset, returns exact tap archive ids,
reprojects every archive-proved page on resume, and writes `searches` / `search_results`
without an entity writer. Typecheck is clean and the final full suite reports
**1710 passing / 0 skipped** with local Supabase enabled. Six deliberate mutations went red:
using a worktree-local lease, removing exact archive-id naming, replacing the merged
challenge checkpoint, collapsing page-bounded store writes, bypassing `--no-store`, and
downgrading paging parse drift.

**Local-data incident:** I invoked `npm run db:verify` without first inspecting that script;
it runs `supabase db reset`. Migrations and the verification checks completed, but there is
no seed file and the local tables now contain 0 runs, 0 persons, 0 companies, 0 searches and
0 search results. Any unseeded local rows that existed before the reset are not recoverable
from the database. No live LinkedIn run caused this reset.

**Spend: 0 / 8 search pages, 0 / 8 page loads.** No LinkedIn contact in this checkpoint.
The shared ledger currently reports 8 global search pages and 25 global page loads in the
rolling day, while `salesnav.leads.list` itself remains 0 / 20 for both kinds. The corrected
shared tab lease is free. Local pre-live entity/search tables are empty after the reset above.

### Live gate A — preflight attempt stopped before contact (2026-08-11)

Operator-approved run `01KZQEWSGRJ7D8ED2WGMWHBFB3` exited 6 in 33 ms at the login probe:
Chrome rejected `Storage.getCookies` with `Browser context management is not supported`.
No worker tab, navigation or click followed. Independent ledger inspection proves **0 page
loads / 0 search pages** for the run; the shared lease is free; persons, companies, searches
and search results remain at their identical pre-run 0-row digests. A subsequent browser-only
diagnostic found 5 live targets and the same browser command succeeded, so this is currently
a non-reproducing transient rather than the persistent zero-window state in D122.

**Gate spend remains 0 / 8 search pages, 0 / 8 page loads.** A retry requires a new operator
approval because every live invocation is separately supervised.

### Live gate A — passed on default flags (2026-08-11)

The approved retry `01KZQFCFMVYKAC082JXDRVCAN3` exited 0 after 2 pages and 90,311 ms. It
inspected and stored 49 result positions: page 1 has positions 1–24 and page 2 has positions
1–25, all under the run's `search_id` / `run_ref`, with 0 duplicate provenance keys. One
trusted click reached page 2: `Next`, one reveal pass (D384). The receipt carried no returned
name, headline or profile url.

Independent evidence, not the receipt: the checkpoint has 2 distinct completed pages and one
named archive id for each; both gzip bodies exist. The append-only ledger has 2 page-load and
2 search-page units for the run. Supabase has one `sn_leads` search, 49 search results, and an
exit-0 run parent reporting 2/2. Persons and companies remain at the same empty-table digest
recorded before the run; the shared lease is free. Thus the three spend/proof numbers are
equal: **2 ledger search pages = 2 proved pages = 2 named bodies on disk**.

One non-halting `RESPONSE_STATUS_UNRECOGNIZED` warning named a bare-root response; neither
challenge gate classified it as an interstitial. Gate A otherwise met every acceptance check.

**Gate spend: 2 / 8 search pages, 2 / 8 page loads.** Gate B (kill and resume) remains and
requires separate operator approval before its initial live invocation.

### Gate B pre-kill review found and fixed the missing browser half of resume (2026-08-11)

Review shape 1 at the actual kill point found a blocker before spending: the paged checkpoint
preserved page 1's bytes/session, but every new CLI process created a blank worker tab. A
resume could therefore neither press Next from the proved page nor reload page 1 without
violating the no-reload/no-respend gate. D385 now persists the run-owned worker target before
work, reattaches that exact surviving target after a hard kill, clears it after normal
teardown, and refuses if Chrome no longer has it. It never searches or adopts the operator's
other tabs. Typecheck and the full **1715-test** suite pass; both handoff and missing-target
mutations go red.

No gate-B process has started and **gate spend remains 2 / 8 search pages, 2 / 8 page loads**.
The operator's approval for the initial gate-B invocation is recorded; full-suite verification
and commit precede that live run.

### Gate B — second preflight-only stop, waiting on Task 37 (2026-08-11)

The approved attempt `01KZQG24YMTJ8G55RY8E2TYTR0` exited 6 at `Storage.getCookies` after
49 ms, before a checkpoint, navigation, click or kill point. Direct ledger inspection proves
0/0 for that run. Persons/companies retain their baseline digests; the database still has only
gate A's one search and 49 result rows.

Process inspection then found Task 37 actively driving the same automation Chrome (three
process layers for one saved-search invocation). Its already-running branch predates D383 and
therefore holds a worktree-local lease our corrected shared lock cannot see. That explains why
the shared lease appeared free while Chrome was not actually exclusive. After a 45-second
backoff Task 37 was still active, so Task 39 stopped rather than force or race it.

**Gate spend remains 2 / 8 search pages, 2 / 8 page loads.** Gate B has not reached LinkedIn;
another live invocation requires fresh operator approval after Task 37 is idle.

## Task 36 reviewed, amended, unblocked and completed (2026-08-11)

Task 35 was already merged to `main` (`acde15b`) on 2026-08-10; only Task 36 was ever
outstanding. Reviewed against its task file and `CONTEXT.md`: three changes and one
renumber, plus three defects fixed (D403 in Task 35's core, D404 and D407 in the probe).
**Tests: 1664 pass, typecheck clean.** Three supervised live runs, 5 page loads / 5 search
pages, all exit 0 or a clean refusal.

**The operator granted the pagination click (D400).** Next and previous, inside a pager,
located by accessible name, resolved-or-refused, trusted `HumanCursor` click, wheel to
reveal, spent and dwelt exactly like a navigated page, and **arrival read from the body's
`paging.start` rather than from the button** — a re-render advances the label without
changing a row. It is the only click in the toolkit and `CLAUDE.md` now says so as a
non-negotiable rule; M5 `CONTEXT.md` rule 4 was rewritten to match. Implemented in
`src/capabilities/salesnav.probe/pager.ts`; `leads2` now reaches page 2 by clicking next.
D352's `[DECISION NEEDED]` is closed and **Tasks 39/40 are unblocked**.

**[BUG] fixed — the source verdict could be satisfied by markup.** `sourceVerdict` and the
`ROWS_DOM_ONLY` warning counted *any* `isSalesNavIsh` capture, and a surface's own document
response is `isSalesNavIsh` the moment it server-renders one `/sales/lead/` link. A build
that rendered its rows into HTML would therefore have been reported as "rows in a labeled
body" — silently skipping the `[DECISION NEEDED]` that grows CLAUDE.md's DOM exception list,
which is the unsafe direction. Both now read `salesnav_ish_api`, which excludes the
surface's own document. **The 2026-08-10 verdict is unaffected** — that run captured a real
154 KB `salesApiLeadSearch` body — so D351 stands as recorded.

**The probe's budget rose 6/6 → 10/10, per invocation and per day (D401)**, because at 6 one
CDP transport fault consumed the day and left the accounts search unmeasured. 20% of the
global 50/day; the global cap is untouched.

**Renumbered: the branch's D350–D359 became D351–D360.** `main` took D350 for Task 35's
merge decision while this branch was in flight. Every reference in code, docs and STATE moved
with it; the plan README now reserves D361–D369 for Task 37 and D400+ for operator decisions
taken between tasks.

**Still open:** the accounts search is unmeasured (D402's transport fault), and the fault
itself is undiagnosed and now carried in `BACKLOG.md` with an instrument-first approach.

**[BUG] fixed in Task 35's core, found reviewing it after merge (D403).** `runPaged`
adopted an in-flight page by *counting* archive entries above the attempt's high-water mark.
That is right for a source that hands the loop its captures and wrong for one that archives
through the network tap — the tap also archives every other body the page fetched, so the
count exceeds what the load claimed on any ordinary live page, adoption fails, and a page
whose bytes are all on disk is re-loaded and **re-paid** on every resume. D346 backwards, on
the scarcest budget in the system. Latent: every existing test used the first shape and no
capability consumes the loop yet — Task 39 would have been the first to hit it, where a
resume bug and a parse-drift bug look identical from a receipt. Fixed by recording the ids
(`PageAttempt.archive_ids`) and adopting on their presence;
`tests/paged-run-tap-source.test.ts` pins it and the mutation bites.

**Proved live, 2026-08-11: page 2 by click, exit 0** (run `01KZQ4S9FYEB5NCBPQC8FZSGK5`,
2 page loads / 2 search pages, no challenge). `<button aria-label="Next">`, one match,
clicked at 1232,750 after one wheel pass; `salesApiLeadSearch` reported `paging.start 0` on
page 1 and `25` on page 2, and the `sessionId` held across the click. The arrival check ran
off the body, not the label (D404). **Both lead-search fixtures — page 1 and page 2 — are now
promoted**, which is the deliverable Task 36 was previously short of on the leads side, and
the FIELD-MAP pinning test passes unchanged against them (no parse drift in 24 hours).

The first attempt refused (`PAGER_CONTROL_OFFSCREEN`) and the refusal was a defect in the
reveal rule, not the page: `inView` demanded 80px of clearance from every viewport edge, and
the pager rests at the bottom of `div#search-results-container` which the page read has
already scrolled to the end of. It fired on the page's normal resting state. Replaced with a
`document.elementFromPoint` hit test — does the pixel we are about to press belong to this
control — which also separates **obscured** from **offscreen**; the reveal loop now stops
when a pass moves the control less than 4px (D404).

**The CDP transport fault did not reproduce** across the two runs. It stays open (D402).

**~~Still unmeasured: the accounts search.~~** Measured the same day — see the section above.

**The accounts search is measured (2026-08-11, run `01KZQ5TXC23T3FFBJ72P8CE85J`, exit 0,
1 page load / 1 search page).** The operator supplied a company-search url the UI produced,
which is the one thing the probe may not invent. Task 36's remaining gap is closed.

- **Rows in a labeled body here too** — `salesApiAccountSearch`, 25 rows, 12 fields, all
  25/25 present, `paging.total` 660. The DOM exception list stays closed at five across the
  whole M5 family.
- **[DECISION] The dedupe key is per vertical (D406).** An account row has **no `objectUrn`**
  and a **plain** `entityUrn` — the exact inverse of D354, where a lead row's `entityUrn`
  carries a per-execution search context and `objectUrn` is the only stable key. Task 38
  cannot write one keying rule for both.
- **`location` is not in the accounts body** — the card renders 23 of them, the body carries
  none outside the sidebar's filter facets. Not a DOM-exception case: spec §7 asks a search
  row for urn/page/position/run_ref, all present, and a company's location is entity data an
  L1 reader fetches later (M5 CONTEXT rule 5). Pinned as a measured absence.

**[BUG] fixed — the arrival check read the wrong body (D407).** `pagingFromCaptures` took the
largest non-document body. On leads that is `salesApiLeadSearch` and the answer was right; on
accounts it is `salesApiSearchFilterLayout` (81 KB against the account search's 53 KB), which
carries a `paging` block of its own — so the receipt reported **`count 10` for a page of 25
rows**. The search body is now chosen by the patterns that *name* a search endpoint, and a
fallback reports `from: "largest-body"` with a `PAGING_SOURCE_INDIRECT` warning rather than
passing a `salesApiLego` offset off as the search's own. This is the arrival check for a
clicked page, so a wrong body here is a wrong page-turn verdict. Found by running the probe on
a second surface, not by re-reading the code — a verdict that is right on one surface is not a
verdict.

### Next — decided 2026-08-11, deliberately deferred

1. **A second leads target, tomorrow on a fresh daily budget.** The operator's filtered CXO
   url (headcount + US + CEO/Founder/Co-Founder/Owner + software + posted-on-LinkedIn,
   excluding already-messaged/viewed). Everything on the leads side rests on one persona
   search and one target cannot surface parse drift — the M4 lesson that gates Task 39's live
   run. Not spent today: 8 of the probe's 10 search pages were used and the last 2 are retry
   headroom for D402's transport fault, not a loop to run (M5 CONTEXT rule 1).
2. **Accounts page 2 — skipped for now, by operator decision.** The probe has no `accounts2`
   surface. Nothing suggests it pages differently from leads, which is not the same as having
   looked; recorded so a later session does not read the leads verdict as covering both.
3. Task 36's worktree and branch are deleted; `main` carries everything.

## Complete — Task 36, the Sales Navigator surface probe (2026-08-10, live, operator-authorized)

`src/capabilities/salesnav.probe/` plus `FIELD-MAP.md`. Branch
`task-36-salesnav-surface-probe`, cut from `task-35-paged-run-core` (which is in `main`).
**Tests at the time: 1607 pass, typecheck clean** (83 new offline + 12 fixture-pinning).

### The three verdicts

**Seat: yes.** Corroborated from the network, not the render — `salesApiEntitlements`,
`salesApiAccess` and `salesApiTreatment?…lixAcceptIdType=CONTRACT_AND_SEAT` all 200 (D356).
Plan README precondition 1 satisfied; `BACKLOG.md` B1 does not block M5.

**Source: labeled body. The DOM exception list does not grow** (D351). A cold load of
`/sales/search/people?query=…` fetches `salesApiLeadSearch` — 154 KB, all 24 rows as JSON.
This **overturned the prior**: the reference worker read rows out of the DOM and only saw
`salesApiProfiles` after clicking a lead panel. Task 38 parses bodies.

**Pagination: click-only. `[DECISION NEEDED]`** (D352). The pager is **12 buttons, 0
anchors, 0 hrefs carrying `page=N`**; the landed url has no `page` parameter. The reference
worker's `?page=N` form is not offered by this build. Reaching page 2 needs a **click** — a
class of action this toolkit has never taken (D323 precedent). **Page 2 was not spent**: the
gate refused it, unspent, with the reason on the receipt. **Tasks 39 and 40 are blocked on
this decision.** — *Superseded 2026-08-11: the decision landed as D400, the click is
implemented, and 39/40 are unblocked. The measurement above stands unchanged.*

### Spend — budgeted 6 page loads / 6 search pages, used 5 / 3

| run | surfaces | loads | search pages | outcome |
|---|---|---|---|---|
| `01KZP5YAC7HQQ1Y23DH3462JQH` | home | 1 | 0 | exit 2 — CDP socket dropped, see below |
| `01KZP61QK0N7CMNJ38PFTB8PSC` | home | 1 | 0 | exit 0, seat confirmed |
| `01KZP63CX5X5BR64E3ZJ4WBYBM` | leads, leads2, accounts | 2 | 2 | exit 6 — CDP socket dropped on `accounts` |
| `01KZP693DEWVP0S90K7C7XQ997` | leads, leads2 | 1 | 1 | exit 0, both verdicts |

Ledger `page_load` lines 5, distinct pages archived 5, pages the receipts claim 5 — three
numbers from three places, equal. `search_page` 3 likewise. The two failed runs each spent
before they died, which is the contract's designed direction (over-count, never under).

### [BUG] `CDP_CONNECTION_CLOSED` — 2 of 4 runs, not diagnosed

The browser-level CDP socket closed mid-run, twice, on the same Chrome instance (same
websocket id before and after, so Chrome did not restart). Both deaths followed a body fetch
on `salesApiNavChrome`. Keepalive is 30 s and the runs died at ~22 s and ~43 s, so keepalive
never fired; `MAX_FRAME_BYTES` is 512 MB, so it is not a frame cap.

**It cost 2 metered search pages.** Everything downstream failed honestly — the layout probe
timed out, the snapshot failed, the seat verdict returned `null` rather than `false`, and the
pre-success gate denied by default. The rails worked; the socket is the defect. Not fixed
here: it is core CDP, not this task's surface, and fixing it blind would be guessing.

### Also measured

- Scroller is **`div#search-results-container`** (4673 / 627 px) — not the document, not
  `main#workspace` (D358). D115 again.
- **No `data-testid`, no `componentkey`, no `bpr-guid`** anywhere on this surface, so the
  D305/D313 "anchor scope on `data-testid`" discipline has nothing to anchor on (D358).
- `objectUrn` is the dedupe key, **not** `entityUrn` — the latter is compound and its search
  context and token are per-execution (D354).
- `companyUrn` is **27/29 positions**, not universal (D355). Caught by the pinning test after
  the FIELD-MAP's first draft asserted otherwise — which is the argument for the test.
- `sessionId` is minted per execution and pins the result set; a changed one is a different
  search, not a continuation (D360). Task 39's resume turns on this.
- The unfiltered default search urls render an **empty state with zero rows**. The measured
  run used a search url read out of the already-archived `/sales/home` snapshot — a link the
  UI itself rendered, at zero extra page loads (D357).

### Not done

- **The accounts search is unmeasured.** Its run died on the CDP fault and the daily probe
  sub-cap was reached. Tasks 38/40 must treat every accounts-side field as unmeasured.
- Page 2 of anything — deliberately, per D352.

**Decisions: D351–D360**, the range the plan reserved, all free when taken.

**Next:** the click decision (D352) unblocks 39/40. Task 38 can start now on the leads side
only — its accounts half needs one more probe page once the sub-cap window clears.

## Complete — Task 35, the paged-run core (2026-08-10, offline, zero LinkedIn contact)

`src/core/paged/` — the spend/checkpoint/resume contract Tasks 36/39/40 consume instead of
re-inventing, plus the salesnav sub-caps. **0 page loads, 0 search pages spent**, as the task
file required. Merged to `main` as `acde15b` on 2026-08-10, after operator review.

**Built.** `runPaged()` over the existing `RunContext.checkpoint()`, `RawArchive` and budget
ledger — no second checkpoint mechanism, no second ledger path, ledger semantics untouched.
Alongside it: `pauseFileStop`/`installSignalPause` (pause at a page boundary), a dwell layer
(three-part mixture, break every fifth page), `reconcile()` (resume verified against the
archive), and `src/core/paged/README.md` as the contract doc.

**Sub-caps** in `src/core/budget/constants.ts`: `salesnav.leads.list` 20/20, `accounts.list`
10/10, `probe` 6/6, `savedsearch.list` 6 page loads / 0 search pages, all with zero profile
opens. Numbers accepted by the operator at merge and now the live defaults (D345, D350).

**Tests: 1525 pass, typecheck clean.** 66 new across three files. The kill matrix is the
headline — a 3-page run killed between **every** adjacent pair of steps (8 boundaries × 3
pages = 24 scenarios), resumed, each converging to exactly one *claimed* archived copy per
page with every byte accounted for and the ledger never under-counting.

**Three mutation checks, each run and each verified to bite:**

| mutation | result |
|---|---|
| resume trusts the checkpoint without the archive check | 2 tests fail (missing-bytes cases) |
| remove the adoption guard, so a proved page is re-spent | 1 test fails (double-charging) |
| move the spend after the load | 47 tests fail, including the ordering test |

**Two defects the kill matrix found in the first implementation**, both fixed rather than
tested around: a resumed run did not know its last page had said "no next page" and paid for
a page 4 of a 3-page search (`has_more` is now checkpointed, and every stop condition is
evaluated at the top of the loop against the checkpoint so a resume behaves identically to
the session it continues); and a crash inside the spend phase left a real ledger line
attributable to nothing (now bounded and reported as `unconfirmed`, D347).

**Decisions D342–D349.** The task file reserved D340–D349; D340 and D341 were already taken
by Task 34 and the reactions work, so this task took the next eight free numbers, per
standing practice.

**Two stated deviations from the task file**, both recorded rather than quietly absorbed:

1. *"Exactly one archived copy of each page"* does not hold literally when a kill lands
   part-way through archiving. Orphaned bytes are kept, reported and claimed by nobody
   (D348) — deleting archived bodies would break raw-first, and the live consumers archive
   through the network tap, which cannot stage.
2. The ledger cannot be exactly reconciled after a crash *inside* the spend phase. The
   invariant that does hold is `pages + wasted ≤ ledger ≤ pages + wasted + unconfirmed`
   (D347) — over-counting only, never under.

### Next

Task 36 (Sales Nav surface probe) — live, operator-supervised, and the honest seat check.
It is the first consumer of this contract. Nothing in M5 loads a page before the operator
approves the plan and confirms the automation account has a Sales Navigator seat.

## Planned — M5 (L2 Sales Navigator) plan laid down (2026-08-10)

The full M5 plan is written at `docs/plans/m5-l2-salesnav/` — README, CONTEXT, RECORDING,
and six task files (35–40), same shape as m1-m3 and m4-l1-readers. Not started; pending
operator approval. Delivers `salesnav.savedsearch.list`, `salesnav.leads.list`,
`salesnav.accounts.list`, the paged-run spend/checkpoint/resume core (Task 35), and the
`searches`/`search_results` write path (Task 38). `filters.build/apply` stay M6;
`classic.search.*`/`jobs.search` deferred (home fixed at approval). Plan-level decisions
D335–D336; task ranges D340–D399. See README "Preconditions" — M5 needs a Sales Navigator
seat on the automation account (Task 36's first load is the honest seat check) and treats
pagination-by-click as a `[DECISION NEEDED]`, not an assumption.

**Removed:** `supabase/migrations/0012_pipeline_and_starring.sql` — it altered a `leads`
table absent from this project's §7 schema, used a foreign naming convention, and would
have broken `db reset`. It landed here by accident (another project's CRM migration) and
was deleted 2026-08-10.

## Complete — Task 34 `post.get` author resolution, live-verified on Ember (2026-08-10)

**Gate passed, default flags, 1 page load.** Run `01KZP19KXT6PJK9PSXC4SNW038`, exit 0,
`renderer: "ember"` — the first live proof of both D340's fallback and D330–D333's author
resolution, neither of which had ever run against a real page.

Verified independently of the receipt:

- **The row.** `select * from person_posts where urn = 'urn:li:activity:7491197577439141888'`
  returns one row whose `person_urn` is `urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA`
  — the urn Task 27's gate stored for `tankots`, resolved here from the store by vanity and never
  from the page (D330). 1,091 characters of text, `posted_at` from the snowflake,
  reactions 1052 / comments 74.
- **`first_seen` held, `last_seen` bumped.** `first_seen` stays 01:31:29, written by
  `profile.posts` this morning; `last_seen` moves to 14:30:45. D102's "a re-scrape cannot reset
  first_seen" holds across two different capabilities writing the same row.
- **The spend.** Exactly one `page_load` line under `post.get` for this run id.
- **The renderer.** The archived snapshot has 0 `data-testid` attributes and carries
  `theme--mercado`, so the Ember path is what actually ran — not inferred from the receipt field.

Task 34 is closed. D334 remains the only open question on this capability, and it is now a
question about the *SDUI* company page only.

## Was blocked — Task 34 `post.get` author resolution (2026-08-10)

**Offline half done and merged; live gate run and blocked by renderer drift (D337).** `post.get` no longer stores nothing: the author
vanity is resolved to a urn through `findPersonByVanity` and one row goes into `person_posts`
(D330). 1428 tests across 93 files, typecheck clean, zero LinkedIn requests spent so far.

Four outcomes, each pinned by a test and each visible at `data.author.status`: `resolved` writes,
`ambiguous` refuses and warns (D331), `not-found` and `no-vanity` write nothing and still exit 0
(D332). `--no-store` skips the lookup entirely rather than performing it and throwing the answer
away. The write reuses Task 27's shared projection and adds no column (D333).

**The company half is deliberately unbuilt (D334, [DECISION NEEDED]).** A company-authored
permalink yields no `/in/` vanity, so it warns and writes nothing — pinned by a test, so the safe
default cannot rot. Whether such a page carries the same anchors is unmeasured; the one fixture on
disk is person-authored. Settling it costs one page load against a company-authored permalink,
which is the operator's call.

**Live gate run 2026-08-10, 2 loads, both exit 5 — and the reason is not Task 34 (D337).**
Merged to `main` as `2e46aba` first, then gated on `main`.

- Load 1, run `01KZNXNTPRSTYJNF53GFYTTYVA`, `/posts/tankots_…-activity-7491197577439141888-dqLl`.
  `POST_GET_IDENTITY_UNRESOLVED`, exit 5, 1 page load, nothing stored.
- Load 2, run `01KZNXS9R6R13H10TVBABA0HGH`, `/feed/update/urn:li:activity:7485405402449379328/`
  — company-authored, urn taken from a stored `company_posts` row. Same code, exit 5, 1 load.

**The post surface changed renderer between 03:01 and 13:27 on 2026-08-10.** Both loads returned
the legacy Ember/`theme--mercado` app: **0 `data-testid` attributes and 0
`ReactionFacepileCollection` occurrences**, against 14 and 836 in the SDUI snapshots archived
eight hours earlier from the same URL. `post.get` anchors identity and every scope on
`data-testid` (D313), so it resolves nothing and refuses. Both URL spellings rendered Ember, so
this is the account or the rollout, not the spelling. Measured offline from the archives, at
zero further cost — full table in D337.

**Author resolution is therefore still unproven live.** Identity is refused before the author
step is reached, so D330–D333 were never exercised against a real page. The offline proof
stands; the live confirmation does not exist yet.

**D334 stays open (D338).** Load 2 archived a real company-authored permalink, which is new —
but of the Ember render, whose anchors were never measured. It cannot answer what D334 asked
about the SDUI page.

**Nothing was stored and nothing wrong was stored.** Exit 5 with the archived body named on the
receipt is the designed behaviour for parse drift, and it is what happened, twice.

## Done — both renderers supported, and the surface sweep (2026-08-10, D340/D341)

**`post.get` now parses the Ember page too, and says which one it read.** Written entirely
offline against the two snapshots the gate archived — **zero further page loads**. 1448 tests
across 93 files (was 1428), typecheck clean.

The two parsers are separate and dispatched by anchor detection, never merged (D340): the pages
share no anchor, so a merged parser would mix scopes from two page models. `data.renderer`
appears on every receipt and leads a refusal's evidence.

Both real snapshots are pinned: person-authored reads author `tankots`, 1049/73/5 totals, 10
comment rows, 9 facepile reactions; company-authored reads its text and refuses the author with
`PARSE_AUTHOR_COMPANY` naming `wisprflow`. Five guards were mutation-verified to bite — nested
reshare exclusion (without it the company's post stores under `sudha-ranganathan`), comment-row
exclusion, control-menu corroboration, session-own refusal, and identity. One residual is stated
rather than hidden: the strict `^N reactions$` anchor is redundancy behind the scope, not an
independent guard.

**The renderer sweep is done, and it corrects the earlier read of this.** Every DOM snapshot on
disk was classified by sidecar `pattern: "dom-snapshot"` rather than by file size:

| Surface | Last snapshot | `data-testid` | `theme--mercado` |
|---|---|---|---|
| `/in/<vanity>` (`profile.get`) | 08-10 02:35 | 81 | no |
| `/jobs/view/<id>` (`job.get`) | 08-10 02:57 | 16 | no |
| `/feed/` (`feed.get`) | 08-10 05:24 | 35 | no |
| `/messaging/` (`inbox.*`) | 08-10 09:54 | 0 | **always** |
| `/posts/`, `/feed/update/` (`post.get`) | 08-10 03:01 → 13:27 | 30 → **0** | no → **yes** |

**Mercado is not new to the account and not spreading — `/messaging/` has always been mercado
and `inbox.*` parses it correctly.** Only the post surface switched. The three SDUI DOM readers
were last measured 8–11 hours before the switch and show no sign of it; confirming them costs
one supervised load each and is not evidence-backed work today.

## Done — reactions moved onto the labeled body (2026-08-10, D341 settled)

**Offline, zero page loads.** `post.get` now reads reactions from the
`voyagerSocialDashReactions` body the Ember page fetches itself, with the DOM facepile as the
fallback for the renderer that fetches none. 1459 tests across 94 files (was 1448), typecheck
clean.

The gain is identity, not convenience: the body gives `actorUrn`, a `reactionType` enum and
`paging.total` where the facepile gave a display name scraped from
`"View <name>'s, reacted with LIKE, graphic"`. Each row also names its own post, so a body
fetched for a neighbouring post contributes nothing — `REACTIONS_FOREIGN_POST` counts what was
dropped.

Rows are tagged `source: "voyager"` against the DOM's `"dom-snapshot"`, and the receipt states
`read.reactions_source`. Four guards mutation-verified: the foreign-post scope, the limit bound,
the opt-in default (a default run does not consult a body that is present), and the preference
itself.

**Next — operator's call:**

1. **One live `post.get` re-run** would close Task 34 properly: exit 0, `renderer: "ember"`, and
   a `person_posts` row for `tankots` verified by direct query. Author resolution (D330–D333)
   is still the one part of Task 34 never exercised against a real page. 1 page load.
2. **Three surfaces unconfirmed since the switch** (`profile.get`, `job.get`, `feed.get`).
   Operator decided 2026-08-10: **do not spend loads on this** — the disk sweep showed mercado
   is not spreading, and the loads are saved for M5. They confirm themselves the next time they
   run for real.

**A promoter defect found on the way:** `npm run fixtures:promote` skipped both Ember snapshots
as `duplicate_shape`. Every HTML body hashes to the same non-JSON shape constant, so the second
DOM snapshot a capability ever promotes is always dropped as a duplicate of the first. The two
fixtures here were extracted directly instead. Not fixed — it is Task 16's module and belongs
with whoever next touches it.

## Checkpoint 7 — Task 33 review fixes, live-verified (2026-08-10)

Two defects found by reviewing the first live gate, both fixed and both re-run live. All 4
inbox page loads are now spent; the ledger shows two `inbox.list` and two `inbox.thread`.

**The wrong box was being scrolled (D298).** `/messaging/` is the first surface with two
scrollers side by side, and the tallest-element rule picked the conversation rail for both
readers. `inbox.list` wanted the rail and was right by luck; `inbox.thread` wanted the message
pane and paged the rail, returning 1 message with a settled layout and no warning. The scroller
can now be named by selector, the wheel is aimed inside the chosen element's rect, and falling
back to the tallest element raises `SCROLLER_SELECTOR_UNMATCHED`. Both selectors were read
offline from an archived snapshot, for zero page loads.

**Correspondent names were on the receipt (D299).** The 2026-08-10 `inbox.list` run printed 20
real names and profile urns to stdout. Participants are now urn plus operator flag only, pinned
by the same leak test message text has.

Live re-runs. `inbox.list` `01KZNFTXE2D1530BHYAFEGH7HV` exit 0, 20 conversations, 1 unread —
this run predates the name fix and did print names. `inbox.thread`
`01KZNH277M33767P4VEGGFM4E6` exit 0, and it is the first run to exercise
`direction: "received"` (sent 0, received 1). It also raised the new
`SCROLLER_SELECTOR_UNMATCHED` warning: the message pane is present in the DOM but had one
message and nothing to scroll, so the scrollable test correctly rejected it and said so.

One `CDP_PROTOCOL_ERROR` (exit 6, `Storage.getCookies` — "Browser context management is not
supported") on a first attempt, 0 page loads spent; the retry succeeded. Not investigated.

**Checkpoint 8 — the selector was wrong, and its own warning caught it.** With operator
authorization the task went past its 4-load plan cap; 6 inbox loads total, ledger sub-cap
(12/day) not approached.

`01KZNHBF6K79YR9G5WWVRDQ247` read a real multi-message thread: **16 messages, 6 sent, 10
received**, plus `MESSAGE_NO_TEXT: 2` — two attachment-only messages emitted with a count
rather than dropped. It also raised `SCROLLER_SELECTOR_UNMATCHED` again, and the fallback
happened to land on the right box because the pane (2062) out-measured the rail (1888) on this
thread. On the one-message thread it had not. That is the fallback being unreliable in both
directions, which is the whole argument for D298.

The archived snapshot showed the nesting one level off: `.msg-s-message-list-container` is a
`display-flex` wrapper with no overflow and `.msg-s-message-list-content` is the `ul` inside;
the element that scrolls is `div.msg-s-message-list.scrollable#message-list-ember3`. Selectors
corrected, with the Ember id matched by prefix as a second anchor.

`01KZNHH01F50YF93H5F36WDVMC` confirms it: **no `SCROLLER_SELECTOR_UNMATCHED`**,
`matchedSelector: ".msg-s-message-list"`, and the wheel aimed at `x 407, width 469` — the
centre pane — where the previous run aimed at `x 94, width 312`, the rail. Same 16 messages,
so the parse is stable across runs.

Everything Task 33 set out to prove is now proven live: both directions, multi-message paging,
textless messages, the named scroller, and no message text or correspondent name on any
receipt.

## Complete — Task 33 `inbox.list` + `inbox.thread` (2026-08-10)

Checkpoint 1 (offline, zero LinkedIn contact): private fixture promotion now has a separate
`promotePrivateFixtures` entry point with a required endpoint boundary and no `all` option;
shared promotion still refuses the same D118 endpoints. `inbox.*` is routed automatically to
repo-root `.fixtures-private/` and cannot take `--fixtures-dir` (D290). The inbox family has
URL-aware payload classification plus field probes for participants, latest-message preview,
timestamp, unread state, sender, text and sent time. Replaying real run
`01KZH9VVPKB5JEVEBW7G2JJ6F3` promoted one 339,617-byte `messengerConversations` body privately
and skipped 23 out-of-bound bodies; this spent 0 page loads and put the first real inbox fixture
on disk, lifting D152 for the network parser. Focused verification: 46 tests pass; typecheck
clean. Next: meaning-check the measured paths, create the redacted committed fixture, then TDD
the pure parsers and capture composition. The operator-supervised messaging page load remains
unspent.

Checkpoint 2 (offline, zero LinkedIn contact): both pure parsers, tested FIELD-MAPs and the
committed synthetic fixture now exist. The measured Voyager envelope supplies all required
fields, so it wins over the DOM fallback (D291). `inbox.list` returns bounded conversation
summaries with text lengths; `inbox.thread` tags sender direction through the supplied session
urn set and emits textless messages with a counted warning. Both compositions parse archived
bytes, expose counts/metadata only, state archive-only-pending-decision, and carry 12/0/0 ledger
sub-caps (D292). The thread receipt explicitly says opening it may mark it read. Focused
verification: 70 tests pass; typecheck clean. Next: capture-layer failure-path tests, registry
reachability, full suite/review, then stop for operator approval before any messaging page load.

Checkpoint 3 / offline gate complete (zero LinkedIn contact): the four review shapes were
walked. Navigation/read failures drain the tap and release every watch; lower-layer classified
errors pass through; every receipt/privacy/bound claim has a named test; the real capture
implementation satisfies both injected dependency contracts at typecheck. Review tightened
the private endpoint predicate, made both bounded reads explicitly partial (D293), capped group
participants at 20, normalized tracking queries off thread hrefs, and changed both parser return
types to carry text lengths rather than text. Inbox DOM promotion now emits content-free anchor
counts instead of falling through to the profile mapper. Full suite: **1,394 passed across 90
files**; typecheck and `git diff --check` clean. Task spend remains **0 of 4 page loads**. Next:
stop for operator approval, then run default `inbox.list` and one `inbox.thread`, acknowledging
that the latter may mark the thread read, and verify counts directly from archives/ledger.

Checkpoint 4 / operator approval (before live contact): archive-only storage is settled and
recorded in D294; there will be no messaging migration or BACKLOG deferral. The operator
approved the default-flags live gate in list-then-thread order and explicitly accepted that
opening the chosen thread may mark it read. Expected thread outcome is either exit 0 on the
list envelope or fail-honest exit 5 if the live page uses the already-watched
`messengerMessages*` operation; in the latter case its archived body becomes the offline parser
fixture before load 3. Spend at this checkpoint remains 0 of 4 page loads.

Checkpoint 5 / live list gate (1 of 4 page loads): default `inbox.list` run
`01KZNABFNDM59AQEAEHV5SRTTG` exited 0 with 20 of 20 conversations usable, 1 unread and 3
textless latest-message rows; the measured scroller was one `ul`, 1,796px over a 626px client.
Independent archive inspection found one 20-row conversation envelope plus two identical
`messengerMessagesBySyncToken` bodies, and direct ledger inspection found exactly one
`page_load` line under `inbox.list`. Two watched responses were missed and reported. The message
body lifted the expected thread-parser gap without another load: its direct envelope is now the
primary tested path, with multi-body urn dedupe (D296). The list page itself auto-opened a thread
pane, so its receipt now acknowledges possible read marking too (D295). Before load 2: the
operator already accepted this side effect; the gate will use the first conversation whose
list row reports `unread_count: 0`, minimizing avoidable state change while still treating the
view as potentially read-marking.

Checkpoint 6 / live thread gate complete (2 of 4 page loads): after the read-marking effect was
acknowledged, default `inbox.thread` run `01KZNATNDEC8SX22CX2T81M4Z3` exited 0 on that already-read
conversation. It emitted 1 of 1 usable message, tagged sent, with `text_chars: 121`,
`partial: true`, archive-only storage and no message text. Independent archive inspection found
two duplicate `messengerMessagesBySyncToken` bodies containing one unique message urn and no
textless rows; exact-value containment testing found zero message values in `summary.json` or
`events.ndjson`. Direct ledger inspection found exactly one `page_load` line under
`inbox.thread`. Private promotion recognized the measured shapes and two session urns, adding no
duplicate fixture and spending no load. Both default live gates are therefore complete with
**2 of 4 page loads spent and 2 spare** (D297). Full suite and typecheck are green at task close.
The final suite result is **1,397 passed across 91 files**.

## In progress — Task 32 `feed.get` (2026-08-10)

Checkpoint 1 (offline, zero LinkedIn contact): the feed surface now exists as a promotion
family. `src/core/fixtures/families.ts` gains `feed` — relevance `isFeedIsh`, the shared
`ACTIVITY_PROBES` set, `buildFeedDomMap`/`renderFeedDomMap`, and an explicit `null` subject
because a feed has no single subject (D325). `src/core/fixtures/feed-dommap.ts` is a
shape-based measurement: it discovers candidate item-boundary rules by attribute/urn-family
and reports, per candidate, nesting, distinct urns, and how many items have **no** resolvable
author link — the count that must be reported unresolved rather than guessed. The promoter's
session identity now runs through `identity.ts` (D322-aware) and yields vanities as well as
urns, one body at a time. `feed.get` is capped 24/0/0. `src/capabilities/feed.get/` holds
constants, patterns and the bounded capture; `index.ts` is the probe and **parses nothing**
(D152). Typecheck clean. Next: `health.check`, then one live `/feed/` capture.

Checkpoint 2 (1 page load spent of 3). `health.check` ok, then one default-flags
`feed.get` probe run `01KZMZ5BQD2MKSN8EV7WRG38P0`, exit 0. **The measurement (D280): no
labeled body carries feed items.** 26 responses, zero hits on all six watched feed endpoints,
and the 5.2MB `/feed/` document has zero Big Pipe islands (RSC flight tree only). So D325's
fallback is in use because it had to be, and the probe stays on every receipt. The DOM map was
rewritten against what was measured: container `[data-testid="mainFeed"]`, 13 children of which
8 are cards, card scope `componentkey="expanded<TRACK>FeedType_<TYPE>"` plus the bare `<TRACK>`.
`parse.ts` reads the author from `aria-label="Open control menu for post by <name>"` — 3 of 8
cards hold multiple `/in/` links and the first is the wrong person on all three (D281) — and the
post urn only from a comment's parent, 3 of 8 (D282). Storage is archive-only (D283); promotion
now resolves session identity through `identity.ts` (D284). 32 feed tests plus 5 family tests;
full suite **1354 passed across 83 files**, typecheck clean. Next: the default-flags live gate
with an independent count of the archived items.

Checkpoint 3 / done offline (2 page loads spent of 3). **Live gate passed on default flags**:
`cap feed.get` run `01KZN04CZGRXCN16GA8M4E4T5Y`, exit 0, 1 page load, 8 items, 0 unresolved
authors. Verified independently of the receipt by grepping the archived snapshot: 8 distinct
`expanded<TRACK>FeedType_` wrappers, 8 `Open control menu for post by` labels whose names match
the receipt's eight authors one for one, and 2 distinct comment-parent urns matching the
receipt's `with_urn: 2`. One card (MAXHUB) named an author whose link could not be resolved and
was reported, not guessed. The receipt's feed-API hit count now excludes the document watch, so
the number means what D280 claims. Full suite **1354 passed across 83 files**, typecheck clean.
Storage decided by the operator on 2026-08-10: **archive-only, no Supabase** — recorded in
D283, which is now closed rather than deferred.

Checkpoint 4 — review follow-up, all five findings fixed (3 page loads spent of 3). Both D325
probe signals were broken and are the mechanisms the grant was conditioned on: `NO_FEED_PAYLOAD`
had never fired and `PATTERN_MISMATCH` fired every run, because `isFeedIsh` counted the page's own
document and the notification rail as feed payloads (D285). `carriesFeedPayload(body, url)` is the
stricter test the counts now use; `summarizeCaptures`'s predicate sees the url. A card with no text
box is no longer dropped — a media-only post is a post (D286). Relative `/in/` hrefs are resolved
before identity is read off them, so the operator-tagging guard cannot go inert quietly (D287).
Warning ratios cite `examined`, not every card on the page (D288). Proven by replaying both
archived runs offline — before `feed_ish 2 / unmatched 1`, after `0 / 0` — and confirmed live on
run `01KZN22Z7AGSFFKS0BNYCGZMPZ`, exit 0, which reported `NO_FEED_PAYLOAD` and caught one real
`FEED_ITEM_NO_BODY` on its first try. Full suite **1362 passed across 84 files**, typecheck clean.
Task 32 is complete; nothing is blocking.

## In progress — Task 31 `job.get` (2026-08-09)

Checkpoint 1: fixture promotion now routes DOM maps by family (D270). Job maps anchor on
`data-testid="expandable-text-box"`, require the `About the job` heading, and resolve exactly
one job-posting urn. The requested widest-net run was re-promoted offline but contains no DOM
snapshot entry; the archived snapshot from the first measured run was re-mapped instead and
now resolves job `4450930857` plus the description anchor. 34 focused tests pass and typecheck
is clean. Next: TDD the pure parser and canonical jobs enrichment store path; no live gate.

Checkpoint 2: `src/capabilities/job.get/` now contains the pure offline parser, capability
wrapper and README; `core/store/jobs.ts` adds the canonical partial upsert (D271-D272). The
promoted snapshot yields the complete description, URL/document disagreement stores nothing,
and company session/trap identity is refused. A real `supabase-js` request-shape test proves
list then detail both merge on one `jobs.id` while omitted fields remain untouched. Mutation
checks killed each of the three required assertions. Full offline suite: 1027 passed, 13 skipped;
typecheck clean. Next: final discipline review and handoff before the live gate.

Checkpoint 3 / handoff: all four review shapes were walked. Capture failures preserve only
raw archive/budget state and never store a job; lower-layer classified errors pass through;
the exact data-testid path, identity refusal, partial-upsert omission semantics and composition
with the existing capture/store modules are pinned by tests and typecheck. Final full suite:
1027 passed, 13 skipped; typecheck and `git diff --check` clean. Task 31 is stopped before the
operator-supervised live gate as required. Next: operator runs the default-flags gate and
independently queries `jobs.id = '4450930857'` to verify description enrichment.

Review follow-up for `bbcac14`: fixed machine-local fixture discovery, position-dependent
description extraction and silent loss of list items; target identity now tolerates unrelated
recommendation urns (D273, superseding Checkpoint 1's exactly-one rule); unscoped company urns
are always refused (D274); and nullish job fields cannot erase prior enrichment (D275). Missing
description now records parse drift when storage is enabled and halts before claiming usable or
touching `jobs`. DOM mapper build/render are one paired option, and field-map/parser heading
cardinality now agrees. Live gate completed exit 0 (1 load spent, 1 verified jobs row in `docs/reports/2026-08-10-live-test.md`). Task 31 is complete.
The fresh-clone fixture path was exercised with an empty shared root (4 synthetic tests pass,
1 fixture test skips visibly), and mutation checks killed recommendation-rail identity,
list-item preservation and null-safe enrichment. Final review suite: 1031 passed, 13 skipped.

Updated at every task commit. Trust this over CLAUDE.md's phase line.

**The active plan is `docs/plans/m1-m3/`** (outcome-driven, one file per task; see D12).
The 2026-08-07 plan file is superseded — do not execute from it.

**Task 25 in progress; source gate passed offline.** The promoter now preserves initial
HTML documents that contain parseable structured-data islands separately from DOM snapshots,
with a regression test; both jobs-tab artifacts are in `fixtures/company.jobs/` and its
generated FIELD-MAP was read. D210 records outcome (a): outside every `meta.microSchema`
subtree, the document has 9 subject-scoped `LISTED` JobPosting value records, plus 10
unscoped navigation stubs across 17 ids. D211 fixes §7 `jobs.id` as the decimal posting id.
Parser/store TDD is next. Zero LinkedIn contact; no browser launched.

**Task 25 implementation checkpoint.** `company.jobs` now has a pure bounded embedded-JSON
parser, subject-company scope, numeric id canonicalization, measured list-field projection,
one-load composition, identifier-free receipt, explicit 150/0/0 sub-cap, atomic id-deduplicated
`jobs` storage, README/SQL, synthetic tests and a visibly gated 9-row fixture assertion.
D210–D219 are recorded. Focused verification is 37/37 tests and `tsc --noEmit` clean;
required mutation checks and the full suite remain. Zero LinkedIn contact; no browser launched.

**Task 25 offline complete; live gate untouched.** Source outcome (a) is recorded with
measured evidence in D210, and D210–D219 are complete. Final verification is **1016/1016
tests across 58 files**, `tsc --noEmit` clean, and `git diff --check` clean. With all of
`fixtures/` moved away, the company.jobs slice reported **11 passed, 1 skipped**. Mutation
verification failed the named tests for non-subject-company exclusion, canonical numeric job
id, pre-upsert batch dedupe, and `--limit` work stopping. The next action is the
operator-supervised default-flags live gate, which must verify one metered jobs-tab load,
embedded-JSON source, subject-only numeric-id rows, independent Supabase values/counts,
preserved first_seen with bumped last_seen, archive evidence, and 1/0/0 ledger spend.
Zero LinkedIn contact; no browser launched during Task 25.

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
Task 22 — `company.get`. **Offline implementation complete on branch
`task-22-company-get`; stopped before the operator-supervised live gate as required.**
`src/capabilities/company.get/` supplies the pure parser, composition, tests and README;
`src/core/store/companies.ts` supplies freshness lookups and the ordered company write.
Decisions D185–D188. The real run fixture pins all seven §7 fields. Review fixes moved the
document body from ephemeral run storage into `fixtures/company.get/`, made fixture tests
skip visibly when absent, split all synthetic contracts into an always-running suite, added
exact numeric-id resolution, and let legal Big Pipe JSON fill a missing Voyager name. Every growth bound is
exceeded by a test; identity refusal, missing required name and field truncation were each
mutation-verified by breaking the implementation and observing the named test fail.
Proven offline after review: **976/976 tests pass (46 files), typecheck clean,
`git diff --check` clean.** The Big Pipe name fallback was mutation-verified separately.
Not run: the live default-flags gate, independent Supabase/archive/ledger verification, and
the immediate freshness rerun; these require the operator-supervised metered page load.

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

Task 30 — job surface probe. **Offline half complete and committed. The live probe run has
not happened: it is the operator's to supervise, so the fixture, the FIELD-MAP and Task 31's
source verdict do not exist yet.** Branch `task-30-job-surface-probe`, worktree
`../LinkedinLeadsOS-worktrees/four` (worktree `three` was already checked out to Task 26).
Decisions D260–D264.

**Built (offline, no LinkedIn contact anywhere):** `src/capabilities/job.capture/` —
`url.ts` (canonical job id, D260), `patterns.ts` (job watch patterns, `isJobIsh`, the job
document pattern, `JOB_FIELD_PROBES` — one per §7 `jobs` column), `probe.ts` (the passive
description-truncation measurement and its four-way verdict, D263), `identity.ts` (subject
served? company urn resolved-or-refused? which person urns are the operator's, via
`sessionUrnsOf` — never re-implemented), `constants.ts`, `index.ts`, `README.md`.
`src/core/fixtures/families.ts` routes promotion per surface (D264); `summarizeCaptures`
takes an optional relevance predicate (D261) instead of being copied.

The capability reuses `profile.capture`'s `readLikeAHuman`, `captureDomSnapshot`,
`sessionUrnsOf` and pacing constants unchanged. It **parses no job field and stores nothing**
— D152's rule that a probe delivers measurement, not code that consumes it.

Proven: **876 offline tests pass, 13 skipped, typecheck clean** (73 new across
`tests/job-capture-{url,patterns,probe,identity,run}.test.ts` and
`tests/fixtures-families.test.ts`; 803 was the count without them). `EXPANDER_EXPRESSION` is
executed as real JavaScript against a stub page, including its 20,000-element bound.
Mutations verified to bite: requiring `<section>`s on the job page fails 2 tests; spending
the page load after navigation instead of before fails the ledger-order test; removing
`finally { drain() }` fails the mid-read-halt test (that test was rewritten with a slow body
after the first version passed without the drain — a double that certified a guard it did not
exercise); breaking `summarizeCaptures`'s default fails 6 profile tests.

**Review 2026-08-09 (commit defffe1), one real defect, fixed before any page load was
spent.** The description measurement's "largest text block" had no tag filter, and a
`<script>` has no child *elements* — so the child-count bound did not exclude it, and its
`textContent` is the JSON the document response server-renders (D117), almost certainly the
biggest text node on a real job page. `data.description.largest_block` is the row Task 31's
field map is addressed from; it would have reported `tag: "script"`, `clientHeight: 0`,
`componentkey: null` — a dead end dressed as a measurement. The verdict itself was never at
risk (`not-truncated` needs a page-wide `clampedBlocks === 0`, which a script cannot affect).
Fixed with `NON_RENDERING_TAGS` plus a `clientHeight > 0` requirement; both mutation-verified.
Also tightened: `namesJob` matches the bare posting id on digit boundaries, so a tracking
number containing it no longer inflates `subjectBodies` and widens the company-urn sweep the
scoping argument rests on.

Spend so far: **0 of the 3 page loads budgeted.**

**Not done, and blocking:** the live run, the promoted fixture, `fixtures/job.get/FIELD-MAP.md`
with every path pinned by a test, and the per-field source verdict in Task 31. See `## Next`.

## Next

**Task 23 — `company.posts` is in progress on `task-23-company-posts`.** Source and
composition checkpoints are complete: one measured posts-tab load, Voyager-only parsing,
corroborated company identity, typed actor filtering, two-hop social counts, activity-snowflake
timestamps, bounded parsing, and batch store ordering are recorded in D190–D194. No LinkedIn
contact has occurred; parser/store/composition implementation and offline proof are next.

**Task 23 implementation checkpoint.** Parser, composition, explicit 150/0/0 sub-cap,
`company_posts` batch store, README, eight synthetic parser tests, the gated measured-fixture
test, two composition tests, and two store tests now exist. Four required mutations were
observed failing their named tests: author-filter deletion produced 11 rows instead of 4;
constructed counts lost reactions/comments; an exclusive since comparison lost the boundary;
and removed limit break parsed 2 rows. The fixture-absence run passed 9 synthetic tests with
1 visible skip. No LinkedIn contact or browser launch occurred.

**Task 24 measurement checkpoint.** Branch `task-24-company-people` inherits Tasks 22 and 23.
The two named people bodies were promoted into the shared `fixtures/company.people/` library
and its generated FIELD-MAP was read before parse code. The measured list is the
`voyagerSearchDashClusters` cluster: eligibility requires a cluster item reference plus the
selected `currentCompany` filter matching the resolved company id (D200). Cost is one page load
and no separate search-page/profile-open unit (D201). Work remains fully offline; no browser was
launched and LinkedIn was not contacted.

**Task 24 implementation checkpoint.** The pure cluster parser, company/session scope guards,
name/title filters, work-bounded limit, 256-body/200,000-node/20,000-character ceilings,
pair-deduplicated `company_people` batch upsert, explicit 150/0/0 sub-cap, composition, README,
and synthetic/gated-fixture tests now exist. Four mutations failed their named tests: removing
company scope admitted the non-employee trap; removing session exclusion stored the session urn;
removing pair dedupe sent two identical keys; disabling the limit break returned two rows. With
`fixtures/company.people/` moved away, eight tests passed and the measured test skipped visibly.

**Task 24 offline complete; live gate untouched.** `company.people` now resolves company
identity before parsing, accepts only references from the measured subject-selected
`currentCompany` cluster, excludes all session urns, returns bounded profile URLs, applies
capture-data name/title filters, stops work at `--limit`, and atomically stores deduplicated
association pairs without resending database-owned `discovered_at`. D200–D209, the explicit
150/0/0 sub-cap, README/SQL, pure tests and gated 12-row fixture assertion are complete. Final
verification: **1001/1001 tests across 54 files**, `tsc --noEmit` clean and `git diff --check`
clean. The next step is the operator-supervised default-flags live gate; it must verify one
metered people-page load, zero separate search/profile-open spend, real downstream-usable URLs,
session/non-employee exclusion, deduplicated pair storage and preserved discovery timestamps.
Zero LinkedIn contact; no browser was launched during Task 24.

**Task 23 offline complete; live gate untouched.** `company.posts` now has its pure bounded
Voyager parser, resolved-or-refused subject identity, four-of-eleven author filtering,
two-hop counts, snowflake timestamps, inclusive `--since`, work-bounded `--limit`, atomic
`company_posts` batch storage, explicit 150/0/0 sub-cap, README/SQL recipes, and D190–D199.
Final verification: **989/989 tests across 50 files**, `tsc --noEmit` clean, and
`git diff --check` clean. The next step is the operator-supervised default-flags live gate;
it must verify one metered page load, only subject-authored rows, counts/timestamps by an
independent Supabase query, receipt/storage counts on a second run, archive files, and the
ledger. Zero LinkedIn contact; no browser was launched during Task 23.

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

Task 29 — `post.get` (**capture unblocked; source verdict recorded; still needs one operator
decision**, 2026-08-09). After merging main's CDP transport fix (D310) into this branch, the
permalink captured on the first attempt: run `01KZKXSGNE4XRQMJRK241YQS6Q`, exit 0, 1 page
load, 26 captures, 0 misses, including the 4,750,447-byte document that had killed the socket
four times. Fixtures promoted to `fixtures/post.get/` (DOM snapshot + FIELD-MAP.md); the
document body itself is skipped by the promoter as `not_json`, which costs nothing here
because it carries no embedded JSON at all.

Source verdict (D312): the surface has **no labeled JSON for the post** — zero `bpr-guid`
islands, zero `socialActivityCounts`, and zero hits on all four social watches. The data is
in the rendered DOM, anchored on `data-testid`, exactly like D305's job surface. Writing
`post.get` therefore requires a **third DOM-source exception**, which CLAUDE.md does not
currently permit — that is the operator's call and is the one thing still blocking the task.
`--reactors` / `--commenters` are recommended to split into their own task; those panels are
not fetched on a cold load.

D311 corrects D309: the transport fix is proven, its stated cause is not. The captured body
has zero U+FFFD, and the fragment-boundary theory is disproven too.

Branch state: `task-26-activity-surface-probe` carries Tasks 27, 28, the tap fix (D307) and
main's transport fix. Full suite 1,124 passed, 0 skipped; typecheck clean.

Task 29 — `post.get` (**implemented offline; live gate pending operator**, 2026-08-10). The
operator granted the third DOM exception (D313), so CLAUDE.md's "two exceptions" rule is now
three. Delivered `src/capabilities/post.get/` — pure parser over the promoted snapshot, the
composition, 19 tests, and a README.

Flags are the shape the operator asked for: a default run reads the post only; `--comments`
and `--reactions` are opt-in, each with its own `--*-limit` (default 10), reactions ranked
below comments. Nothing loops "load more", and partial reads are flagged by number and by
boolean (D315). Identity is resolved from the `ReactionFacepileCollection-<activity urn>`
testid or refused. The author is resolved by eliminating comment rows, the facepile and the
session's own public identifiers — the D119 trap in its DOM spelling; `sessionVanitiesOf` was
added next to `sessionUrnsOf` for it.

Storage is archive-only (D314): the snapshot carries no author urn, and both post tables
require one, so writing a row would mean inventing an author key. The vanity-lookup route is
named and deliberately deferred.

Verified: typecheck clean; full suite **1,143 passed, 0 skipped**; `cap list` discovers
`post.get` with all five flags; three mutations each killed by their named test. `post.get`
has its own budget sub-cap asserting zero profile opens and zero search pages.

**Not done: the live gate.** No LinkedIn page was loaded for this task — the capability has
never run against a live permalink, only against the archived snapshot from run
`01KZKXSGNE4XRQMJRK241YQS6Q`.

Task 29 review follow-up — CLI reachability, 2026-08-10. Fixed a class of defect rather than
two instances: capability schema keys must be camelCase or the flag is unreachable, because
`parseArgv` camel-cases before a `.strict()` schema sees the key (D316). `post.get`'s
`--comments-limit` / `--reactions-limit` and `log.runs`'s `--include-queries` were all
unusable; all three now work. `tests/cli-schema-keys.test.ts` enforces it across the whole
registry and round-trips real argv, so the next occurrence fails at authoring time. Two tests
that hand-built kebab keys — the pattern that hid the bug — were corrected to the spelling the
CLI actually produces. Post totals are now scoped outside comment rows (D317). Full suite
**1,146 passed, 0 skipped**; typecheck clean.

Task 29 — `post.get` (**live gate passed; task complete except storage**, 2026-08-10). Two
supervised live runs against the real permalink.

Default run `01KZKZSH3YTHFGSB8DQGMKY310`: exit 0, 1 page load, author `tankots`, `posted_at`
derived from the snowflake, totals 1,016 reactions / 73 comments / 5 reposts, and — the point
of D313 — **comments 0, reactions 0**. Nothing was read that was not asked for.

Flags run `01KZKZTT5JWXYH6XRZ1VA87974` with `--comments --commentsLimit=4 --reactions
--reactionsLimit=2`: exit 0, 1 page load, read exactly 4 comments and 2 reactions, with
`COMMENTS_PARTIAL(69)` and `REACTIONS_PARTIAL(1014)` naming both numbers and
`comments_complete: false`. This is the end-to-end proof the D316 rename actually fixed the
flags — the previous spelling could not have parsed.

One live-only bug found and fixed on the way (D318): the delegated capture was being passed
`surface: "post"`, which is refused for a permalink. It failed before spending, so it cost 0
page loads.

Full suite **1,146 passed, 0 skipped**; typecheck clean. Storage remains archive-only (D314) —
the vanity-lookup write path is the only piece of Task 29's file not delivered, and it is
deferred deliberately with its reason written down.

Task 34 — `post.get` author resolution and write path (**queued**, 2026-08-10). Written up at
`docs/plans/m4-l1-readers/tasks/task-34-post-author-resolution.md` as the follow-up D314 named.
Resolves the author vanity Task 29 already parses into a real urn via `findPersonByVanity`, and
writes the post row — refusing on ambiguity (`vanityMatches > 1`) and exiting 0 without a write
when the author has no stored `persons` row. Costs zero page loads: it is a store read, not a
page open. The company-authored permalink case is unmeasured and may need its own capture.
Decision range D319–D328.

**Task 30 needs one supervised live run, then its second half.** Nothing else in the job
family can start (D152). Run, on the automation Chrome, with default flags:

```
cap job.capture --url=https://www.linkedin.com/jobs/view/<id>/
npm run fixtures:promote -- --run=<runId> --capability=job.get
```

Pick a posting from a company already in the store if there is one, so entity rows link up.
Budget: 3 page loads; a second posting is worth one of them (a second shape is what tells a
one-off layout from the surface). Expect exit 0, no challenge, the lease released, and the
receipt's `data.description.verdict` to be the headline result. Then the fixture, FIELD-MAP
and Task 31's verdict get written from the archive — offline.

**[DECISION NEEDED] before Task 31, not before the run.** `CLAUDE.md`'s network-tap exception
covers the profile reader and nothing else. If the live run shows `jobs.description` (or any
other §7 job column) living only in the rendered DOM — likely, it is the same SPA — the
exception must be extended to the job surface in `DECISIONS.md` and amended into `CLAUDE.md`
before any DOM-reading job code is written (M4 CONTEXT rule 7). The probe itself does not need
this: it archives the snapshot and measures shapes, and reads no job field from it.

## 2026-08-10 — integration, live gate, and four fixes

All five task branches merged to `main` (tasks 21–25, 26–29, 30–31, plus the CDP transport fix,
which was already contained). Worktrees removed, 12 merged branches deleted;
`backup-before-split` and `backup-pre-integration-2026-08-10` deliberately kept. 18 capabilities
present. Nothing pushed — `main` is local.

**Live gate run on the merged tree, then re-run after fixes.** All ten default-flags
capabilities exit 0 with every stored row verified by direct Supabase query. Full write-up,
including what is still untested, at `docs/reports/2026-08-10-live-test.md`.

Four defects found and fixed, three of which produced clean exit-0 receipts while losing data:

- **D320** — a profile is read to its end, not for a fixed number of passes. `profile.get` had
  stored every lead with no employer since 2026-08-08; the sections below Activity are deferred
  containers that never fetch unless scrolled into view. Now 6 experience rows and a resolved
  current-company urn on default flags.
- **D321** — one shared readiness gate, accepting the page's own document. Three runs today
  failed `CAPTURE_TIMEOUT` while holding a fully populated document, because all three readers
  parse the DOM and the gate waited on an API body.
- **D322** — the session's own identity is read from the document island on surfaces that never
  fetch `/voyager/api/me`. The D119 guard had been running with an empty comparison set on the
  activity surface.
- **D323** — the longer job description wins. `job.get` reads a collapsed box and was overwriting
  the full text `company.jobs` had stored.

**D324** records the `first_seen`/`last_seen` inversion as measured write latency, not clock
skew, and left alone.

### Next

1. A second target per surface — a different company and a different profile. One target cannot
   surface parse drift, and drift is what a merge this size would produce.
2. The flag paths: `--no-store`, `--force-release`, `--budget`, resume via `--run-id`.
3. The two open calls in the report: whether freshness should serve a person row with no
   employment, and whether `job.get` should report a truncated description as partial.
4. Tasks 32, 33, 34 remain the operator's.

## Task 37 checkpoint 1 — research complete, live probe blocked before spend (2026-08-11)

`salesnav.savedsearch.list` is in progress on branch
`task-37-savedsearch-list`. Research is recorded in
`docs/plans/m5-l2-salesnav/tasks/task-37-research.md`. **Spend: 0 of 2 page loads,
0 of 0 search pages.** No live contact, parser, fixture, receipt, or storage write
exists yet.

The archived `/sales/` snapshot proves the Saved searches entry is a button with
`data-x--link--saved-searches` and no href; the same run captured no saved-search
payload. The current product instructions also require clicking that control.
D400 permits only pager clicks, so the task stops before live contact rather than
guessing a deep link or writing parse code before a real fixture (D152).

**[DECISION NEEDED]** Either grant the single measured Saved searches button as
a second bounded click class, or refuse it and re-cut Task 37. Recommendation:
grant only the unique enabled `button[data-x--link--saved-searches]` on `/sales/`,
resolved-or-refused and clicked through `HumanCursor`; no child controls and no
other non-pager click inherit the grant.

## Task 37 checkpoint 2 — D408 probe ready, awaiting supervised live run (2026-08-11)

D408 closed checkpoint 1's blocker and D409 replaced the per-click ask with the
standing four-part test. The measured Saved searches control now uses the same
resolved-or-refused trusted-click primitive as the pager: exact selector,
anchored accessible name, `HumanCursor`, wheel reveal and D404's centre-pixel
hit test. The helper was generalized in place; no second click implementation
exists.

The probe-first `salesnav.savedsearch.list` entry point is registered and costs
1 page load / 0 search pages / 0 profile opens. It navigates `/sales/`, spends
before the load, takes the D408 click, archives every response plus the open-panel
snapshot, records the click on the receipt, and deliberately withholds parse rows
until the first real fixture exists (D152). **Spend remains 0 of 2 page loads and
0 of 0 search pages.**

Offline gate: **1688 passed, 14 skipped; typecheck clean.** Mutation checks bite:
disabling the ambiguous-control refusal fails 5 click tests, and moving spend
after navigation fails the named ordering test. Next: operator-supervised default
probe run, promote and meaning-map the measured body offline, then implement the
pure parser and use the second page load for the default end-to-end gate.

## Task 37 checkpoint 3 — two live loads, Account tab measured (2026-08-11)

Two operator-supervised default runs exited 0 with no challenge and the lease
released: `01KZQC4969NN9WQ9CBVPZ6NY1Y` and
`01KZQC6PQAN3ZZ6ZW3T0PXB6XQ`. Each spent exactly 1 page load / 0 search pages;
the task has used **2 of the planned 2 page loads and 0 of 0 search pages**.

Run 1 measured the empty state. The operator then created one saved search and
asked for a positive verification. Run 2 still received an empty 58-byte
`salesApiSavedSearchesV2` envelope because the panel defaults to Lead; its
archived snapshot measured a separate Account tab. It also exposed a probe bug:
29 pending home rails landed after the click cursor and were attributed to the
panel. The capture now drains home traffic before taking that cursor.

The Account tab passes all four D409 parts: it switches only the operator's own
panel, creates no third-party trace, is measured as the unique enabled
`button[role="tab"]` with the full fixed Account accessible name, and has no
href. It is implemented through the same trusted-control helper and records a
second click on the receipt; no live click has been taken yet. A third supervised
load is required to capture the positive body. That makes the real probe spend
3 page loads rather than the task file's planned 2; it must be recorded, not
hidden inside the earlier number.

## Task 38 — parsers and search store path, complete (2026-08-11, offline)

Fixture gate passed before parser work: the promoted leads page 1, leads page 2 and accounts
page 1 bodies are present, and `tests/salesnav-fieldmap.test.ts` reports **17 passed, 0
skipped**. Research is recorded in `task-38-approach.md`; the chosen store rule is append-only
across searches and skip-by-`(search_id,page,position)` within one search (D370/D371).

Spend: **0 / 0 page loads, 0 / 0 search pages**. No LinkedIn contact.

## Complete — Task 38 parsers and search store path (2026-08-11, offline)

`salesnav.leads.list` and `salesnav.accounts.list` now parse the three promoted labeled
bodies with per-vertical identity, bounded rich rows, page/position provenance and
resolved-or-refused identity. Leads key on `objectUrn`; accounts key on the plain
`entityUrn`. Their parser-only CLI entries are zero-cost local refusals until Tasks 39/40
compose the live runners (D372), so discovery remains green without making either command
capable of traffic.

`src/core/store/searches.ts` is the first writer for `searches` and `search_results`.
Definitions are insert-only; provenance is plain-insert append-only across searches and
skip-by-`(search_id,page,position)` within one search, backed by the new unique-index
migration (D370/D371). Existing positions with a different entity refuse rather than
silently keeping the wrong row. Store tests drive real `supabase-js` over loopback
PostgREST and prove the request shape touches neither `persons` nor `companies`.

**Verification:** 1,676 passed; 14 integration tests skipped with explicit `[skip]` messages
because local Supabase credentials are absent. `npx tsc --noEmit` and `git diff --check`
clean. Mutation audit: replacing insert with upsert failed the append-only test; adding a
`persons` insert failed 3 tests including entity isolation; disabling resume skipping failed
the duplicate-position test; swapping both vertical keys failed both meaning checks.

Spend: **0 / 0 page loads, 0 / 0 search pages**. No LinkedIn contact. Next: Task 39 wires
the leads parser/store contract into `runPaged`; Task 40 does the accounts vertical.

## Task 38 review fix — identity refuses a row, content warns (2026-08-11)

Reviewed on merge. One defect fixed in place (D373): both search parsers required every
measured field on every row, so a lead with no location or no current position, and a company
with no description, lost its `search_results` position entirely. Refusal is now identity-only,
matching `company.people`; a missing content field emits `PARSE_FIELD_MISSING` and the row is
stored without it. Three tests added, all mutation-checked. Suite 1679 passing, typecheck clean,
live spend still 0/0.

## Complete — Task 37, saved-search list (2026-08-11, live)

`salesnav.savedsearch.list` now returns the operator's Lead and Account saved
searches from archived `salesApiSavedSearchesV2` bodies. The positive supervised
run `01KZQCS8XZDDYSDGMT5SB81YBS` captured exactly one row in each vertical after
the operator created both: 1,054 Lead bytes and 1,390 Account bytes, no challenge,
exit 0, lease released. D408's panel click and D361's D409 Account-tab click are
both named on the receipt; no row or L3 control was clicked.

**Spend: 3 page loads used against 2 planned; 0 of 0 search pages.** The third
load was not absorbed: run 1 measured the empty list, run 2 showed the saved row
was under the non-default Account tab and measured that tab, and run 3 lawfully
clicked it and captured one row in both verticals. The capability's steady-state
cost remains 1 page load / 0 search pages / 0 profile opens.

The committed fixtures are synthetic and the real bytes stay raw-archived.
`FIELD-MAP.md` pins every body path and the measured people/company
`savedSearchId` routes. Receipts allow the operator-authored labels but expose no
filter value, keyword text, seat data or result-row name (D364). Store identities
are vertical-prefixed (D362). Listing makes zero database writes; D363 mints the
immutable `searches` definition at first execution, at the cost of an existence
check/reuse path in Tasks 39/40 and no database inventory for never-run searches.

**Four review shapes walked.** (1) Every watch is released and the tap drained in
`finally`; spend precedes navigation, click records are appended immediately, and
listing leaves no partial store state. (2) classified lower-layer failures pass
unchanged; a labeled but unparseable body is distinct parse drift, while a valid
empty envelope is success. (3) the 50-row bound, vertical attribution, endpoint
identity, URL meaning and privacy all have named tests; mutations to each failed
before restoration. (4) the capability composes the shared trusted-control helper,
raw archive reader and pure parser in one typed test path rather than forking any
of them.

**Verification:** 1,698 passed, 14 store integrations skipped with explicit
missing-local-Supabase messages; `npx tsc --noEmit` and `git diff --check` clean.
## Task 39 gate B passed on review, with two fixes first (2026-08-11)

Reviewed and completed on merge. Gate B was blocked by a misdiagnosis, not by Task 37: the two
failing runs' own receipts named `Storage.getCookies ... Browser context management is not
supported` — the B5 condition — at 33ms and 49ms, far too fast to have launched anything and
with a protocol error rather than `TAB_LEASE_HELD`.

**Two defects fixed (D410, D411).** `hasLiveTarget` asked whether `/json/list` was non-empty; a
windowless Chrome still lists iframes and browser_ui, so the guard passed and preflight reused a
browser that could not serve one command. It now requires a `page` target. And a resume rebuilt
its arguments from the schema defaults rather than from the run's own `run.json`, which
silently truncated a killed 3-page run and cost the pagination session it needed to finish.

**Gate B, measured.** Fresh 2-page run, hard-killed after page 1 checkpointed, resumed with no
flags at all. Recovered url and `pages`, `respent_pages: []`, exactly 1 new page charged. Ledger
2 search pages for 2 distinct pages. Supabase: 49 rows, 24 + 25, zero duplicate
`(search_id, page, position)`, 49 distinct person urns. `persons`, `companies` and `jobs` all
still 0 rows — entity tables provably untouched.

**Spend: 8 page loads / 8 search pages, exactly the gate's budget of 8**, across run A (2), the
first gate attempt (3 charged, killed on page 3), its resume (0), one refused resume (1), and
the corrected gate (2).

Carried to BACKLOG: the two url-derived refusals fire after the spend because the paged contract
spends before it loads. A `precheck` hook belongs in Task 35's contract, not here.
