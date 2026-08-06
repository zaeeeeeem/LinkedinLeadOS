# M1–M3 Plan — How to Execute

**Date:** 2026-08-08 · **Supersedes:** `docs/plans/2026-08-07-m1-m3-core-storage-profile.md`

The previous plan wrote out full implementations — exact code, pinned versions, invented
names. That forced the implementing agent into transcription instead of thinking, and the
plan's guesses drifted from reality. This plan states **what each task must achieve and
under which constraints**, never how to write the code. The implementation agent designs
the solution with fresh context and current knowledge.

## Plan layout

| File | Role |
|---|---|
| `CONTEXT.md` | What every task agent **reads first**, every time |
| `RECORDING.md` | What every task agent **updates**, every time |
| `tasks/task-NN-*.md` | One task each: objective, constraints, acceptance criteria |

A task agent's full input is: `CONTEXT.md` + `RECORDING.md` + its one task file + the
files those tell it to read. It never needs the whole plan.

## Execution protocol

1. Dispatch a **fresh subagent per task**, on the model in the table below.
2. The subagent reads `CONTEXT.md`, `RECORDING.md`, and its task file, then works
   TDD: failing test → minimal implementation → pass → commit.
3. **Interfaces come from code, not from this plan.** Before using anything a previous
   task built, read its actual source. Plan text never overrides what is on disk.
4. After each task, dispatch a **reviewer** (see below). Fix findings before the next task.
5. Update `STATE.md` at the task's commit, not at session end.

## Task order and dependencies

```
1 scaffold+receipt (DONE) ─┬─► 2 chrome launcher ─► 4 session+tab ─► 8 human input
                           ├─► 3 cdp client ───────┘                 9 network tap (needs 3,4,6,7)
                           ├─► 5 tab lease                           10 challenge (needs 4,9)
                           ├─► 6 events+context                      11 budget (needs 1,6)
                           └─► 7 archive+hash
12 registry+CLI+health.check = M1 gate (needs 2–11)
13 supabase schema (independent) ─► 14 store client
15 capture (DONE; proved the cold-load Voyager dead end — D116/D121)
16 DOM snapshot capture + fixture (needs 15; adds outerHTML snapshot to the cold load; live)
   └─► 17 parser: identity + content, both from the DOM snapshot (needs 16's fixture, 14)
        └─► 19 profile.get end to end = M3 gate (needs 14, 16, 17)
18 log queries (needs 12,14) — independent, anytime after 12
```

Tasks 5, 6, 7 have no dependency on each other and can run in any order after 1.

**2026-08-09 source-of-truth change (D123, then D130).** Live probes proved a cold load of
`/in/<vanity>` carries no content-bearing Voyager response — the content is in the rendered
DOM (D121). D123 decided content from a rendered-DOM snapshot, identity from the Voyager
identity body, both on the existing cold load: no SPA navigation, no Voyager-content probe
(that was theatre over a DOM read for most targets). The tail was re-cut: old Task 16 (parser)
and Task 17 (wire e2e) became Task 16 (DOM snapshot capture + fixture), Task 17 (parser) and
Task 19 (wire e2e, renumbered). Task 18 is unchanged.

**Task 16's live run then falsified the identity half (D126).**
`voyagerIdentityDashProfiles` takes the *operator's own* urn as its input and returns that
member — it cannot return a stranger, and zero of 27 archived bodies carried the subject's
urn. **D130 (operator decision): identity comes from the DOM snapshot too**, from the SDUI
card-ref namespace every profile card agrees on (D127), resolved-or-nothing. The profile
reader now has one source. Task 17 is re-cut accordingly; §7's schema is unchanged because
that namespace yields a real `urn:li:fsd_profile:`.

**Decision-number ranges:** D130 was taken by that operator decision, so Task 17 owns
D131–D139 rather than D130–D139 (D18).

## Model assignment

Split is by **consequence of a silent bug**, not by size. If a Sonnet task's review comes
back weak, re-run the task on Opus — do not hand-patch.

| Model | Tasks |
|---|---|
| **Sonnet** | 1 (done) · 5 tab lease · 6 events+context · 7 archive+hash · 13 schema · 14 store client · 18 log queries |
| **Opus** | 2 chrome launcher · 3 cdp client · 4 session+tab · 8 human input · 9 network tap · 10 challenge · 11 budget · 12 registry+CLI · 15 capture · 16 DOM snapshot capture · 17 parser (identity + content, both DOM) · 19 wire e2e |

## Review protocol

- After every task: a fresh **Opus reviewer** subagent reads the task file, `CONTEXT.md`,
  and the diff. It checks: acceptance criteria met, hard rules respected (especially the
  CDP attach surface and safety rules), tests genuinely test behavior, no scope creep.
- For the safety-critical tasks (4, 9, 10, 11, 12, 15, 16, 19 — the ones that touch the real
  account or the store) the operator may additionally
  run a **second-opinion review with a GPT model** — a different model family catches
  different blind spots. This is the operator's call per task, not automated.
- Reviewer findings are fixed before the next task starts. A finding that reveals a plan
  gap is recorded in `DECISIONS.md` or the task file, not just patched silently.

## Milestone gates

- **M1** = Task 12's live verification passes: launch/reuse Chrome, worker tab, receipt,
  clean teardown, no consent dialog, no leftover tab.
- **M2** = Tasks 13–14: migrations applied, upsert+freshness proven against local Supabase.
- **M3** = Task 17's live verification passes: one real profile captured, parsed, stored,
  receipt correct, budget spent and recorded.

Nothing past a gate starts before the gate is proven against the real account.
