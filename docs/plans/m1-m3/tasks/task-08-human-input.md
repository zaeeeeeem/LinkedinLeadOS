# Task 8 — Human input primitives

**Model:** Opus · **Depends on:** Task 4 · **Spec:** §8 (pacing)

## Objective

Pointer and scroll primitives that are statistically human. A pointer that never
travels, never varies, and never misses is a fingerprint on its own — and bugs here
look perfectly fine in tests while being visible to LinkedIn.

## Constraints

- Mouse movement follows curved multi-point paths with randomized bow and per-point
  jitter, settling **exactly** on the target so hit-testing is unchanged. Never a
  teleport. A corrected overshoot on a minority of moves (~20% in the reference worker)
  is part of the humanity.
- Scrolling dispatches real `mouseWheel` input events in randomized notch sizes
  (reference: 40–120px). Never `scrollIntoView` or JS-driven scrolling.
- No fixed cadence anywhere: inter-step delays are randomized; two moves to the same
  target never replay the identical path.
- The reference worker's `engine/cdp.mjs` established these techniques deliberately —
  read it, port the behavior typed, improve where you can justify it.
- Input dispatches through the Task 4 tab handle, so tests can substitute a recording
  fake and stay fully offline.

## Deliverables

Cursor state + move/click/wheel operations (plus whatever small randomization helpers
they need), and offline tests against a fake tab proving: multi-point paths, exact
settling, path non-repetition, wheel deltas within notch bounds and summing to the
requested distance, and click events dispatched at the settled position.

## Acceptance criteria

All tests pass offline; typecheck clean. No real browser involved in tests.
