# Task 27 — `profile.posts`

**Model:** Sonnet · **Depends on:** Task 26 (fixtures), Task 19 (`profile.get`
composition), Task 14 · **Spec:** §7 person_posts, §9 (`--limit`, `--since`)
**Decisions owned:** D230–D239

> **UNBLOCKED 2026-08-09.** The posts fixture is on disk at `fixtures/profile.posts/`,
> promoted from run `01KZKKZZJ91XX4KX2Z3772QRHH` (`/in/tankots/recent-activity/all/`,
> 1 page load, exit 0). Read `fixtures/profile.posts/FIELD-MAP.md` before writing any
> parse code.
>
> **Source verdict: Voyager JSON. No DOM exception is needed for this surface.**
> A person's own posts arrive in `voyagerFeedDashProfileUpdates`
> (`6707f4b83c44b7e8.json`, 611,559 bytes, `data`/`meta`/`included` envelope), keyed by
> `profileUrn`. Labeled paths the field map confirms:
>
> | §7 column | path in the captured body |
> |---|---|
> | `urn` | `$.included[].urn` — `urn:li:activity:<id>` (also `metadata.backendUrn`) |
> | `person_urn` | `$.included[].actor.name.attributesV2[].detailData.*profileFullName` — `urn:li:fsd_profile:<id>` |
> | `text` | under `$.included[].commentary` / `content`; the `$.meta.microSchema.*` hits are schema declarations, not values — do not read them |
> | `reactions` / `comments` | `socialDetail` counts; see the map's `reactions_count` / `comments_count` sections |
>
> **`posted_at` rule: derive it from the post urn. Do not use the run clock.**
> The body carries **no absolute timestamp for a post**. The only epoch-ms values are
> image-CDN `expiresAt` fields, and the rendered time is relative
> (`$.included[].actor.subDescription.text` = `"2d •   "`, `"2w • Edited •   "`).
>
> LinkedIn activity ids are snowflakes: the creation time is the top 42 bits.
>
> ```ts
> const postedAt = new Date(Number(BigInt(activityId) >> 22n)); // epoch ms
> ```
>
> Verified against the promoted fixture: all 11 distinct rendered labels agree with the
> derived time, in order (`1d` → 2026-08-07T17:34:26Z, `2d` → 2026-08-06T18:24:42Z,
> `1w` → 2026-07-28T16:13:05Z, `1mo` → 2026-06-25T06:44:36Z). LinkedIn's own label is the
> coarse one — `"3d"` for a 4-day-old post — which is exactly why the urn is the source
> and the label is not. Pin this with a test over the fixture; a `posted_at` derived from
> the run clock is the lossy conversion D152 exists to prevent.
>
> **Repost / stranger trap:** the run inventoried 56 distinct person urns and 29 distinct
> activity urns on one subject's page. `author_urn` is the subject-vs-stranger boundary —
> check every one against the subject's own urn before storing, and cover it with the
> interleaved-repost test this task already requires.

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
