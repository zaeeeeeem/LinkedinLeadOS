# RECORDING — what every M5 task updates

**`docs/plans/m1-m3/RECORDING.md` and `docs/plans/m4-l1-readers/RECORDING.md` apply in
full**: `STATE.md` at every checkpoint, commit-message property rule, `DECISIONS.md` in
your reserved range (checked free first — see the README), capability READMEs, task-file
corrections in the same commit, probe FIELD-MAP deliverables, and the
never-print-captured-data rule. M5 adds:

## Paged-run tasks (36, 39, 40) additionally deliver

- **Per-page spend evidence on the STATE.md line:** ledger `search_page` lines vs
  distinct pages archived vs pages the receipt claims — three numbers, read from three
  places, equal. A gate write-up that quotes only the receipt is incomplete by
  definition (M4 CONTEXT rule 6).
- **Resume evidence (Task 39):** the run id, where the run was killed (page N of M), the
  checkpoint contents at the kill (shape only, never captured data), and proof the resume
  loaded pages N+1..M exactly once — ledger line count and archive listing, not the
  receipt.
- **Challenge markers:** any Sales Nav verdict that classified `unrecognized` gets its
  URL/text marker (marker only, never page content) recorded as a decision, whether or
  not the classifier is extended in that task.

## Storage-decision task (37)

Saved searches have a natural home (`searches`, §7) but no writer yet and an FK
question (Task 38 reads the migration). Task 37 ends with a written `[DECISION NEEDED]`:
mint `searches` rows at list time, at first execution, or archive-only — and whether
saved-search labels appear on receipts. Do not invent semantics; do not silently pick.

## Budget-shape decisions (35)

The sub-cap numbers and the "what does a results page cost" answer (search_page only, or
search_page + page_load) are recorded as decisions in Task 35's range and mirrored into
the §8 table's companion constants — one place, `src/core/budget/constants.ts`, as
always.
