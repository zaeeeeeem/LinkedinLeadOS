# M4 Plan — The Rest of L1, Probe-First

**Date:** 2026-08-09 · **Spec:** `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`
§9 (L1 table), §11 M4 · **Approved by operator 2026-08-09.**

M4 delivers the remaining eleven L1 readers: `profile.posts`, `profile.activity`,
`company.get`, `company.posts`, `company.people`, `company.jobs`, `job.get`, `post.get`,
`feed.get`, `inbox.list`, `inbox.thread` — against the core M1–M3 proved on `profile.get`.

## Why this plan is shaped the way it is

Every expensive M1–M3 failure had one shape: **a task built on an assumed LinkedIn data
shape, falsified later by the real page.** The profile parser was planned twice against
Voyager JSON that does not exist on a cold load (D116, D121); the identity source was
falsified by its own first live run (D126 → D130); the scroll model assumed the document
scrolls when the real scroller is an inner element (D115); the fixture promoter shipped the
operator's own inbox as "the subject" (D118/D119). Every task that started from a live
measurement landed; every task that started from an assumption was re-cut.

So M4 makes the sequence that finally worked (Task 15 → 16 → 17 → 19) **mandatory and
structural** (D152):

1. **Probe task per page surface, live, first.** Archive every response body and a DOM
   snapshot, measure where each schema field actually lives, promote subject-scoped
   fixtures, commit a FIELD-MAP whose every path is pinned by a test against the fixture.
2. **Parser + store tasks, pure and offline,** one per capability, against those fixtures
   only. A parser task whose fixture does not exist in the repo **must not start**.
3. **Wire + live gate task** on real targets with **default flags**, verified by
   independent Supabase queries — never by the receipt alone.

## Plan layout

| File | Role |
|---|---|
| `CONTEXT.md` | What every task agent **reads first** — includes the m1-m3 CONTEXT by reference, adds the M4 probe-first rules |
| `RECORDING.md` | What every task agent **updates** — the m1-m3 RECORDING plus probe deliverables |
| `tasks/task-NN-*.md` | One task each: objective, constraints, acceptance criteria |

## Task order and dependencies

```
20 budget sub-caps + launcher B5 fix (offline; unblocks nothing but caps everything)
21 company surface probe (live) ─► 22 company.get ─► 23 company.posts
                                                  ─► 24 company.people
                                                  ─► 25 company.jobs
26 person-activity surface probe (live) ─► 27 profile.posts
                                        ─► 28 profile.activity
                                        ─► 29 post.get
30 job surface probe (live) ─► 31 job.get
32 feed.get   (probe + capability in one task — operator's own data)
33 inbox.list + inbox.thread (probe + capability in one task — operator's own data)
```

- Task 20 first — the sub-caps must exist before any new reader can spend.
- 22–25 depend on 21's fixtures; 27–29 on 26's; 31 on 30's. Within a family, the `.get`
  task goes first because it establishes the entity write path the siblings reference.
- Surface families are independent of each other and may run in parallel worktrees,
  **but live runs are serialized by the tab lease and the budget ledger as always** —
  parallelism is for offline work only.
- 32 and 33 are last: they read the operator's own data (lowest novelty risk) and spec §7
  defines **no tables for feed or inbox** — each ends with an explicit storage decision
  for the operator rather than an invented schema.

## Decision-number ranges

Task N owns `D(10 × (N − 4))` through `D(10 × (N − 4) + 9)` (D18): Task 20 → D160–D169,
Task 21 → D170–D179 … Task 33 → D290–D299. Plan-level decisions taken at approval time are
D152 (probe-first mandatory) and D153 (per-capability daily sub-caps).

## Model assignment

Split by consequence of a silent bug, as before. Every probe task and every live gate is
Opus; pure parsers over committed fixtures may be Sonnet.

| Model | Tasks |
|---|---|
| **Opus** | 20 (ledger + launcher are safety surfaces) · 21 · 22 · 26 · 30 · 32 · 33, and every task's live gate step |
| **Sonnet** | 23 · 24 · 25 · 27 · 28 · 29 (pure parser + store over existing fixtures; e2e wiring reuses the proven `profile.get` composition) |

If a Sonnet task's review comes back weak, re-run on Opus — do not hand-patch.

## Review protocol

Unchanged from m1-m3: fresh Opus reviewer per task against the task file, `CONTEXT.md`
and the diff; findings fixed before the next task; second-opinion GPT review at the
operator's call for tasks touching the real account (here: 21, 22, 26, 30, 32, 33 and
every live gate).

## Milestone gate

**M4 gate** = all eleven capabilities have each passed, live and operator-supervised:
one run at default flags, exit 0, receipt truthful, rows verified by an independent
Supabase query (where a table exists), raw bodies archived, ledger showing the spend —
and an immediate second run of the cacheable readers returning from freshness at zero
page loads. Nothing in M5 starts before this gate.
