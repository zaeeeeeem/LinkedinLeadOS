# `feed.get`

Read the operator's **own** `/feed/`. One page load, one bounded read, one DOM
snapshot, parsed offline from the archived bytes.

```
cap feed.get                      # 10 items, 5 scroll passes
cap feed.get --limit=25           # 8 passes (the ceiling), up to 25 items
cap feed.get --scrolls=2          # an explicit pass count wins
```

Spec §9. Task 32. Decisions D280–D284, under the DOM grant of D325.

## What it returns

A receipt with per-item rows and no post text:

| field | meaning |
|---|---|
| `ref` | the card's SDUI tracking id — **stable within this page only**, not a urn |
| `feed_type` | e.g. `MAIN_FEED_RELEVANCE` |
| `urn` / `urn_source` | the post's own urn, or `null`. See *Identity* below |
| `author_name` | from the label LinkedIn writes on the card's control menu |
| `author_vanity` / `author_company` / `author_url` | resolved from that name |
| `is_operator` | true when the author is the operator themselves |
| `text_chars` | the body's length. The body itself stays in the archive |
| `reactions_total` / `comments_total` / `reposts_total` | the card's own totals |
| `posted_at` | derived from the activity snowflake, when `urn` resolved |
| `comments_rendered` | comment rows on the card. Never loaded, only counted |

`data.read.partial` is **always true**. A feed does not end.

## Storage

**Archive-only.** §7 defines no feed table and none was invented (D283). The
snapshot is in the run's `raw/`; nothing is written to Supabase. If a table is
approved later, the parser already returns rows shaped for one.

## Where the data comes from, and why

The source is the rendered DOM, under the fourth DOM exception (D325). That
grant was given *ahead of* the measurement, on the condition that the probe
still measures and that a labeled network body still wins.

**It measured, and there is no such body** (D280). Run
`01KZMZ5BQD2MKSN8EV7WRG38P0`, 2026-08-10:

- 26 responses archived; **zero hits** on all six watched feed endpoints —
  `voyagerFeedDashUpdates`, `voyagerFeedDashMainFeedUpdates`,
  `voyagerFeedDashFeedUpdatesV2`, `voyagerSocialDashSocialActivityCounts`,
  `voyagerSocialDashSocialDetails`, `/voyager/api/feed/updates`;
- the `/feed/` document is 5.2MB and carries **no Big Pipe island at all** —
  only an RSC flight tree, so D117's embedded-structured-data route is closed
  here the same way it is on the post surface (D313);
- the only two feed-ish bodies were that document and the notification-cards
  endpoint, which is not the feed and is never promoted (D118).

The measurement stays on **every** receipt under `data.probe` (`feed_api_pattern_hits`, which excludes the document watch), so the day
LinkedIn starts answering with JSON it stops being true loudly rather than
quietly.

## Scoping: there is no subject

Every card is scoped by its own SDUI namespace —
`componentkey="expanded<TRACKING_ID>FeedType_<TYPE>"` on the wrapper, the bare
`<TRACKING_ID>` on the card's own container. That is the feed's counterpart to
the profile card-ref namespace of D127.

**Authorship is read from a label, never from a link position.** On the measured
snapshot, 3 of 8 cards carry more than one `/in/` link, and on every one of them
the *first* link belongs to whoever liked or commented — not to the author. The
anchor is the `aria-label` `Open control menu for post by <name>`; the matching
`View <name>’s profile` label resolves that name to a url. A card with no such
label is **reported unresolved** (`PARSE_AUTHOR_UNRESOLVED`) and never guessed
at. Attributing by position is how D118 happened.

`sessionVanitiesOf` is used only to **tag** the operator's own items. A feed
legitimately contains them; they are not the D119 trap here.

## Identity

Only 3 of 8 cards carried a resolvable post urn, and only from one place: the
parent urn inside a rendered comment's
`replaceableComment_urn:li:comment:(<parent>,<id>)` key. A comment's parent is by
definition the post it sits under.

An `activity` urn found **anywhere else** in a card is not the card's own. The
measured snapshot has a card whose *post text* links to a different post;
reading that as identity would key the item to a stranger's content. A card that
rendered no comment is returned with `urn: null` and counted in
`PARSE_ITEM_URN_UNRESOLVED`.

`posted_at` is derived from an `urn:li:activity` snowflake only. A `ugcPost` urn
yields `null` rather than a conversion nobody has measured.

## Bounds

A feed does not end, so `untilBottom` (D320) is not used and must not be:

- `--limit` bounds the output **and** the scroll work (`passesFor`);
- passes are capped at `MAX_FEED_PASSES` (8), whatever `--limit` asks for;
- `MAX_FEED_ITEMS` (100) bounds the parser regardless of `--limit`;
- nothing clicks "load more" on a comment thread — comment rows are counted
  where they rendered, exactly as D313 requires of `post.get`.

## Budget

`feed.get`: **24 page loads/day, 0 search pages, 0 profile opens.** Both zeroes
are assertions: a spend of either kind under this name means the reader is doing
something it was not built to do, and zero turns that into exit 7 rather than a
habit that grows.

## Files

| file | what |
|---|---|
| `constants.ts` | the url, the limits, `passesFor` |
| `patterns.ts` | what the page is expected to fetch, and the nets that catch what it does |
| `capture.ts` | the metered read: gates, readiness, bounded scroll, snapshot |
| `parse.ts` | the pure offline parser |
| `index.ts` | the capability, and the probe half of the receipt |
