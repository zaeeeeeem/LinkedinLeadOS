# Task 36 — Sales Navigator surface probe and fixtures (live)

**Model:** Opus · **Depends on:** Task 35 · **Spec:** §7 (searches, search_results),
§9 L2 · **Decisions owned:** D351–D360 (the file said D350–D359; D350 was taken at Task 35's
merge, so the block shifted by one — next free number wins)
**Probe budget: max 10 page loads / 10 search pages** — raised from 6/6 on 2026-08-11
(D401). This is the seat check too.

**Status: done, 2026-08-10; reviewed and amended 2026-08-11.**
`src/capabilities/salesnav.probe/` + `FIELD-MAP.md`, D351–D360, `STATE.md` checkpointed.
**Spent 5 page loads / 3 search pages** on the measuring run.

Verdicts: **seat yes** (D356) · **rows in a labeled body, so the CLAUDE.md DOM exception
list does not grow** (D351) · **pagination is click-only** (D352).

**What the 2026-08-11 review changed**, on top of the measurement above:

- **The click is granted (D400)** and implemented, in `pager.ts`: page 2 is reached by
  pressing the pager's next control, resolved-or-refused, through `HumanCursor`. D352's
  `[DECISION NEEDED]` is closed and Tasks 39/40 are unblocked.
- **Which page arrived is read from the body** (`paging.start`/`paging.count`), never from
  the pager's label; a clicked page with no advanced offset raises `PAGE_DID_NOT_ADVANCE`.
- **A defect in the source verdict, fixed.** `sourceVerdict` counted the surface's own
  document response, so a page whose rows were server-rendered markup would have been
  reported as "rows in a labeled body" — skipping the one `[DECISION NEEDED]` the verdict
  exists to raise. It now excludes the document. The recorded 2026-08-10 verdict is
  unaffected: that run captured a real 154 KB `salesApiLeadSearch` body.
- **The budget rose 6/6 → 10/10** (D401), and the whole D351–D360 block shifted by one from
  the D350–D359 the branch was written against, because D350 was taken by Task 35's merge.

**Proved live 2026-08-11** (`01KZQ4S9FYEB5NCBPQC8FZSGK5`, exit 0, 2 loads / 2 search pages):
the click reaches page 2, the body confirms it (`paging.start` 0 → 25), the `sessionId` holds
across it, and **both lead-search fixtures, page 1 and page 2, are promoted** — the leads-side
deliverable this task was short of. The first attempt refused on a defect in the reveal rule,
now replaced by a hit test (D404).

**The accounts search is measured (2026-08-11, `01KZQ5TXC23T3FFBJ72P8CE85J`, exit 0, 1 load /
1 search page)**, on an operator-supplied company-search url — the one input the probe may not
invent (D357). Rows are in a labeled body here too, so the DOM exception list stays closed at
five for the whole family. Two findings Task 38 needs: the **dedupe key is per vertical** —
an account row has no `objectUrn` and a plain `entityUrn`, the inverse of D354 (D406) — and
`location` is not an account-row field at all, which is entity data for an L1 reader rather
than a DOM-exception case.

**Task 36 is complete.** Every deliverable it was short of has landed: leads page 1, leads
page 2 and accounts page 1 are all promoted fixtures with pinning tests.

Still open, and named rather than absorbed: **accounts page 2** (the probe has no `accounts2`
surface; nothing suggests it differs, which is not the same as having looked) and **a second
leads target** for parse drift.

## Objective

Measure — never assume — where every field the leads and accounts capabilities need
actually lives on a real Sales Navigator search, and **how the real UI reaches page 2**.
Deliver subject-scoped fixtures and a tested FIELD-MAP that Task 38 builds from. The
Task 15/16/21 lesson made structural: the probe is its own task with its own deliverable.

## The seat check (first, cheap, honest)

The first page load hits `/sales/`. It either renders the Sales Navigator app or an
upsell/paywall page. If it is an upsell page, **stop with `[DECISION NEEDED]`**, spend 1,
no retry: M5 as written needs a seat and the operator decides whether to acquire one or
pivot M5 to the classic search family. Do not attempt to work around a missing seat.

## Constraints

- **Runs through the capability runner** — a `salesnav.probe` capability (or a `--probe`
  face) with lease, the Task 35 ledger/sub-caps, challenge gate, raw-first archive. No
  ad-hoc scripts. Reuse `profile.capture`/`company.probe` snapshot/scroller machinery;
  extend where the surface differs, do not fork.
- **Capture everything, then sweep offline:** every response body archived, plus a DOM
  snapshot per surface after layout settles. Measure this surface's real scroller (D115
  discipline — Sales Nav has its own scroll container; do not assume `main#workspace`).
- **The sweep answers, per §7 field of `searches` and `search_results`, and per L2
  result-row field (profile URL, company URL, name/title/company for provenance):**
  present in a `salesApi*` / Voyager body / embedded document JSON (D117) / DOM snapshot
  only / absent. **This is the fork in the whole milestone:** if the result rows live in
  captured `salesApi*` bodies (expected — the reference worker lived on them), M5 needs
  no DOM exception and Task 38 parses bodies. If any required field is DOM-only, end with
  `[DECISION NEEDED]` to extend the CLAUDE.md exception to the Sales Nav surface (CONTEXT
  rule 7 / M4 CONTEXT rule 7) — the list is closed at five and Task 38 stays blocked
  until that decision lands.
- **Pagination model, measured explicitly (D351-range decision):** how does the UI reach
  page 2 — a URL the address bar produces (cold-loadable, allowed), or a script-only
  control (a *click* — a new class of action needing its own operator decision, the D323
  precedent)? Record the exact URL form or the exact control, anchored on a stable
  attribute (`data-testid`/`data-anonymize`/`aria`), never LinkedIn's per-build hashed
  classes. Also measure: does the results body carry a total count and a next-page
  cursor/offset the paged loop can key on?
- **Identity the D126 way:** prove a result row's `person`/`company` urn is the row's
  subject, not the operator's or a UI chrome urn — check against `sessionUrnsOf`,
  corroborate across locations. A row whose identity resolves only to the session or to
  nothing stores nothing.
- **Fixtures are subject-scoped (D118/D119):** operator-identity-bearing bodies and
  private endpoints excluded or marked traps. `fixtures/` stays gitignored; the FIELD-MAP
  and pinning tests land in git. **No third-party name reaches the receipt or a commit**
  (D299 generalized).
- Live run operator-supervised; target an operator-chosen saved search (Task 37 can list
  them, or the operator supplies a URL) so the audience is real and re-loadable.

## Deliverables

Archived probe runs; promoted fixtures (leads page 1 + page 2, accounts page 1); a
`FIELD-MAP.md` for the salesnav family with every path pinned by an offline test and
meaning-checked samples (never the captured value if personal); the pagination-model and
source verdicts written into Task 38's and Tasks 39/40's files; spend used vs budgeted on
the STATE.md line; decisions in D351–D360.

## Acceptance criteria

- Offline suite green; typecheck clean; every FIELD-MAP path resolves against its fixture
  in a test with meaning-checked assertions (result-row urn, profile URL, company URL,
  the total count, the next-page key).
- Live: probe run(s) exit 0 (or a clean `[DECISION NEEDED]` seat/DOM/click stop), no
  unhandled challenge, within budget, lease released, ledger rows present, every body raw-
  archived before any parsing.
- Pagination verdict explicit: the measured way to page 2, with the exact URL form or the
  exact stable-attribute selector, and whether it is a navigation or a click.
- Identity verdict explicit: how a result-row subject urn is resolved and refused, proven
  against the fixture including at least one trap that must not resolve.
- Source verdict explicit: labeled-body vs DOM-only, per required field, with the
  `[DECISION NEEDED]` raised if any field is DOM-only.
- **Discipline gate** — all four m1-m3 review shapes walked.
