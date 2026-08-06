# Task 19 — Wire `profile.get` end to end — M3 gate

**Model:** Opus · **Depends on:** Task 14 (store, freshness), Task 16 (DOM snapshot capture), Task 17 (parser) · **Spec:** §9, §11 M3, the 2026-08-09 addendum · **Decisions:** D123

> Renumbered from Task 17. The old Task 17 slot is now the parser; wiring the whole
> capability together moves here so it sits after both the capture and the parser it
> composes. Task 18 (log queries) is unaffected and independent.

## Objective

The first complete reader: `profile.get` composes freshness check → cold-load capture (with
DOM snapshot) → parse (identity + content, both from the snapshot — D130) → store → receipt into one capability,
proving M1–M3 end to end on one capability.

## Constraints

- **Freshness first (§7):** store configured + positive max-age + a fresh stored person →
  return it with zero page loads. Cache hits are visible in the receipt (counts, from-cache
  marker, a ready-to-run SQL hint per D3/D4).
- **Live fetch reuses Task 16's capture path** — do not fork a second capture. Then run
  Task 17's parser, upsert (Task 14), and record parser warnings as drift rows so
  `log:drift` has data (D5); skip-store runs still archive and log (D2).
- **Report the single source (D130, superseding D123's identity half).** The receipt makes clear
  identity and content both came from the archived DOM snapshot, so an operator knows every row
  is churn-prone. A DOM-snapshot success is still exit 0, but the source is on the receipt, not
  implied.
- **Failure mapping is exhaustive:** challenge → screenshot, checkpoint, exit 2; dead
  session → exit 4; nothing captured → transient with evidence; the snapshot identity being
  unresolved, matching the session, or the parser yielding no usable person → parse-drift
  class, exit 5, with the snapshot path as evidence. Warnings that did not prevent parsing are
  warnings on an ok receipt.
- The capability README documents flags, cost, failure modes, the source-preference
  behavior, and example queries (RECORDING.md). Integration-style tests stay offline by
  faking the browser seam; live behavior is the gate.

## Deliverables

The `profile.get` capability registered in the CLI with README, drift recording in the
store layer, offline tests for the freshness short-circuit, the source-split reporting,
and the failure mapping.

## Acceptance criteria

- Offline suite green; typecheck clean.
- **M3 gate, live, operator-supervised:** `profile.get` against a real profile returns exit
  0 with a receipt whose counts, cost, stored rows, and **source** are all truthful — person
  and experience rows queryable in Supabase, raw bodies archived, budget ledger shows the
  spend. An immediate second invocation returns from cache with zero page loads. That is
  M1–M3 proven end to end.
- **Discipline gate** — `CONTEXT.md`, "What review actually catches". Partial-failure state
  walked, failures classified against the layer below, every claimed property pinned by a
  test. Sharpest here: the receipt stays truthful when the run half-succeeds — a failure
  after some rows are stored reports what was actually stored (the `partial` field), and a
  receipt never claims a source or a count it did not achieve.
