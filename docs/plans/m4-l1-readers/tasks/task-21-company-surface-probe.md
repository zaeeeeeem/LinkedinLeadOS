# Task 21 — Company surface probe and fixtures (live)

**Model:** Opus · **Depends on:** Task 20 · **Spec:** §7 (companies, company_posts,
company_people, jobs tables), §9 L1 · **Decisions owned:** D170–D179
**Probe budget: max 6 page loads** (main page + about + posts + people + jobs, one spare).

## Objective

Measure — never assume — where every field the four company capabilities need actually
lives on a real company page family: `/company/<vanity>/` and its about / posts / people
/ jobs sub-pages. Deliver subject-scoped fixtures and a tested FIELD-MAP that Tasks 22–25
build from. This is the Task 15/16 lesson made structural: the probe is its own task with
its own deliverable, so no parser is designed against a guess.

## Constraints

- **Runs through the capability runner** — a probe capability (or a `--probe` face of the
  capture path) with lease, ledger (the new sub-caps), challenge gate, raw-first archive.
  No ad-hoc scripts. Reuse `profile.capture`'s snapshot/scroller machinery; do not fork
  it — extend the existing modules where the surface differs.
- **Capture everything, then sweep offline:** every response body archived, plus a DOM
  snapshot per sub-page after layout settles (D115 discipline: measure this surface's
  real scroller; do not assume `main#workspace`).
- **The sweep answers, per §7 field of all four tables:** present in a Voyager body /
  embedded document JSON (D117's definition) / DOM snapshot only / absent. Company
  identity (`urn:li:fsd_company:<id>`) gets the D126 treatment: prove the candidate urn
  is the *subject's* — check against `sessionUrnsOf`, corroborate across independent
  locations, and check whether SDUI card-refs namespace company cards the way D127 found
  for profiles. Sub-page navigation is also measured: does clicking a tab issue new
  network requests (SPA nav — forbidden territory per D121's history) or is a direct
  cold load per sub-page required? Record which URL form each sub-page needs.
- **Fixtures are subject-scoped (D118/D119):** private endpoints and
  operator-identity-bearing bodies excluded or marked as traps. `fixtures/` stays
  gitignored; the FIELD-MAP and its pinning tests are what land in git.
- **If any required field is DOM-only, end with `[DECISION NEEDED]`** for the operator to
  extend the CLAUDE.md exception to the company surface (CONTEXT rule 7). Tasks 22–25
  stay blocked on that decision.
- Live run is operator-supervised; target is an operator-chosen company already linked
  from the stored M3 profile where possible.

## Deliverables

Archived probe runs; promoted fixtures per sub-page; `FIELD-MAP.md` for the company
family with every path pinned by an offline test; source verdicts written into Tasks
22–25's files; spend used vs budgeted on the STATE.md line; decisions (identity rule for
companies, scroller, sub-page navigation model) recorded in D170–D179.

## Acceptance criteria

- Offline suite green; typecheck clean; every FIELD-MAP path resolves against its fixture
  in a test, with meaning-checked assertions (not shape-only) for name, website, size,
  HQ, about, post text/timestamps, people entries, job entries.
- Live: probe run(s) exit 0, no challenge, within budget, lease released, ledger rows
  present, every body raw-archived before any parsing.
- Identity verdict explicit: how a company subject urn is resolved and refused, proven
  against the fixture including at least one trap (an operator urn or a sidebar/related
  company) that must not resolve.
- **Discipline gate** — all four m1-m3 review shapes walked.
