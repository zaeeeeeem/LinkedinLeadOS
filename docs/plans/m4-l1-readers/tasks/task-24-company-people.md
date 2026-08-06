# Task 24 — `company.people`

**Model:** Sonnet · **Depends on:** Task 21 (fixtures), Task 22 (companies write path)
**Spec:** §7 company_people, §9 (`--limit`, `--title=`, `--name=`; returns profile URLs)
**Decisions owned:** D200–D209

> **Blocked until** Task 21's people fixture exists and any DOM-source decision for the
> company surface is recorded. *Source verdict from Task 21:* _to be filled in by Task 21._

## Objective

List people at a company into `company_people` (`company_urn`, `person_urn`,
`discovered_at`), returning profile URLs for downstream `profile.get` calls.

## Constraints

- **This surface is a person-urn minefield** — the people page mixes employees with the
  operator's own connections-at-company framing. Every person urn goes through the
  session-identity check; the association stored is only "this person was listed on this
  company's people page at this time" — never invented titles or inferred current
  employment (that is `profile.get`'s job on the linked profile).
- `--title=` / `--name=` filter only what the page itself returned — they are
  client-side filters over captured data unless Task 21 measured a real
  UI-issued filtered request; **never forge a filtered request the UI did not issue**.
- `company_people` is association-shaped: append/upsert on the pair, `discovered_at`
  preserved on re-discovery (the first-seen discipline of D102 applied to a pair).
- Pagination via measured mechanism, ledger-metered, `--limit` bounding work.

## Deliverables

`src/capabilities/company.people/` with README; parser + tests; `company_people` write
path.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: session-urn exclusion, pair
  re-discovery keeping `discovered_at`, `--limit` as work bound.
- **Live gate, default flags:** exit 0; pairs verified by independent Supabase query;
  returned profile URLs are real `/in/<vanity>` or urn forms usable by `profile.get`.
- **Discipline gate** — all four m1-m3 review shapes.
