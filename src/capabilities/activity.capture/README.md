# `activity.capture`

Opens **one** page of the person-activity family and archives everything it fetches, plus
the rendered DOM. It parses nothing and stores nothing.

This is Task 26's probe. It exists so that `profile.posts`, `profile.activity` and
`post.get` are written against a page somebody measured rather than a page somebody
remembered (D152). Two earlier parsers in this repo were planned against Voyager JSON that
a live load then proved absent (D116, D121); the probe-first sequence is what stops that
happening a third time.

## Surfaces

| input | surface | page |
|---|---|---|
| `/in/<vanity>/recent-activity/all\|shares\|posts/` | `posts` | what the person published |
| `/in/<vanity>/recent-activity/comments/` | `comments` | comments they made on others' content |
| `/in/<vanity>/recent-activity/reactions/` | `reactions` | reactions they made |
| `/feed/update/urn:li:activity:<id>/`, `/posts/<slug>-activity-<id>-<hash>` | `post` | one post permalink |
| a bare `<vanity>` slug | `posts`, or `--surface=` | |

An unrecognised `/recent-activity/<tab>/` is **refused**, not guessed at: a tab nobody has
measured is a page load spent to find out what is on it. A `--surface` that disagrees with
a url naming its own tab is refused for the same reason.

`normalizeActivityUrl` is deliberately not `normalizeProfileUrl`. That one collapses
`/recent-activity/…` onto the base profile *on purpose*, because it captures the profile;
reusing it here would navigate every probe to the same page and measure nothing.

## What it spends

| surface | page_load | profile_open |
|---|---|---|
| `posts` / `comments` / `reactions` | 1 | 1, keyed `in:<vanity>` |
| `post` | 1 | 0 |

The `profile_open` key is **the same string `profile.capture` uses** (D223), so reading
someone's activity after reading their profile on the same day is one distinct person, not
two. A permalink opens nobody's profile, so it charges nothing to the distinct-person
budget (D222).

Its own daily sub-cap is deliberately small — it is a measurement capability, not a
working reader (D221).

## What it reuses

Everything that touches the browser: `readLikeAHuman` and `VIEWPORT_EXPRESSION` for the
scroll (which measures the real scroller rather than assuming `main#workspace` — this
surface may well have its own), `captureDomSnapshot` for the rendered DOM, `sessionUrnsOf`
for the operator's own identity, both challenge gates, and the raw-first archive with its
`finally { drain() }`.

What is its own: the url family, the relevance predicate, and the measurement report.

## Why relevance is not `isProfileIsh`

Every post card names its author, so "carries person data" is true of essentially every
body on this surface and the pattern-vs-reality answer would read the same on every run.
`isActivityIsh` looks for post, comment and reaction markers instead, and deliberately does
**not** include `urn:li:fsd_profile` (D220).

## What the receipt reports

Counts only. No urn, no name, no line of post text reaches stdout — the archive is the
product and it stays on disk.

- `capture.*` — the two-tier pattern report: which watched endpoints hit, and how many
  activity payloads arrived on endpoints nothing predicted.
- `reading.viewport.scroller` / `scrollers` / `scrollerCandidates` — **which element
  actually scrolls**, not only how tall it was (D227).
- `probe.body_*` — distinct urns per family across the relevant bodies, and how many of
  them are the operator's own.
- `probe.dom` — candidate post-card markers (any attribute carrying a `urn:li:`), how many
  rendered times there are, how many are absolute, and how many bind to a post.

## Warnings worth knowing

| code | means |
|---|---|
| `NO_ACTIVITY_PAYLOAD` | the page loaded and archived, and nothing carried post data |
| `PATTERN_MISMATCH` | activity arrived on an endpoint no specific pattern predicted — the finding |
| `FEED_NOT_EXHAUSTED` | the feed was read only part of the way down; this capture is a prefix (D228) |
| `SESSION_IDENTITY_UNAVAILABLE` | no `/voyager/api/me` was captured, so nothing could be checked against the operator's own identity |
| `POSTED_AT_RELATIVE_ONLY` | every rendered time is `3d`; `posted_at` cannot come from the DOM |
| `ACTIVITY_CONTAINER_NOT_RENDERED` | archived, but a shell — not a fixture anyone may parse |

## After a run

```
npm run fixtures:promote -- --run=<runId> --capability=profile.posts --surface=activity
```

`--surface=activity` moves three things together (D226): what counts as a relevant body,
which probes the JSON field map runs, and which DOM map the snapshot gets. Promoting an
activity run under the profile settings drops every body that carries posts and no person
urn, and hands the snapshot to a map looking for cards that are not there.
