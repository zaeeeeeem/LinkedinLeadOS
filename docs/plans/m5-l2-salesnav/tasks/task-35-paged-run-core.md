# Task 35 — Paged-run core: spend/checkpoint/resume contract + salesnav sub-caps (offline)

**Model:** Opus · **Depends on:** nothing (offline; zero LinkedIn contact) ·
**Spec:** §5 (runs, resume), §8 (ledger, pacing), §11 M5 · **Decisions owned:** D340–D349,
**taken as D342–D349** — D340 and D341 were already used by Task 34 and the reactions work,
per the README's "check `DECISIONS.md` before assuming your range is free".

**Status: done, 2026-08-10.** `src/core/paged/` + `src/core/paged/README.md`, sub-caps in
`src/core/budget/constants.ts`, 66 tests, D342–D349, `STATE.md` checkpointed. Two stated
deviations from the acceptance criteria below, both recorded as decisions rather than
absorbed silently — see D348 (orphaned bytes) and D347 (the unattributable ledger line).
**Budget: 0 page loads, 0 search pages.** Anything live in this task is a design error.

## Objective

Give L2 the one thing L1 never needed: a **paged capture loop** whose ledger honesty
survives a crash at any step, consumed by Tasks 36/39/40 rather than re-invented in each.
Plus the budget shape for the salesnav family. This is Task 20's role for M5: the caps
and the contract exist before any new reader can spend.

## The contract (the headline decision, recorded in your range)

For each page N of a paged run: **(1) spend** — commit the ledger line(s) for page N;
**(2) load** — navigate/scroll to page N; **(3) archive** — raw bodies on disk;
**(4) checkpoint** — record page N complete, with enough to find its archive entries.
A resume via the existing `--run-id` path reads the last checkpoint, **verifies completed
pages against the archive on disk** (not the checkpoint's claim alone), and continues at
the first unproven page without re-spending proven ones.

Direction of failure is part of the contract: a crash between (1) and (3) wastes a spent
page; no interleaving may ever produce an unpaid load, an under-counting ledger, or a
receipt claiming a page with no bytes. Walk review shape 1 (partial-failure state)
explicitly for every step boundary and name what survives.

## Constraints

- **Build on what exists; do not fork it.** `RunContext.checkpoint()` /
  `lastCheckpoint()` / resume, the `RawArchive`, the ledger's `spend()` and sub-caps are
  the proven pieces. This task composes them into a reusable paged-loop module under
  `src/core/` — it does not add a second checkpoint mechanism or a second ledger path.
  The ledger's own semantics (lockfile, compaction, override-only-downward) are
  untouched.
- **Decide and record what a results page costs.** Recommendation to start from: one
  `search_page` **and** one `page_load` per results page — double-counting toward the
  global caps is the conservative direction and matches how every M4 capability's
  `cost()` already reports both kinds. Whatever is decided lands as a decision and in
  every M5 `cost()` uniformly.
- **Sub-caps for the family** in `CAPABILITY_SUB_CAPS` (D153 pattern). Proposed for
  operator approval, deliberately well under the 50/day global: `salesnav.leads.list` 20
  search pages/day · `salesnav.accounts.list` 10 · `salesnav.probe` (Task 36's face) 6 ·
  `salesnav.savedsearch.list` 0 search pages (page loads only) until Task 37 measures
  otherwise. Numbers are settleable at plan approval; the *existence* of a sub-cap per
  capability is not.
- **Resume never trusts a checkpoint it can't corroborate.** A checkpoint naming an
  archive entry that does not exist on disk marks that page unproven and re-runs it —
  after spending for it again. Say so on the receipt (`RESUMED_PAGE_RESPENT` or similar)
  rather than silently eating it.
- **Budget exhaustion mid-run is a clean stop, not a failure:** exit 7, checkpoint
  intact, resume-able after the window — the partial results already archived stay
  claimed by the checkpoint and are not re-spent later.
- **Read the reference worker first** — `engine/run-scrape.mjs` pagination/resume and
  `engine/cdp.mjs` pacing (read, rewrite typed, never import). Take its inter-page dwell
  discipline: randomized delays, no fixed cadence (§8). Where it disagrees with this
  contract, this contract wins.
- Pure and offline: fake paged sources, temp dirs, zero browser.

## Deliverables

The paged-loop module + tests; sub-cap entries; decisions (contract, page cost, sub-cap
numbers, resume-respend semantics) in D340–D349; `STATE.md` checkpoint; a short module
README stating the contract so Tasks 36/39/40 cite it instead of rediscovering it.

## Acceptance criteria

- Offline suite green, typecheck clean, full suite green.
- Kill-anywhere test: a fake run killed between **every adjacent pair of steps** for a
  3-page run, resumed, converges to exactly one archived copy of each page and a ledger
  whose `search_page` count equals pages loaded (including the deliberately-wasted spend
  case, which is asserted as *present*, not absent).

  **As built, with the deviation stated:** 24 scenarios (8 boundaries × 3 pages), each
  converging to exactly one **claimed** copy per page, every byte on disk either claimed by
  exactly one page or declared an orphan. Literal "one archived copy" fails only where a
  kill lands part-way through archiving — those bytes are kept and reported, never deleted
  (D348). The ledger assertion is `pages + wasted ≤ count ≤ pages + wasted + unconfirmed`,
  because a crash *inside* the spend phase leaves one line attributable to nothing (D347).
  Over-counting only; never under.
- Mutation checks, each verified to bite: remove the re-spend guard on resume (a test
  must fail on double-charging), reorder spend after load (a test must fail on the
  unpaid-load interleaving), make resume trust the checkpoint without the archive check
  (a test must fail on the missing-bytes case).
- Budget-exhaustion path: exit 7 mid-run leaves a resume-able checkpoint; proven by test.
- Sub-caps proven the D153 way: a capability at its own cap is refused while the global
  budget still has room, and the refusal is exit 7 with the cap named.
