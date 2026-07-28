# Task 4 — Browser session and worker tab

**Model:** Opus · **Depends on:** Tasks 2, 3 · **Spec:** §2 D8/D10

## Objective

The session layer: open a connection to the automation Chrome, create the single
resident worker tab, and give capabilities a tab handle that can navigate, evaluate,
screenshot, and manage foreground state.

## Why it matters

**The attach surface is the detection surface.** One stray `Runtime.enable` and the
account is exposed to the classic `consoleAPICalled` leak. This module is the only place
attach decisions are made, so getting it right here protects every capability above it.

## Constraints

- On tab attach, enable the `Network` domain **only**. `Runtime.enable` and
  `Page.enable` are forbidden (D8) — expression evaluation and screenshots both work
  without them.
- One worker tab per session, created in the background so the operator's window is
  never yanked, navigated between targets, closed at session end (D10).
- Focus emulation must be asserted on the tab immediately at creation: a background tab
  is timer-clamped and never fires `IntersectionObserver`, which is exactly how LinkedIn
  lazy-renders (measured: 0.9s becoming 43.9s).
- Bringing a tab to the foreground escalates from least intrusive to most: emulation
  first, activating the target (which steals the operator's window) strictly last.
- Teardown leaves the browser as found: focus emulation dropped, tab closed, connection
  closed. Failures during teardown must not throw past it.
- Page JS errors, navigation failures, and evaluation problems map to the Task 1 error
  type; no raw CDP errors escape to capabilities.

## Deliverables

- Session: open (via Task 2's launcher + Task 3's client), list page targets, create
  the worker tab, close.
- Tab handle: send session-scoped commands, evaluate an expression and return its value,
  navigate, read current URL, screenshot to a file, ensure-foreground with the
  escalation order above, close.
- No unit tests — this is browser orchestration, not logic. It is verified live here and
  exercised for real in Task 12.

## Acceptance criteria

Live check against real Chrome (sandbox-disabled Bash): open session → worker tab on a
neutral site (not LinkedIn) → URL reads back correctly → foreground check succeeds
without pulling the operator's window forward → tab closes, session closes, no leftover
tab, no dialog. Typecheck clean.
