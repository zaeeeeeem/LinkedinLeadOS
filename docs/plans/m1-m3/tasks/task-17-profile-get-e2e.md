# Task 17 — Wire `profile.get` end to end — M3 gate

**Model:** Opus · **Depends on:** Tasks 14, 15, 16 · **Spec:** §9 (profile.get), §11 M3

## Objective

The first complete reader: `profile.get` composes freshness check → capture → parse →
store → receipt into one capability, proving the whole architecture on one capability.

## Constraints

- **Freshness first (§7):** with the store configured and a positive max-age, a fresh
  stored person is returned with zero page loads — the cheapest page load is the one
  never made. Cache hits are visible in the receipt (counts, from-cache marker, a
  ready-to-run SQL hint per D3/D4).
- On a live fetch, reuse Task 15's navigation/capture path — do not fork a second
  capture implementation. Then parse (Task 16), upsert (Task 14), and record parser
  warnings as drift rows so `log:drift` has data (D5); skip-store runs still archive
  and log (D2).
- Every outcome maps to the contract: challenge → screenshot, checkpoint, exit 2; dead
  session → exit 4; nothing captured → transient with evidence; parse producing no
  usable person → parse-drift class, exit 5, with the raw archive path as evidence.
  Warnings that didn't prevent parsing are warnings on an ok receipt, not failures.
- The capability README documents flags, cost, failure modes, and example queries
  (RECORDING.md); integration-style tests stay offline by faking the browser seam —
  live behavior is the gate below.

## Deliverables

The `profile.get` capability registered in the CLI with README, drift recording in the
store layer, offline tests for the freshness short-circuit and failure mapping.

## Acceptance criteria

- Offline suite green; typecheck clean.
- **M3 gate, live, operator-supervised:** `profile.get` against a real profile returns
  exit 0 with a receipt whose counts, cost, and stored rows are all truthful — the
  person and experience rows are queryable in Supabase, the raw bodies are archived,
  the budget ledger shows the spend. An immediate second invocation returns from cache
  with zero page loads. That is M1–M3 proven end to end.
