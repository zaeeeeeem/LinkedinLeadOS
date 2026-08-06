# RECORDING — what every M4 task updates

**`docs/plans/m1-m3/RECORDING.md` applies in full**: `STATE.md` at the task's commit,
commit-message property rule (every asserted property has a test), `DECISIONS.md` in your
task's reserved range, capability READMEs, task-file corrections in the same commit, and
the never-print-captured-data rule. M4 adds:

## Probe tasks additionally deliver

- **`fixtures/<capability-family>/FIELD-MAP.md`** — for each schema field the surface must
  yield: the measured source (`voyager-body` / `embedded-json` / `dom-snapshot`), the
  exact path, and a meaning-checked sample reference (never the captured value itself if
  it is personal data — name the fixture and path instead). Paths that resolve to the
  session's own identity are marked as traps, per D119.
- **A source verdict per capability** written into the *consuming* task files: which
  source carries each field. If any field is DOM-only, the probe task ends with
  `[DECISION NEEDED]` for the operator (CONTEXT rule 7) and the consuming tasks are
  blocked until the decision lands in `DECISIONS.md`.
- **Spend actually used vs budgeted** on the probe's STATE.md line.

## Storage-decision tasks (32, 33)

Feed and inbox have no spec §7 tables. These tasks end with a written
`[DECISION NEEDED]`: store rows (requires a migration the operator approves) or
archive-only with receipt counts. Do not invent schema; do not silently pick.
