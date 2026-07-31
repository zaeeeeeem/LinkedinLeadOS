# RECORDING — what every task updates

Do these **as part of the task**, not after it. A session that dies mid-task must still
leave accurate files behind.

## At every task commit

- **`STATE.md`** — move your task from "In progress" to "Built" (one line: what now
  exists and how it is proven), set the next task under "Next". Update this in the same
  commit as the code.
- **Commit message** — conventional prefix (`feat(core):`, `feat(store):`, `test:` …),
  body says what exists now and names any deliberate deviation from the task file with
  its reason.

  **Every property the body asserts is one a test proves.** If you cannot point at the
  test, cut the sentence — do not soften it. This is not a documentation standard; the
  claim being false is the usual outcome. A tap commit stated that per-request
  bookkeeping was capped so a long run could not leak. The cap was on the wrong map, the
  map that actually grew was unbounded, and nothing tested either. Same rule for
  `STATE.md`: "proven" names what was run.

## When they apply

- **`DECISIONS.md`** — append a dated entry the moment you make a real X-over-Y choice
  the design didn't already settle (new dependency, approach the task file didn't
  anticipate, resolved ambiguity another session could re-litigate). One entry per
  decision, why the alternative lost, never edit old entries.

  **Use your task's reserved number range (D18).** Task N owns `D(10 × (N − 4))` through
  `D(10 × (N − 4) + 9)` — Task 6 owns D20–D29, Task 7 D30–D39, Task 8 D40–D49. Never take
  "the next free number": every parallel worktree reads the same last-used number and they
  all collide (Tasks 5, 6 and 7 each wrote a `D16`). Gaps are expected and fine.
- **Capability README** (`src/capabilities/<name>/README.md`) — required by the task
  files that create a capability: what it returns, its flags, cost, failure modes, and
  example Supabase queries against what it stores.
- **Task file** — if you found the task's stated acceptance criteria wrong or incomplete
  (not merely hard), fix the task file in the same commit and say so in the commit body.

## Never

- Never print captured LinkedIn data into logs, commits, or stdout — receipts and counts
  only. `fixtures/` and `runs/` stay gitignored.
- Never mark a task done in `STATE.md` without its verification actually run and passing.
