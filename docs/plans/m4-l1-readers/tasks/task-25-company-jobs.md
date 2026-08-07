# Task 25 — `company.jobs`

**Model:** Sonnet · **Depends on:** Task 21 (fixtures), Task 22 (companies write path)
**Spec:** §7 jobs, §9 · **Decisions owned:** D210–D219

> **Blocked until** Task 21's jobs fixture exists and any DOM-source decision for the
> company surface is recorded. *Source verdict from Task 21:* **not yet measured.** `company.probe` exists and is
> tested (D170–D179), but the live run has not happened, so no field's source is known.
> Do not begin: there is nothing on disk to write a parser against (D152).

## Objective

List a company's open postings into `jobs` (id, company_urn, title, location, posted_at,
workplace_type; description only if the list surface carries it — full detail is Task
31's `job.get`).

## Constraints

- Job identity is LinkedIn's numeric posting id (§7 keys `jobs` on id, not urn) —
  normalize one canonical form from whatever the measured source carries.
- Store only fields the list surface actually provides; a field only the detail page has
  is left null for `job.get` to fill — never scraped-by-inference from the list card.
- Upsert on id with `last_seen`-style bump per the schema; ordering discipline as always.
- Pagination measured, metered, `--limit`-bounded.

## Deliverables

`src/capabilities/company.jobs/` with README; parser + tests; `jobs` write path (shared
with Task 31 — build it here, Task 31 extends it).

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: id canonicalization, a
  list-absent field staying null rather than guessed.
- **Live gate, default flags:** exit 0 against a company with open postings; rows verified
  by independent Supabase query.
- **Discipline gate** — all four m1-m3 review shapes.
