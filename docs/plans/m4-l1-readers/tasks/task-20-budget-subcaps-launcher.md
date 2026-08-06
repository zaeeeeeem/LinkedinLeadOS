# Task 20 — Per-capability daily sub-caps, and the launcher's empty-context reuse bug

**Model:** Opus · **Depends on:** nothing new (touches Task 11's ledger and Task 2's
launcher) · **Spec:** §8 · **Decisions owned:** D160–D169 · **Backlog closed:** B5

## Objective

Before ten new readers can spend, two pieces of the L0 floor move: the budget ledger
gains per-capability daily sub-caps (D153), and `ensureChrome` stops reusing a Chrome
that has no browser context left (B5).

## Constraints

- **Sub-caps (D153).** Each capability gets a daily cap on its own spend, evaluated
  *in addition to* the existing global limits — a runaway loop on one reader must not be
  able to exhaust the shared 400/day. Defaults live beside the existing limits in
  `src/core/budget/constants.ts`; the §8 override rule is unchanged — an override can
  lower a cap, never raise or bypass one, and the ledger cannot be bypassed by a flag.
  Existing ledger files must keep working: spend records already carry `capability`, so
  no format migration should be needed — verify against a real pre-Task-20 ledger file
  fixture, not only freshly written ones.
- **Exhausting a sub-cap is exit 7** with a receipt naming which cap (global vs
  per-capability) refused — one code per operator action holds; the *evidence* names the
  cap.
- **B5, exactly as settled in `BACKLOG.md`:** on the reuse path only, require
  `GET /json/list` to return at least one target; an empty list falls through to the
  existing launch path. Discovery on the launch path unchanged; attach surface unchanged;
  test fakes an empty `/json/list`.
- Both changes are pure L0 — no LinkedIn request anywhere, all tests offline.

## Deliverables

Sub-cap evaluation in `check()`/`spend()` with defaults and constants; the launcher reuse
guard; `BACKLOG.md` B5 closed with a pointer to the commit; capability README updates
where cost documentation names the new caps.

## Acceptance criteria

- Offline suite green; typecheck clean.
- Tests prove: a sub-cap trips exactly at its boundary while the global limits are
  untouched; the global limit still trips with sub-caps roomy; racing spends against one
  sub-cap land exactly the capped count (reuse Task 11's racing-harness approach); an
  override above a sub-cap default is ignored, below it honored; a pre-existing ledger
  file evaluates correctly.
- Launcher: fake `/json/version` ok + `/json/list` empty → launch path taken; non-empty
  list → reuse, no launch. Verified to bite: reverting the guard fails the test.
- **Discipline gate** — m1-m3 `CONTEXT.md` "What review actually catches", all four
  shapes walked.
