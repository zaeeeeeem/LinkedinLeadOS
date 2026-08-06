# Task 28 — `profile.activity`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 27 (post-row projection)
**Spec:** §9 (`profile.activity` — reactions and comments the person made)
**Decisions owned:** D240–D249

> **Blocked until** Task 26's activity fixture exists and any DOM-source decision is
> recorded. *Source verdict from Task 26:* _to be filled in by Task 26._
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
