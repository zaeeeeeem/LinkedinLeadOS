# Task 5 — Single-holder tab lease

**Model:** Sonnet · **Depends on:** Task 1 · **Spec:** §8 (tab lease)

## Objective

A lockfile-based lease guaranteeing exactly one capability drives the worker tab at a
time. Two concurrent runs on one tab is both a correctness bug and a detection signal.

## Constraints

- The lease is a local file recording at least the holder's run id, pid, capability,
  and acquisition time. No database, no network — it must work when nothing else does.
- A lease whose holder pid is dead, or whose file is corrupt, is reclaimable. A live
  holder is never preempted.
- Acquiring is re-entrant for the same run id, so a resumed run can retake its own lease.
- Release only takes effect when the releasing run actually holds the lease — a stale
  process must not free someone else's.
- A refused acquire raises the Task 1 error type with a transient class and a
  backoff-style action, so callers wait rather than crash.

## Deliverables

Acquire / release / inspect operations plus offline tests covering: fresh acquire,
refusal while held by a live pid, same-run re-entry, dead-pid reclaim, corrupt-file
reclaim, and release by a non-holder being a no-op.

## Acceptance criteria

All tests pass offline in a temp directory; typecheck clean.
