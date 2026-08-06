# Task 31 — `job.get`

**Model:** Sonnet · **Depends on:** Task 30 (fixture), Task 25 (`jobs` write path)
**Spec:** §7 jobs, §9 · **Decisions owned:** D270–D279

> **Blocked until** Task 30's fixture exists and any DOM-source decision is recorded.
> *Source verdict from Task 30:* _to be filled in by Task 30._

## Objective

Full job posting detail into `jobs`, extending the row Task 25 may have created from the
company jobs list — filling the description and any detail-only fields.

## Constraints

- Parser pure and offline against Task 30's fixture; the description field is the point —
  store what the detail source carries, refuse to fabricate from the list card.
- Upsert on the canonical job id; a `job.get` after a `company.jobs` list enriches the
  same row (merges description in) rather than creating a duplicate — prove the merge.
- Company urn normalized and resolved-or-refused; ordering discipline as always.

## Deliverables

`src/capabilities/job.get/` with README; parser + tests; the `jobs` enrichment write path.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: description presence, the
  list→detail merge on one id (no duplicate row), company-urn refusal on a session/trap urn.
- **Live gate, default flags:** exit 0 against a real posting; the enriched row verified
  by independent Supabase query showing the description populated.
- **Discipline gate** — all four m1-m3 review shapes.
