# Task 18 — Bounded log queries

**Model:** Sonnet · **Depends on:** Tasks 6, 12, 14 (duration parser) · **Spec:** §5 (log query capabilities), D5

## Objective

The four log-query capabilities from spec §5 — `log:runs`, `log:why`, `log:errors`,
`log:drift` — so the agent debugs from bounded slices instead of reading whole log
files. Debugging costs hundreds of tokens, not hundreds of thousands.

## Constraints

- Each query returns a bounded result: filtered to one run/item, errors-only, grouped
  drift counts, or one-line run summaries within a time window. Never a raw file dump.
- Reads local `runs/` NDJSON and run metadata only — no browser, no LinkedIn, no
  network. These capabilities register with `needsBrowser` off and cost nothing.
- Corrupt log lines are skipped, not fatal — a half-written line from a killed run must
  not break debugging of that exact run.
- Time windows reuse the Task 14 duration grammar (`--since=7d`); drift grouping is by
  capability and field, consistent with what Task 17 records.
- Results small enough to inline in the receipt's data field (D3's fixed-size intent).

## Deliverables

Pure query functions over a runs directory, the four registered capabilities with a
README, and offline tests against synthetic run directories covering: ordered event
readback, corrupt-line tolerance, per-item filtering, errors/warnings-only filtering,
since-window filtering of run summaries, and drift grouping.

## Acceptance criteria

All tests pass offline; typecheck clean; each capability invocable through the CLI and
present in the manifest.
