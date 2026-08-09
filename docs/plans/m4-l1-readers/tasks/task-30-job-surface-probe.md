# Task 30 — Job surface probe and fixture (live)

**Model:** Opus · **Depends on:** Task 20 (and Task 25's `jobs` write path exists)
**Spec:** §7 jobs, §9 (`job.get`) · **Decisions owned:** D260–D269
**Probe budget: max 3 page loads** (a couple of `/jobs/view/<id>` pages).

## Objective

Measure where `job.get`'s full-detail fields live on `/jobs/view/<id>`: title, company
urn, location, posted_at, workplace_type, and the full description. Deliver a
subject-scoped fixture and tested FIELD-MAP for Task 31.

## Constraints

- Runs through the capability runner; reuse snapshot/scroller machinery; measure the real
  scroller (job detail description is often a lazy-expanded panel — measure whether "see
  more" is a DOM toggle or a request). Archive every body + DOM snapshot.
- **Sweep per §7 `jobs` field:** which source carries each, especially the full
  description (list card vs detail page — this is exactly the field Task 25 left null for
  here). Resolve the company urn on the posting and check it against `sessionUrnsOf`.
- Job id canonical form confirmed against Task 25's choice — one form across both tasks.
- DOM-only fields → `[DECISION NEEDED]` to extend the CLAUDE.md exception; Task 31 blocked
  on it.

## Deliverables

Archived probe run(s); fixture; `FIELD-MAP.md` with tested paths; source verdict written
into Task 31; spend used vs budgeted on STATE.md.

## Acceptance criteria

- Offline suite green; typecheck clean; every path resolves against the fixture with
  meaning-checked assertions, description included.
- Live: probe exit 0, no challenge, within budget, lease released, raw-first archived.
- **Discipline gate** — all four m1-m3 review shapes.

---

## Execution note (2026-08-09) — the task is split in two, and only the first half is done

The live run is the operator's to supervise, so this task landed as:

**Half one, committed:** the instrument. `src/capabilities/job.capture/` (probe capability,
canonical job id, job watch patterns, the passive description measurement, the identity
checks), `src/core/fixtures/families.ts` (promotion routes per surface), and the offline
tests for all of it. Decisions D260–D264. **Half one deliberately contains no job parser and
no field extraction** — D152's rule that a probe delivers measurement, not code that consumes
it.

**Half two, blocked on the operator:** the live run(s), the promoted fixture,
`fixtures/job.get/FIELD-MAP.md` with every path pinned by an offline test, and the per-field
source verdict written into Task 31. `STATE.md`'s `## Next` holds the exact commands.

**Dependency correction.** This file lists Task 25's `jobs` write path as a dependency. It
does not exist — the company family (Task 21 →25) is still in flight. The canonical id was
therefore decided here, in D260, rather than read off Task 25; Task 25 must adopt it, and the
decision says so.

**Worktree.** Built in `../LinkedinLeadsOS-worktrees/four` on `task-30-job-surface-probe`;
worktree `three` was already checked out to Task 26's branch.
