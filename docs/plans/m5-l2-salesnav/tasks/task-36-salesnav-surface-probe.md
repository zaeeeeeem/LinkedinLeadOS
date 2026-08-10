# Task 36 — Sales Navigator surface probe and fixtures (live)

**Model:** Opus · **Depends on:** Task 35 · **Spec:** §7 (searches, search_results),
§9 L2 · **Decisions owned:** D350–D359
**Probe budget: max 6 page loads / 6 search pages** (leads search pages 1–2, accounts
search page 1, saved-search list, plus spares). This is the seat check too.

**Status: done, 2026-08-10** — with one deliverable short, stated rather than absorbed.
`src/capabilities/salesnav.probe/` + `FIELD-MAP.md`, 95 tests, D350–D359, `STATE.md`
checkpointed. **Spent 5 page loads / 3 search pages of 6 / 6.**

Verdicts: **seat yes** (D355) · **rows in a labeled body, so the CLAUDE.md DOM exception
list does not grow** (D350) · **pagination is click-only, `[DECISION NEEDED]`, and page 2
was deliberately not spent** (D351).

**Short: the accounts search is unmeasured.** Its run died on a `CDP_CONNECTION_CLOSED`
fault (2 of 4 runs, undiagnosed, core CDP rather than this surface — see `STATE.md`) and
the daily sub-cap was reached before it could be retried. Tasks 38/40 must treat every
accounts-side field as unmeasured; the leads side is complete.

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
- **Pagination model, measured explicitly (D350-range decision):** how does the UI reach
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
the STATE.md line; decisions in D350–D359.

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
