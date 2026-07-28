# Task 13 — Supabase local and the schema

**Model:** Sonnet · **Depends on:** nothing (pure schema) · **Spec:** §7

## Objective

Local Supabase (Docker) running with the M1–M3 schema migrated: the tables in spec §7,
keyed on LinkedIn's own URNs, ready for the store client.

## Constraints

- Identity is LinkedIn's URN throughout — never a synthesized key (§7). Entity tables
  upsert on URN with first/last-seen timestamps; search results are append-only.
- All tables from the spec §7 table list, with the columns the spec names. Column
  details it leaves open are yours to settle sensibly (types, indexes on the obvious
  lookup paths, foreign keys where they can't lie).
- Two open items from spec §13 are now **decided** (record both in `DECISIONS.md`):
  - schema is `public`, not namespaced — one application, and D4 has the agent writing
    raw SQL; a prefix is friction with no isolation benefit;
  - `person_experience` stores full history, not just current role — it is already in
    the captured response, and re-deriving it later would mean re-scraping, which D2
    exists to avoid.
- Connection secrets go in `.env` (gitignored) with a committed `.env.example`;
  Supabase's local state directories join `.gitignore`.
- The budget ledger is **not** in this schema's trust path (D11) — if you add a mirror
  table for reporting, it is explicitly a mirror.

## Deliverables

Initialized Supabase project config, one migration establishing the schema, env
scaffolding, gitignore updates. Verification is operational, not unit-tested: migration
applies cleanly on a fresh `supabase start`, and a smoke query shows the tables exist.

## Acceptance criteria

`supabase start` + migration apply cleanly from scratch; every §7 table queryable;
`.env` absent from git; decisions recorded.
