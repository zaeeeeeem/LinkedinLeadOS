# CONTEXT — read this first, every task

You are implementing one task of the LinkedinLeadsOS toolkit. Read, in this order:

1. `CLAUDE.md` — what this project is, the hard constraint, the non-negotiable rules.
2. `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md` — the approved design. Your
   task file cites the sections that matter for you; read at least those.
3. `DECISIONS.md` — every decision is binding. Do not re-litigate any of them.
4. `STATE.md` — what is actually built right now.
5. Your task file in `docs/plans/m1-m3/tasks/`.
6. **The actual source code of every module your task consumes.** The code on disk is the
   interface contract. If the task file's description of an existing module disagrees with
   the code, the code wins.

## Your freedom, and its limits

The task file tells you **what to achieve**, not how. You design the implementation with
your own current knowledge:

- **Choose current, stable tooling.** No library version is pinned by the plan. Check what
  is current when you install; prefer boring and stable over new and clever.
- **If you know a more accurate or better-optimized approach than the task file implies,
  use it** — provided every constraint and acceptance criterion still holds. Note what you
  did differently and why in the commit message.
- **Major deviations need approval.** Stop and ask the operator before: adding a runtime
  dependency, changing a cross-task interface another task already consumes, anything that
  touches the CDP attach surface or safety model, or replacing an approach a `DECISIONS.md`
  entry explicitly chose. Present the trade-off, wait for the answer.
- **Never invent parallel names.** Reuse the exact exported names that exist in code. If a
  name in the task file does not exist on disk, the code's name is correct — flag the
  mismatch, don't create a duplicate.

## Hard rules that most often decide a task

All rules in `CLAUDE.md` apply. These are the ones tasks trip over:

- One LinkedIn account, unburnable. Safety beats speed, always.
- Network tap is the source of truth; DOM only for navigation, pagination state, challenge
  detection, render confirmation (D1). Never forge a request the UI didn't issue.
- Archive raw before parsing (D2). Receipt on stdout, bulk data in the store (D3).
- CDP: enable `Network` only. Never `Runtime.enable`, never `Page.enable` (D8). No
  Playwright (D7).
- Automation Chrome = port 9223, profile `~/.linkedin-os/chrome-profile`, discovery via
  `GET /json/version` → `webSocketDebuggerUrl` (D9). Port 9222 is the operator's personal
  Chrome — never touch it.
- All tests run offline. Anything that would touch LinkedIn or a live browser in a unit
  test is a design error; live verification is its own explicit step.
- The budget ledger cannot be bypassed by a flag. Challenges are never solved
  automatically.
- Exit codes: `0` ok · `2` challenge · `3` rate-limited · `4` auth dead · `5` parse drift
  · `6` transient · `7` budget exhausted · `1` anything else.

## Environment gotchas (verified 2026-08-07)

- Chrome 151 rejects the bare `ws://…/devtools/browser` path; only `/json/version`
  discovery works. The `DevToolsActivePort` file is not reliably written.
- Claude Code's Bash sandbox blocks loopback TCP — probing CDP from Bash needs the sandbox
  disabled for that call.
- A background tab is timer-clamped and never fires `IntersectionObserver` (LinkedIn
  lazy-renders on it) unless focus emulation is asserted; the reference worker measured a
  0.9s wait becoming 43.9s in that state.

## Reference code (parts donor, never imported)

`/Users/talhat/Claude/Projects/OwnexLabsSales/dashboard/worker` — read for proven
technique, rewrite typed. Relevant: `engine/cdp.mjs` (human cursor, wheel notches, passive
capture, focus emulation), `engine/page-scripts.mjs` (DOM helpers),
`engine/run-scrape.mjs` (pagination, resume).
