# Task 11 — Budget ledger

**Model:** Opus · **Depends on:** Tasks 1, 6 · **Spec:** §8 (budget ledger), D11

## Objective

The local spend ledger that stops requests **before they leave the machine** once a
limit is reached. This is the thing standing between us and a burned account.

## Why it matters

The ledger must **fail closed**. Any bug, missing file permission, or clock confusion
that lets a spend through past a limit is the single unacceptable failure mode.
Ambiguity resolves toward refusing the spend.

## Constraints

- File-backed append-only NDJSON at `runs/budget.ndjson` (D11) — it must work when
  Supabase is down, Docker is off, and before storage exists. Never database-backed.
- Tracked spend kinds and default limits from spec §8: page loads per hour (60) and per
  day (400), Sales Nav search pages per day (50), distinct profiles opened per day
  (120). Limits are tunable in config, but **no flag can raise or bypass a limit** —
  a per-invocation budget flag may only lower one.
- Check-before-spend and record-after-spend are separate operations: capabilities check
  the estimated cost in preflight, then record actual spends as they happen.
- Exceeding a limit raises the Task 1 error type with exit 7 and halt-and-notify.
- Windows are rolling (last hour / current day). Entries older than the window fall out
  of the count; the ledger file itself is never rewritten or truncated by this module.
- Spends are also logged as events (Task 6) so receipts and logs agree on cost.

## Deliverables

Ledger open/check/spend/usage operations plus offline tests covering: spend under
limits, ledger lines appended durably, each limit tripping at its boundary with the
right error fields, window expiry (old entries not counted), distinct-profile counting
(the same profile twice in a day is one distinct profile), and a corrupt ledger line
failing closed rather than being skipped toward a lower count.

## Acceptance criteria

All tests pass offline in temp directories; typecheck clean.
