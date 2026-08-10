# Task 38 — Leads/accounts parsers + the search store path (offline)

**Model:** Sonnet (re-run on Opus if the review is weak) · **Depends on:** Task 36's
fixtures · **Spec:** §7 (searches, search_results) · **Decisions owned:** D370–D379
**Budget: 0 page loads, 0 search pages.** Pure and offline against committed fixtures.

## Objective

The pure parsers for a leads results page and an accounts results page, and the **first
writers `searches` and `search_results` ever get**. This is the M5 equivalent of Task 14's
person write path: the store contract for searches, settled once, that Tasks 39/40 wire.

**Blocked until Task 36's fixtures exist in the repo (D152).** If they are not on disk,
say so and stop — do not start against the obvious fields, and do not start if Task 36
raised an unresolved DOM-only `[DECISION NEEDED]`.

## Constraints

- **Parsers are pure and tested offline** against the committed fixtures only; a parser
  change is provable with zero LinkedIn requests. One results page in → bounded rows out,
  each row carrying its urn, profile/company URL, page and position, tagged with source
  (labeled-body vs — only if the exception was granted — dom-sourced).
- **The store path, decided and recorded (D370-range):**
  - `search_results` is **append-only** (§7): the same lead in two searches is two rows.
    No upsert, no dedupe across searches; within one search, `(search_id, page, position)`
    identifies a row so a resumed/re-run page does not double-insert *the same page* —
    settle whether a re-loaded page replaces or is skipped, consistent with Task 35's
    resume contract.
  - **A search row never touches an entity table.** No `persons`/`companies` insert, no
    `last_seen` bump — pin this with a test that inserts search results and asserts the
    entity tables are untouched (the D105 discipline: `last_seen` means *complete*).
  - `searches` gets its row per the model Task 37 proposed and the operator approved:
    search_id, kind (`sn_leads`/`sn_accounts`), filter_url, filter_json, created_at.
    Whether it needs a migration beyond the M1–M3 schema (§7 lists both tables — confirm
    they exist and match; if a column is missing, that is a new migration, never an edit
    to an applied one — D99).
- **Real supabase-js against a stub PostgREST on loopback** for the store tests, the Task
  14 discipline — a hand-written fake would let a request shape PostgREST rejects pass.
  Pin the append-only insert shape, the `(search_id, page, position)` identity, and the
  entity-tables-untouched property.
- **No string the database wrote reaches an error message or receipt** (D100) — Postgres
  puts urns into its own error text.
- Reuse the exact exported names in `src/core/store/`; flag mismatches, do not duplicate.

## Deliverables

`src/capabilities/salesnav.leads.list/parse.ts` + `parse.test.ts`,
`salesnav.accounts.list/parse.ts` + `parse.test.ts`; `src/core/store/searches.ts` (or the
existing store module extended) with the append-only writers; any needed migration as a
**new** file; READMEs; decisions D370–D379; `STATE.md` checkpoint.

## Acceptance criteria

- Full offline suite green; typecheck clean; `git diff --check` clean.
- Parser tests pin every FIELD-MAP field with meaning-checked assertions and cover: a full
  page, a short last page, a row whose identity refuses (stored as nothing), and the
  page/position provenance.
- Store tests (real supabase-js/stub PostgREST): append-only insert proven (two searches,
  same lead, two rows), `(search_id, page, position)` re-insert behavior proven per the
  resume contract, and **entity tables untouched** proven — each verified to bite by
  mutation (drop the append-only-ness → a test fails; add an entity insert → a test fails).
- Integration tests skip visibly without local Supabase (the Task 14 `[skip]` pattern).
