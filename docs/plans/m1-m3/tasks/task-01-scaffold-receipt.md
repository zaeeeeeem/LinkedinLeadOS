# Task 1 — Project scaffold and the receipt contract

**Model:** Sonnet · **Depends on:** nothing · **Spec:** §4 (the contract)

## Status: DONE (commit 1394d12, plus an uncommitted improvement)

TypeScript/vitest scaffold, `src/core/run/receipt.ts`, and `tests/receipt.test.ts` exist.
An uncommitted improvement carries the exit code on the error receipt itself so
`emitReceipt` never has to be told the failure class a second time — commit it.

## What this task produced (the contract later tasks build on)

- The receipt envelope from spec §4.1/§4.2: a fixed-size JSON object on stdout for both
  success and failure — counts, cost, artifacts, warnings; error receipts carry code,
  retryability, a closed `action` enum, and the exit code of their failure class.
- The exit-code table from spec §4.3, exported as one constant.
- An error type each throw site uses to decide its failure class exactly once; receipt
  builders and `emitReceipt` derive everything from it.
- Offline tests proving: ok receipts build correctly, error receipts preserve the failure
  class end to end, and the exit table matches the spec.

Read `src/core/run/receipt.ts` directly for the real names and shapes — it is the
interface contract for every later task.
