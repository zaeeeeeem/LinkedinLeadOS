# Task 22 — `company.get` end to end

**Model:** Opus · **Depends on:** Task 21 (fixtures + FIELD-MAP + source decision),
Task 14 (store patterns), Task 19 (`profile.get` composition as the template)
**Spec:** §7 companies, §9 · **Decisions owned:** ~~D180–D189~~ **D184–D189** — D180, D181
and D182 were taken by Task 21's review round, D183 by its first live run (see
`DECISIONS.md` numbering notes)

> **Blocked until** Task 21's fixtures exist on disk and, if the surface is DOM-sourced,
> the operator's exception decision is in `DECISIONS.md`. Verify both before writing any
> parse code (CONTEXT rule 1).
>
> *Source verdict from Task 21:* **not yet measured.** `company.probe` exists and is
> tested (D170–D179), but the live run has not happened, so no field's source is known.
> Do not begin: there is nothing on disk to write a parser against (D152).

## Objective

The first company reader: freshness check → cold-load capture → parse → upsert into
`companies` → receipt, composed exactly the way `profile.get` proved.

## Constraints

- **Follow the proven composition** — reuse `profile.get`'s structure (freshness
  short-circuit with zero page loads, capture path reuse, parser purity, drift rows,
  `--no-store` still archiving). Deviations from that template are decisions, not
  improvisations.
- **Parser is pure and offline** against Task 21's fixture; identity resolved-or-refused
  per the company identity rule Task 21 established; every warning a typed exit-5 drift
  class; bounds stated and exceeded by tests.
- **Store path follows Task 14's ordering discipline:** `last_seen` written last, so any
  failure leaves the company stale or absent, never half-written-and-fresh; `first_seen`
  never re-sent; failure classes reuse the existing `STORE_*` codes; no database-written
  string reaches the receipt (D100).
- Company urns normalized to `urn:li:fsd_company:<id>` (the D133-adjacent rule Task 17
  already applies) before any store field.

## Deliverables

`src/capabilities/company.get/` with README (flags, cost incl. the Task 20 sub-cap,
failure modes, SQL recipes); parser + tests; store write path for `companies`.

## Acceptance criteria

- Offline suite green; typecheck clean; parser mutation-verified on at least: identity
  refusal (session/trap urn), a missing required field's drift warning, and one
  truncation bound.
- **Live gate, operator-supervised, default flags:** one real company returns exit 0 with
  truthful counts/cost/source; the `companies` row verified by an independent Supabase
  query; raw bodies archived; ledger shows global + sub-cap spend. Immediate second run
  returns from freshness with zero page loads. If defaults cannot pass, fix defaults
  (recorded as a decision), never bless a flag.
- **Discipline gate** — all four m1-m3 review shapes; sharpest here is partial store
  failure reaching `partial.stored` truthfully.
