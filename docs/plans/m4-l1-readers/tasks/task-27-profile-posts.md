# Task 27 — `profile.posts`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 19 (`profile.get`
composition), Task 14 · **Spec:** §7 person_posts, §9 (`--limit`, `--since`)
**Decisions owned:** D230–D239

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

## Objective

Read a person's own posts into `person_posts` (urn, person_urn, text, posted_at,
reactions, comments), honoring `--limit` and `--since`.

## Constraints

- Parser pure and offline against Task 26's fixture. Store only posts authored by the
  subject — reposts and interleaved content excluded per what Task 26 measured; the
  fixture's interleaved-repost trap must be excluded by a test.
- `posted_at` populated exactly per Task 26's decision — no per-task reinvention.
- `--since` filters on the stored timestamp; `--limit` bounds capture work, not just
  output; every page load metered through the ledger + Task 20 sub-cap.
- `person_posts.person_urn` requires the person to be resolvable (reuse the profile
  identity rule); no FK forces the person row (D94).
- Store ordering discipline; batch upsert on post urn.

## Deliverables

`src/capabilities/profile.posts/` with README; parser + tests; `person_posts` write path
(shared with Task 23's `company_posts` shape where sensible — factor the common post-row
projection rather than duplicating).

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: repost exclusion, `--since`
  boundary, `--limit` as work bound.
- **Live gate, default flags:** exit 0 against a real profile with posts; rows verified by
  independent Supabase query.
- **Discipline gate** — all four m1-m3 review shapes.
