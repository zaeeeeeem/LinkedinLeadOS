# Task 27 — `profile.posts`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 19 (`profile.get`
composition), Task 14 · **Spec:** §7 person_posts, §9 (`--limit`, `--since`)
**Decisions owned:** D230–D239

> **Blocked until** Task 26's posts fixture exists and any DOM-source / posted_at decision
> is recorded. *Source verdict + posted_at rule from Task 26:* _to be filled in by Task 26._

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
