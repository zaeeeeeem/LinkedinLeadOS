# Task 22 — `company.get` end to end

**Model:** Opus · **Depends on:** Task 21 (fixtures + FIELD-MAP + source decision),
Task 14 (store patterns), Task 19 (`profile.get` composition as the template)
**Spec:** §7 companies, §9 · **Decisions owned:** ~~D180–D189~~ **D185–D189** — D180–D182
were taken by Task 21's review round and D183–D184 by its live run (see `DECISIONS.md`
numbering notes)

> **UNBLOCKED 2026-08-09.** Task 21's live run is done and its fixtures are on disk.
>
> *Source verdict from Task 21:* **every §7 `companies` column comes from a captured
> body — no DOM exception is needed for this surface (D184).** `website`, `hq`, `about`
> and `founded` come from the document's own embedded JSON, which D117 already permits;
> `name`, `vanity`, `industry` and the post/people/job fields come from Voyager responses.
>
> Read `docs/capabilities/company-surface-field-map.md` before writing any parse code, and
> note two things it tells you:
>
> 1. LinkedIn's embedded JSON is **not** in a `<script>` tag. It is in Big Pipe data
>    islands, `<code id="bpr-guid-N">`, entity-escaped. `embeddedJsonOf` reads them.
> 2. Four rows are still marked DOM-only and **none of them needs an exception** — they
>    are rendered composites. Read the structured field and format it:
>    `size_range` ← `employeeCountRange.{start,end}`; `hq_full` ←
>    `address.{line1,city,geographicArea,postalCode,country}`; `post_comments` ←
>    `numComments`; `job_posted` ← `listedAt` (epoch ms). Never parse the rendered string.
>
> Run: `01KZKGD683T76H70YA4DMRCRZH` (company/wisprflow, 5 cold sub-page loads, exit 0).

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
