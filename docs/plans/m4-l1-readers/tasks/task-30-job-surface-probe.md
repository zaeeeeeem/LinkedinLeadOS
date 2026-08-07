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
