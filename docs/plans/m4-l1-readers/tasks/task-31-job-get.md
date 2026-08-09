# Task 31 — `job.get`

**Model:** Sonnet · **Depends on:** Task 30 (fixture), Task 25 (`jobs` write path)
**Spec:** §7 jobs, §9 · **Decisions owned:** D270–D279

> **Blocked until** Task 30's fixture exists and any DOM-source decision is recorded.
>
> **Status 2026-08-09 (from Task 30).** Still blocked, and the blocker is the live run:
> Task 30's offline half (the `job.capture` probe) is committed, but no run has happened,
> so `fixtures/job.get/` is empty. Do not start.
>
> *Source verdict from Task 30:* **not yet measured.** What Task 30 has settled without the
> run, and what this task must therefore honour:
>
> - **Canonical id (D260):** the bare numeric posting id, as a string. `normalizeJobUrl` in
>   `src/capabilities/job.capture/url.ts` is the one implementation — import it, do not write
>   a second. §7's `jobs.id` holds that id; Task 25 writes the same form.
> - **Company urn:** resolve by a path from the FIELD-MAP, never by a regex sweep. Task 30
>   measured that a job page carries other companies ("similar jobs"), so the probe refuses to
>   resolve an employer whenever more than one candidate appears in the subject's own bodies
>   (`COMPANY_URN_UNRESOLVED`). Check every candidate against `sessionUrnsOf`; refuse, never
>   guess.
> - **Description:** the probe reports `data.description.verdict` —
>   `dom-toggle` | `likely-request` | `not-truncated` | `unknown` (D263). `unknown` does **not**
>   mean "no fetch". If the verdict is `likely-request`, the full description is not obtainable
>   passively and that is a `[DECISION NEEDED]` for the operator, not a field to fabricate from
>   the list card.
> - **DOM exception:** if any §7 job column turns out to live only in the rendered DOM, this
>   task stays blocked until `CLAUDE.md`'s exception is extended to the job surface in
>   `DECISIONS.md` (M4 CONTEXT rule 7).

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
