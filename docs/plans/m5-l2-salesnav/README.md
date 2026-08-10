# M5 Plan — L2 Sales Navigator, Paged and Resumable

**Date drafted:** 2026-08-10 · **Spec:** `docs/specs/2026-08-07-linkedin-toolkit-l0-l2-design.md`
§7 (searches, search_results), §8 (search-page budget, pacing), §9 (L2 table), §11 M5.
**Status: DRAFT — pending operator approval.** Nothing here runs live before approval.

M5 delivers the Sales Navigator readers: `salesnav.savedsearch.list`,
`salesnav.leads.list`, `salesnav.accounts.list` — plus the two pieces of core they force
into existence: the **paged-run contract** (per-page spend, checkpoint after every page,
resume that never re-spends) and the **search store path** (`searches` +
`search_results`, the first writers those tables get).

## Scope cuts, stated up front

- **`salesnav.filters.build` / `filters.apply` are M6**, per spec §11 — they are the
  self-test loop, not the readers.
- **`classic.search.people` / `classic.search.companies` / `classic.search.posts` /
  `jobs.search` are deferred out of M5.** They are a different surface family needing
  their own probe, and nothing in M5 depends on them. Where they land (M5b or alongside
  M6) is the operator's call at approval; recorded then, not silently assumed.
- **L3 writes stay out**, as always. Nothing in M5 clicks Connect, saves a lead, or
  touches a list. If pagination itself turns out to require a *click* rather than a
  navigation, that is a `[DECISION NEEDED]` (the D323 precedent), not an implementation
  detail.

## Preconditions — checked before any M5 live work

1. **A Sales Navigator seat on the automation account.** `BACKLOG.md` B1 exists because a
   *borrowed* seat was once the expectation. If the automation account has no active
   seat, M5 as written cannot run and pivots to the classic search family instead —
   an operator decision, not an agent improvisation. Task 36's first page load doubles as
   the honest check: `/sales/` either renders the app or an upsell page, and an upsell
   page ends the task with `[DECISION NEEDED]`, spend 1, no retry.
2. **M4 residuals.** Task 34 (`post.get` author write path — zero page loads) is queued
   and does not block M5; land it whenever. The 2026-08-10 live-test report's open items
   (second target per surface, flag-path exercises) gate nothing offline here, but the
   operator either completes or explicitly waives them before Task 39's live gate — a
   resume bug and a parse-drift bug look identical from a receipt.
3. **Plan approval records the plan-level decisions** in `DECISIONS.md` (next free
   numbers): probe-first stays mandatory for L2 (D152 extended), the paged-run spend
   contract (Task 35's headline), the M5 sub-cap numbers, and the
   search-rows-never-mint-entities rule (below).

## Why this plan is shaped the way it is

M4's lesson held: every task that started from a live measurement landed; every task that
started from an assumption was re-cut. M5 keeps the probe-first structure (D152) and adds
the two things L1 never needed:

**1. Multi-page runs make spend and honesty racy in a new way.** L1 spends one page load
and either finishes or fails. L2 spends a metered search page *per page* over a run that
can die at page 7 of 20. The contract that keeps the ledger honest is fixed here, once,
in core (Task 35), before any capability uses it: **spend before load, checkpoint after
archive, resume verifies against the archive and never re-spends a page whose bytes are
on disk.** A crash can waste money; it can never make the ledger under-count. That
direction is deliberate and is the paged equivalent of D105.

**2. Search pages are the scarcest budget in the system.** 50/day globally (§8). One
probe page is 2% of a day. Every task file states its search-page budget separately from
its page-load budget, and every live gate is designed to prove its property in the fewest
pages that can prove it.

**3. Search results are provenance, not entities.** `search_results` is append-only
(§7): the same lead in two searches is two rows, one entity. **A search row never
inserts or freshens an entity row** — a `persons.last_seen` bump is the record's claim to
be complete (D105), and a search hit read nothing. Lead/account rows store urns, URLs and
the search's own fields in `search_results` only; L1 readers enrich entities later.

## Plan layout

| File | Role |
|---|---|
| `CONTEXT.md` | What every task agent **reads first** — includes m1-m3 and m4 CONTEXT by reference, adds the M5 paged-run and Sales-Nav rules |
| `RECORDING.md` | What every task agent **updates** — m1-m3 + m4 RECORDING plus per-page spend and resume evidence |
| `tasks/task-NN-*.md` | One task each: objective, constraints, acceptance criteria |

## Task order and dependencies

```
35 paged-run core: spend/checkpoint/resume contract + salesnav sub-caps (offline)
36 sales nav surface probe (live; also the seat check)  ─► 38 parsers + search store path (offline)
37 salesnav.savedsearch.list (probe + capability in one — operator's own data, live)
38 ─► 39 salesnav.leads.list e2e (live gate incl. kill-and-resume)
   ─► 40 salesnav.accounts.list e2e (live gate)
```

- 35 is first and offline — the spend contract must exist before any metered page is
  loaded, exactly as Task 20's sub-caps preceded every M4 reader.
- 36 needs 35 (it spends search pages under the new contract). 37 needs 35 and can run
  before or after 36 — it reads the operator's own data and its saved-search URLs are the
  natural live-gate targets for 39.
- 38 needs 36's fixtures (D152: no parser before a fixture from a real load exists).
- 39 before 40: leads is the harder gate (resume proof); accounts reuses the proven
  composition.
- Offline tasks may run in parallel worktrees; **live runs stay serialized by the tab
  lease and the ledger**, as always.

## Decision-number ranges

D18's arithmetic formula is exhausted. The live high-water mark in `DECISIONS.md` is
**D334** — Task 34 took D330–D334 (its file's stated "D319–D328" collided with the
2026-08-10 integration fixes D320–D327, so it took the next free numbers, per standing
practice). D328–D329 and everything above D334 are free. M5 assigns explicit ranges
starting clear of all of that:

Task 35 → **D340–D349**, taken as **D342–D349** (D340/D341 were used before it ran) ·
Task 36 → **D350–D359** · Task 37 → **D360–D369** ·
Task 38 → **D370–D379** · Task 39 → **D380–D389** · Task 40 → **D390–D399**.

**Check `DECISIONS.md` before assuming your range is free.** A task whose ten are used
takes the next free numbers and says so, in `DECISIONS.md` and `STATE.md`.

## Model assignment

Split by consequence of a silent bug, as before. The paged-run core is a safety surface
(it decides what the ledger believes); everything live is Opus as always.

| Model | Tasks |
|---|---|
| **Opus** | 35 (spend contract) · 36 · 37 · 39 · 40, and every live gate step |
| **Sonnet** | 38 (pure parsers + store writers over committed fixtures) |

If a Sonnet task's review comes back weak, re-run on Opus — do not hand-patch.

## Review protocol

Unchanged from m1-m3/m4: fresh Opus reviewer per task against the task file, `CONTEXT.md`
and the diff; findings fixed before the next task; second-opinion review at the
operator's call for tasks touching the real account (here: 36, 37, 39, 40 and every live
gate).

## Milestone gate

**M5 gate** = all three capabilities have each passed, live and operator-supervised:

- `salesnav.savedsearch.list`: one default run, exit 0, receipt truthful, storage as
  decided in Task 37.
- `salesnav.leads.list`: one default-flags run, exit 0, **and one deliberately killed run
  resumed via `--run-id` to completion** — with total `search_page` ledger lines equal to
  distinct pages loaded exactly once, rows verified by independent Supabase query with
  page/position provenance, and raw bodies on disk for every page the ledger charged.
- `salesnav.accounts.list`: one default-flags run, exit 0, verified the same way.

Every gate verified independently of receipts — Supabase queries, archive listings,
ledger reads. Re-running a search spends again by design (`search_results` is
append-only; freshness does not apply to searches) — the "second run at zero loads" check
from the M4 gate deliberately does **not** apply here, and the gate says so rather than
letting a future session hunt for a cache that shouldn't exist.

Nothing in M6 starts before this gate.
