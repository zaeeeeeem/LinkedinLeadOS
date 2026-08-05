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

## What review actually catches — hold yourself to these before you commit

Tasks 1–10 were all reviewed. Every finding — all of them — was one of four shapes, and
none was a design error, a missed deliverable, or a bug on the happy path. The
implementations do what their task file asks. These three are what the task file *didn't*
ask, so they are asked here once, for every task.

**1. Partial-failure state. What is left behind when step 3 of 5 throws?**

Most findings were this. A field assigned after the work instead of alongside it; a
listener attached too late; a resource claimed and not released on the failing path.

Before you commit, for every operation with more than one step:

- Walk each step and name the state that survives if it throws. A field that is only
  true once the whole operation completes will be read while it is false.
- Every mutable field: say when it is *written* versus when it becomes *true*. Those
  differing is the bug. (`HumanCursor` recorded the pointer position after a whole path
  completed, so a mid-path transport failure left it describing a position the browser
  did not share, and the next call opened with a teleport.)
- Anything acquired must be released on every path out, including the throwing ones.

**2. Failure classification, checked against the layer below.**

`retryable` is what callers branch on, and it splits on one question only: *will a retry
change this?* — never on severity (D13). Two rules:

- Errors already classified by a module you consume pass through **unchanged**. Do not
  re-wrap and re-decide. (Task 4 re-marked a locally-closed tab retryable after Task 3
  had already settled that it is fatal.)
- One code per distinct operator action. If a truncated file and a failed write share a
  code, the receipt cannot tell someone which thing to go fix.

**3. Every property you claim in prose is pinned by a test that names it.**

If the commit message, a doc comment, or `STATE.md` asserts a property, a test proves it
or the sentence comes out. This is not paperwork — the claim being *false* is the usual
outcome. The network tap's message said per-request bookkeeping was capped so an
hours-long run could not leak; the cap was on the wrong map, the one that actually grew
was unbounded, and no test touched either.

Specifically:

- **Every map, buffer, or list that grows gets a stated bound and a test that exceeds
  it.** A bound nothing has ever crossed is a guess.
- **Every silent-loss path is made visible.** If data can be dropped, something records
  it. A response the tap forgot and one that never arrived must not produce the same
  receipt — that is how an operator ends up debugging LinkedIn over a bug in here.
- **A fake that emits sequences the real protocol never produces will certify a bug as
  fixed.** Check your test doubles against what actually happens on the wire.

**4. If you are the first caller of two existing modules together, prove they compose.**

Every task proves its own module offline, and nothing asks anyone to call two finished
modules in the same file. So a mismatch between them survives until some later task
happens to need both, and then it lands as a mid-task blocker on whoever is unlucky.

Task 6's `Screenshotter` accepted `screenshot(path): Promise<void>`; Task 4's
`WorkerTab.screenshot` returns `Promise<string>`. `runContext.screenshot(workerTab, …)`
therefore did not typecheck at all. Both tasks were built, reviewed and merged. Task 10
found it only by being the first code that needed a screenshot *and* a run context —
which is to say, by accident.

So: if your task is the first place two prior modules meet, add a compile-time assertion
that they do (`const _: Consumer = realImplementation`, or a `satisfies`), and verify it
fails when you break it. It costs a line and it is the only thing that will catch this.

Findings of these four shapes are cheap to catch here and expensive to catch in review.
Bring judgment calls to review instead — a real X-over-Y with a defensible case each way
is exactly what review is for, and what `DECISIONS.md` exists to record.

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
