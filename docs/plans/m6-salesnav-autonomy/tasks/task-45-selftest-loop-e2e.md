# Task 45 — The self-test loop, end to end: intent → converged URL → stored leads (live gate; the M6 gate)

**Model:** Opus · **Depends on:** Tasks 43 + 44 · **Decisions owned:** D460–D469 (check
free first) · **Budget: max 8 search pages / 8 page loads total** — up to 6 apply
iterations plus the final `leads.list` default run (2/2). Fewest-that-proves-it applies:
a loop that converges in 3 stops at 3.

## Objective

Prove the sentence M6 exists for: **starting from a typed audience intent and the
harvested vocabulary — no operator-supplied URL anywhere — the agent converges on an
audience of the right size and `salesnav.leads.list` reads it into provenance-tagged
rows.** This is the first time the system targets autonomously; the gate is deliberately
operator-supervised end to end.

## The loop, as written numbers (settled in D460–D469 before the live run)

- **Intent:** the venture's real one — e.g. US · software · 11–50 headcount · CXO/founder
  titles · posted on LinkedIn recently — agreed with the operator at approval.
- **Bands (proposed, amend at review):** target 300–2,000 `paging.total`; > the ceiling →
  tighten; < the floor → loosen; 0 with all filters honored → loosen the last-tightened
  knob first.
- **Knob order is fixed and recorded** (e.g. geography narrower → seniority narrower →
  headcount wider…), so every iteration's delta is one knob and attributable — the
  iteration table is the future L4 spec (RECORDING.md).
- **Iteration budget: ≤6 applies per session.** A loop that hasn't converged at 6 stops
  and reports; it never "borrows one more".
- **A dropped/rewritten filter verdict halts the loop** — that spec is recorded as
  unbuildable-as-written and the knob it came from is flagged; the loop never proceeds on
  an audience other than the one described.
- **Pacing between applies:** the standard dwell layer, and the whole session respects
  the day's global budget alongside whatever else has run.

## The handoff

The converged URL goes to `salesnav.leads.list` exactly as M5 proved it — default flags,
2 pages, session pinned from the captured request (D413), rows into
`searches`/`search_results` with page/position provenance. **No new code in the handoff
path**: if apply's output needs massaging to be a `leads.list` target, that is a Task 44
defect to fix, not a gate-time adapter. (Accounts symmetry: one optional apply on an
ACCOUNT spec proves the builder's second vertical at +1 page; the full accounts handoff
is not required — leads is the venture's consumer. Record whichever the operator picks.)

## Gate evidence — independent of every receipt

- The iteration table (RECORDING.md shape) with, per iteration: spec delta, built query,
  captured request archive id, per-filter verdict, `paging.total`, running spend.
- Ledger: total `search_page` lines = applies + 2 (leads pages); page loads likewise;
  three-place agreement per M5 practice.
- Supabase: the final `sn_leads` search row and its ~50 `search_results` rows, provenance
  keys unique, `persons`/`companies` deltas 0 (search rows never mint entities).
- Vocabulary audit: every id in the converged spec resolves to a provenance-bearing row.
- The operator can state, reading only the gate write-up, *why* the final audience is the
  size it is — if the write-up can't support that, it is incomplete.

## Constraints

- The agent session drives the CLI; no capability loops internally (CONTEXT rule 2).
- Every apply is separately visible to the supervising operator as it happens; the
  operator can stop the loop at any boundary and that stop is a clean outcome.
- No saved search is created, no list touched, no result row clicked — the loop's only
  actions are build (free) and apply (navigate).
- If the loop surfaces a vocabulary gap, the gate pauses for more Task 43 harvest rather
  than improvising an id — even if that means the gate finishes another day. Pacing wins.

## Acceptance criteria

- One converged loop within the iteration budget **and** the leads.list run on the
  converged URL green with M5-standard verification — or an honest documented stop
  naming exactly which primitive fell short and what measurement is missing.
- Suite green, typecheck clean, all decisions recorded, STATE.md gate section written,
  and the M6 gate checklist in the README checked item by item.
- CLAUDE.md updated post-gate: phase/index lines for M6, the filters family added to the
  capability landscape, and — only if granted during M6 — any D470+ interaction grant
  reflected in the non-negotiable rules. Rule changes are operator-reviewed at merge.
