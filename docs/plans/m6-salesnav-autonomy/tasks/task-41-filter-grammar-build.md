# Task 41 — Filter grammar, catalog fixtures, `filters.build`, archive-seeded vocabulary (offline)

**Model:** Opus · **Depends on:** M5 gate (met 2026-08-11) · **Spec:** §9 L2,
"The filter self-test loop" · **Decisions owned:** D420–D429 (check free first)
**Budget: 0 page loads / 0 search pages. Zero LinkedIn contact. This is a hard bound,
not a target.**

## Objective

Turn what M5's archives already measured into typed, tested, offline machinery: the query
grammar as one encoder/decoder, the filter catalog as pinned fixtures, a typed
`FilterSpec`, the pure `salesnav.filters.build` capability, and a vocabulary store seeded
exclusively from bodies and URLs already on disk.

## Source material — all on disk, none of it new spend

- `salesApiSearchFilterLayout` bodies: run `01KZQNM34D61NTBDQNDVSZ45AV` archive
  `0014-3ff85d03efb79a26` (81,800 bytes) and its twin in `01KZQFCFMVYKAC082JXDRVCAN3`.
  46 distinct body types across LEAD and ACCOUNT (44 request-emittable after excluding the two
  aggregate presentation parents), with per-filter capability flags (D423).
- Measured request URLs in the meta files of runs `01KZQFCFMVYKAC082JXDRVCAN3`,
  `01KZQ5TXC23T3FFBJ72P8CE85J`, `01KZP693DEWVP0S90K7C7XQ997`,
  `01KZQNM34D61NTBDQNDVSZ45AV` — entity values, range values with `selectedSubFilter`,
  multi-value lists, `q=savedSearch` form, `trackingParam` placement.
- `salesApiSavedSearchesV2` bodies — resolved `(type, id, displayValue, selectionType)`
  tuples per saved search.
- The M5 salesnav capabilities' own URL code (`findSearchParam` and friends) — read it;
  D412 lives there. Extract/share rather than fork, and do not regress its fix.

## Deliverables

1. **Grammar module** (one place, e.g. `src/core/salesnav-query/`): parse and serialize
   the `query=(…)` s-expression-ish form. Round-trip test against **every** archived
   measured URL through committed, subject-scoped promoted fixtures (operator-owned ids,
   labels, seat and execution-session values scrubbed per D426), byte-identical on the
   promoted query param. Tests must not read the gitignored `runs/` tree. Adversarial encoding tests: commas,
   parens and colons inside `text:`, `+` and `=` inside ids (base64-shaped, the D412
   class), unicode, empty lists, nested `rangeValue`. Decoder rejects — never
   best-efforts — malformed input (exit-5 class when reached from a capability).
2. **Catalog fixtures + FILTER-MAP.md**: promote the filter-layout body (subject-scoped;
   it is operator-seat configuration, so scrub anything operator-identifying per
   D118/D119 and note what was scrubbed). `FILTER-MAP.md` documents, per vertical and
   type: value shape, capability flags, and which archived URL (if any) exercises it.
   Pinning tests assert the catalog's per-vertical type sets and the flags the builder
   validates against. Note the known promoter defect (BACKLOG: DOM-snapshot dedupe) does
   not bite here — these are JSON bodies — but confirm rather than assume.
3. **Typed `FilterSpec`**: vertical (LEAD/ACCOUNT), keywords?, filters as tagged unions
   matching the three measured value shapes, include/exclude per value. Unrepresentable
   states unrepresentable: an exclusion on an `exclusionSupported:false` type must not
   typecheck or must refuse at validation — pick one and test it.
4. **`salesnav.filters.build`** (CLI capability, pure): spec in → validated, fully
   percent-encoded `/sales/search/(people|company)?query=…` URL + a build receipt
   (filters count, vocabulary rows consumed with provenance ids, warnings). Refusals:
   unknown type for the vertical, id absent from vocabulary (names the missing term),
   raw text on a type not measured `rawTextSupported`, malformed range. **No network
   import reachable from its dependency graph — enforce with a test** (import-graph
   assertion, same spirit as Task 40's runner-pin).
5. **Vocabulary store + `salesnav.filters.vocab` (offline CLI)**: schema decision in this
   task's range — a Supabase table vs a committed registry file; walk the trade-off
   (operator-private ids must stay out of git; provenance is mandatory either way) and
   record it. Harvester ingests from archives only: saved-search bodies + measured URLs.
   Seeded content after this task will be small (US region, industry 4, headcount B/C,
   JO1, one persona, CXO titles…) — that is expected; Task 43 is the volume path.
   `vocab` subcommands: lookup by facet + text, list per facet, audit row → source.
6. **README.md** per new capability directory, as always.

## Constraints

- Grammar and builder are parser-grade: pure, fixture-tested, provable with zero
  LinkedIn requests (CLAUDE.md non-negotiable).
- The builder emits nothing the grammar cannot round-trip; `build → decode → spec`
  equality is a property test across generated specs.
- CONTEXT rule 1 (never invent an id) is pinned by a test: a spec whose id has no
  vocabulary row must refuse even when the id "looks right".
- Deliberate mutations, each verified to bite: drop provenance from a vocab row (audit
  fails), double-encode the query (round-trip fails), allow an unknown type through
  validation (refusal test fails).

## Acceptance criteria

- Full suite green from 1,762 baseline plus this task's tests; typecheck clean; zero
  skips.
- Every promoted measured URL round-trips byte-identical; every catalog pinning test
  reads the promoted fixture, not a copy-pasted constant or the gitignored run archive.
- `build` on specs reconstructing the promoted, subject-scoped CXO/accounts evidence emits
  exactly those promoted query strings.
- Ledger untouched: no new spend lines of any kind exist after the task.
