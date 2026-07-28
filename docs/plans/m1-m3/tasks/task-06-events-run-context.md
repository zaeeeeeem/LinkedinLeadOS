# Task 6 — Event logger and run context

**Model:** Sonnet · **Depends on:** Task 1 (Task 4's tab handle for screenshots) · **Spec:** §5

## Objective

The run-scoped observability spine: an append-only NDJSON event log, and a run context
owning the run's identity, directory tree, checkpoints, and artifacts.

## Constraints

- Events are one JSON object per line with a timestamp, a monotonically increasing
  sequence number, a level defaulting to info, and an event name from the **closed set
  in spec §5** — no free-form event names.
- A run's directory layout follows spec §5: persisted receipt, events file, raw capture
  directory, screenshots directory.
- Run ids are sortable unique ids (the spec uses ULIDs). Creating a run records its
  capability and args on disk so a later session can tell what the run was.
- Resume: reopening an existing run id reuses its directory, sees its prior checkpoint,
  and marks itself resumed; resuming a nonexistent run id is a usage error, not a silent
  create.
- Checkpoints round-trip arbitrary JSON state; the latest checkpoint wins.

## Deliverables

The logger and the run context with create / resume / checkpoint / screenshot /
elapsed-time / artifact-paths / finish, plus offline tests covering: NDJSON line shape
and sequencing, level defaulting, directory creation, checkpoint round-trip, resume
seeing prior state, nonexistent-resume rejection, and run metadata on disk.

## Acceptance criteria

All tests pass offline in temp directories; typecheck clean. `runs/` remains gitignored.
