# CONTEXT — read this first, every M5 task

**`docs/plans/m1-m3/CONTEXT.md` and `docs/plans/m4-l1-readers/CONTEXT.md` apply in
full.** Read them now — the reading order, freedom-and-limits, the four review shapes,
and all eight M4 rules (probe-first D152, session-identity checks, measured scrollers,
field-map paths as tests, default-flag gates, receipt-independent verification,
per-surface DOM exceptions, probe spend discipline) still bind every M5 task.

Then read, as always: `CLAUDE.md`, the spec (§7–§9, §11), `DECISIONS.md`, `STATE.md`,
your task file, and **the actual source of every module you consume** — for M5 that
almost always means `src/core/budget/` (sub-caps, spend kinds), `src/core/run/`
(checkpoint/resume), `src/core/tap/`, `src/capabilities/profile.capture/` and the M4
reader compositions you extend.

## The M5 rules — what L2 adds to everything above

**1. Search pages are the scarcest thing you can spend.**

50/day globally (§8), further sub-capped per capability (Task 35). A probe page is 2% of
a day; a 20-page run is 40%. Design every live step to prove its property in the fewest
metered pages that can prove it, state both budgets (page loads *and* search pages) in
your task file, and treat "one more page would be nice" as a checkpoint to record, not a
loop to run.

**2. The paged-run contract is spend → load → archive → checkpoint, in that order.**

Fixed in Task 35, used by everything after: the ledger line for page N is committed
*before* page N is requested; the checkpoint that says "page N done" is written only
*after* page N's bodies are archived; a resume (`--run-id`) verifies completed pages
against the **archive on disk**, not against the checkpoint's own claim, and never
re-spends a page whose bytes exist. A crash may waste a spent page; it must never make
the ledger under-count or a receipt claim a page that has no bytes. Do not re-derive or
"optimize" this ordering in a capability — consume it.

**3. Sales Navigator is the most defended surface this account will ever touch.**

The spec's own example receipt (§4) is a Sales Nav verification interstitial. `/sales/`
is on the challenge allowlist, but the *text and URL markers* of Sales Nav challenges are
unmeasured — expect `unrecognized` halts, and treat each one as D60 working: screenshot,
record the marker as a decision, extend the classifier deliberately. Never weaken
deny-by-default to make a run pass. When a trade-off is between finishing a gate today
and pacing, pacing wins — the account is unburnable.

**4. Pagination is a click on this surface, and that click is granted and bounded.**

Task 36 measured it: the pager renders 12 buttons and 0 anchors, no href carries `page=N`,
and the address bar never produces one (D352). The operator granted the click on
2026-08-11 — **D400, and read it before writing any code that clicks anything.**

The short form: next/previous/numbered controls inside the pager only, located by
accessible name, resolved-or-refused rather than guessed, clicked through `HumanCursor`
(never `element.click()`), brought into view by wheel notches (never `scrollIntoView`),
spent and checkpointed exactly like a navigated page, and **verified from the response
body's `paging.start`/`paging.count` rather than from the button's own label.** Nothing
else on any page is clickable, and none of this touches the rule against forging the
underlying `salesApi*` request (CLAUDE.md).

A url form the UI itself produces would still be a plain navigation and still allowed;
this surface simply does not offer one.

**5. A search row never mints or freshens an entity.**

`search_results` is append-only provenance: search_id, page, position, the urn/URL the
row carried. It never inserts a `persons`/`companies` row and never bumps `last_seen` —
that field is the record's claim to be *complete* (D105), and a search hit read nothing.
Enrichment is L1's job, later, through the readers that actually load the entity.

**6. Third-party names stay off receipts, even in search results.**

D299's rule generalizes: receipts carry counts, urns, page numbers and warnings — never
the names/headlines of the people or companies a search returned. Saved-search *labels*
are the operator's own words and may appear on the operator's own receipts (Task 37
settles this explicitly). Message-text-style leak tests pin whatever rule the task lands.

**7. Expect labeled bodies again — and prove it before relying on it.**

Unlike the SPA profile/job/post/feed/inbox surfaces, Sales Navigator historically serves
`salesApi*` JSON the tap can capture (the reference worker lived on it, and
`profile.capture`/`company.probe` already carry `salesApi*` patterns). If Task 36
confirms that, M5 needs **no DOM exception** and every field comes from captured bodies —
the happy path CLAUDE.md's first rule wants. If any required field turns out DOM-only,
that surface **stops and asks** (M4 CONTEXT rule 7); the exception list in CLAUDE.md is
closed at five and does not grow silently.

**8. The reference worker is a parts donor here more than anywhere.**

`engine/run-scrape.mjs` holds the pagination and resume logic that already survived real
Sales Nav runs. Read it before designing Task 35/39 work; rewrite typed; never import
(CLAUDE.md). Where its behavior and this plan's contract disagree, this plan wins — its
ledger honesty was never this strict.

## Choosing probe and gate targets

Live targets are the operator's call at run time, supervised. Prefer a saved search the
operator already owns (Task 37 lists them) — its audience is real, already curated, and
re-loadable for a resume proof without inventing filter URLs before M6 exists. Keep gate
runs small: the default page count proves pagination with 2–3 pages, never "as many as
the cap allows". Never target a search whose results the operator would mind sitting in
`search_results` — rows are append-only and the archive is forever.
