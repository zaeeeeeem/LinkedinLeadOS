# Task 37 — `salesnav.savedsearch.list` (probe + capability, live)

**Model:** Opus · **Depends on:** Task 35 · **Spec:** §7 (searches), §9 L2 ·
**Decisions owned:** D360–D369
**Budget: max 2 page loads, 0 search pages** (the saved-search list is not a metered
search page unless Task 36/this task measures otherwise — if it is, record that and cap
it in Task 35's family sub-caps).

## Objective

List the operator's own Sales Navigator saved searches: for each, its label, its filter
URL, and enough to re-execute it. This is the lowest-risk L2 read (operator's own data)
and it produces the natural live-gate targets for Tasks 39/40 — a real, curated,
re-loadable audience without needing M6's filter builder.

## Constraints

- **Probe + capability in one task**, the Task 32/33 pattern, because it reads the
  operator's own data. Measure the source first (labeled body expected), then build the
  capability against the archived fixture — the probe deliverable is the measurement, the
  capability deliverable is code, in the same task, checkpointed separately.
- **Runs through the runner** with lease, Task 35 ledger, challenge gate, raw-first
  archive. Reuse the proven composition; extend, do not fork.
- **Source discipline:** parse from the captured `salesApi*`/Voyager body if one carries
  the saved searches (measure it). Only if the list lives solely in the DOM does the
  CLAUDE.md exception question arise — `[DECISION NEEDED]`, do not read the DOM for fields
  a body carried (the feed/inbox condition, D325/D326).
- **Receipt privacy, decided here (D360-range):** saved-search *labels* are the operator's
  own words, not a third party's — this task settles whether they may appear on the
  operator's own receipt (recommended: yes, they are how the operator identifies which
  search to run) while result-row names never do (D299). Pin whatever is decided with a
  leak test.
- **Storage decision (`[DECISION NEEDED]`, RECORDING):** `searches` (§7) is the natural
  home but has no writer and Task 38 owns the migration/FK question. This task ends by
  proposing one of: mint `searches` rows now at list time, defer minting to first
  execution (Task 39/40), or archive-only with receipt counts. Do not invent schema; do
  not silently pick.

## Deliverables

The capability (`index.ts`, `parse.ts`, `parse.test.ts`, `README.md`); archived probe
run; committed fixture (redacted if it carries anything private) + FIELD-MAP entry with
pinned paths; the storage `[DECISION NEEDED]`; the receipt-label decision in D360–D369;
`STATE.md` checkpoint with spend used vs budgeted.

## Acceptance criteria

- Offline suite green; typecheck clean; FIELD-MAP paths pinned with meaning-checked
  assertions (label, filter URL, re-execution key).
- Live: one default run, exit 0, no unhandled challenge, within budget, lease released,
  ledger row present, bodies raw-archived before parsing.
- Receipt carries labels (if so decided) and never a result-row third-party name; pinned
  by a leak test.
- Storage `[DECISION NEEDED]` written; nothing invented.
- **Discipline gate** — all four review shapes walked.
