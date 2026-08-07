# Task 28 — `profile.activity`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 27 (post-row projection)
**Spec:** §9 (`profile.activity` — reactions and comments the person made)
**Decisions owned:** D240–D249

> **Blocked, and here is exactly on what (Task 26, 2026-08-09, D229).** Task 26 shipped its
> offline half — the `activity.capture` probe, the measurement instruments, 107 tests. It has
> **not** run live, so `fixtures/` holds nothing for this surface and there is no
> `FIELD-MAP.md`. The source verdict below is blank because writing one from expectation is
> the artefact D152 exists to prevent.
>
> To unblock, in order:
> 1. Operator runs the supervised probe (commands in `STATE.md`, "Next").
> 2. `npm run fixtures:promote -- --run=<runId> --capability=<this capability> --surface=activity`
>    (D226 — `--surface` selects relevance, probes and DOM map together).
> 3. Read `fixtures/<capability>/FIELD-MAP.md`, fill the verdict below, and — **if the
>    content is DOM-only** — get the operator's decision extending `CLAUDE.md`'s DOM-source
>    exception to this surface, recorded in `DECISIONS.md` (M4 CONTEXT rule 7). The
>    exception is the profile reader and nothing else; it is never inherited.
>
> **What Task 26 already built that this task uses, and must not re-implement:**
> `normalizeActivityUrl` (surfaces + refusals), `ACTIVITY_PATTERNS` / `isActivityIsh`
> (D220), `ACTIVITY_PROBES` and the `timeshape` classifiers (D224),
> `buildActivityDomMap` (D225 — an *instrument*: measure with it, do not lift it into a
> parser), and `activity.capture` itself for the page load.
>
> *Source verdict per field:* _blank until the probe runs._
> *`posted_at` rule:* _blank until the probe runs — see the `POSTED_AT_RELATIVE_ONLY`
> warning and the `posted_at_epoch` / `posted_at_iso` / `posted_at_relative` probes. If no
> source carries an absolute time, this is a `[DECISION NEEDED]`, not a conversion any of
> Tasks 27-29 may invent._
>
> **Storage note:** §7 has **no table for a person's outbound reactions/comments** —
> `person_posts` holds authored posts, not activity-on-others. Task 26 measures whether
> activity is meaningfully separable; this task **ends with a `[DECISION NEEDED]`**: add a
> `person_activity` table (operator-approved migration) or return activity as
> receipt-counts + archived-only. Do not invent schema.

## Objective

Read the reactions and comments a person made on others' content. The primary value is
the *signal* (who they engage with), which may be reported without a new table pending
the storage decision.

## Constraints

- Parser pure and offline against Task 26's fixture; identify the acting subject vs the
  content they acted on (two different urns per activity item — the actor is the subject,
  the target is someone else); session-identity check on the actor.
- No storage write until the storage decision lands; until then `--no-store`-style
  behavior is the default and the receipt carries the counts + a from-archive hint.
- `--limit` / `--since` bound work, metered through the ledger + sub-cap.

## Deliverables

`src/capabilities/profile.activity/` with README; parser + tests; the written
`[DECISION NEEDED]` for storage; if approved in-cycle, the migration + write path.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: actor-vs-target urn distinction,
  session-actor exclusion.
- **Live gate, default flags:** exit 0 against a real active profile; receipt counts match
  an independent count of archived activity items; if storage was approved, rows verified
  by query.
- **Discipline gate** — all four m1-m3 review shapes.
