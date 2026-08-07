# `activity.capture` — contract

**Risk:** `read-cheap` · **Browser:** yes · **Auth:** required · **Stores:** nothing

Opens one page of the person-activity family, archives every LinkedIn API response it
fetches plus a snapshot of the rendered DOM, and reports what it measured. It parses
nothing and writes no rows. Task 26's probe (D152).

## Arguments

| arg | type | meaning |
|---|---|---|
| `url` | string, required | a `/in/<vanity>/recent-activity/…` url, a bare vanity slug, or a post permalink |
| `surface` | `posts` \| `comments` \| `reactions` | names the tab when the url does not. Refused when it disagrees with a url that does; `post` is refused outright — pass the permalink |
| `scrolls` | int 0–12 | scroll passes. Omitted: a randomized 3–6 |
| `captureTimeoutMs` | int | how long to wait for the page's first LinkedIn API response |
| `layoutTimeoutMs` | int | how long to wait for the page to lay out before scrolling |

## Cost

| surface | `page_loads` | `profile_opens` | ref |
|---|---|---|---|
| `posts` / `comments` / `reactions` | 1 | 1 | `in:<vanity>` (D223) |
| `post` | 1 | 0 (D222) | — |

Daily sub-caps (D221): 30 page loads, 0 search pages, 20 distinct profiles.

## Exit codes

`0` ok · `2` challenge · `3` rate-limited · `6` transient (`ACTIVITY_NO_CAPTURE`) ·
`1` `ACTIVITY_URL_INVALID`, raised before anything is opened or spent · plus the runner's
`4` and `7`.

## Receipt

`counts.captured` is LinkedIn API responses archived; `counts.usable` is how many carried
post, comment or reaction data; `counts.skipped` is watched responses seen but not
delivered.

`data` carries `target`, `reading` (including the measured **scroller descriptor**, D227),
`snapshot`, `capture` (the two-tier pattern report), and `probe` — the measurement, entirely
in counts:

- `session_urns_known`, `body_session_urn_hits` — the D119/D126 trap, counted rather than
  assumed absent.
- `body_urns_distinct` — distinct urns per family across the inventoried bodies.
- `dom.urn_attributes` — every attribute that carries a `urn:li:`, with how many elements
  and how many of those were the operator's own.
- `dom.time_leaves`, `dom.time_leaves_absolute`, `dom.time_leaves_bound_to_a_urn` — the
  `posted_at` measurement.

**No urn, name or post text ever reaches stdout.** Pinned by a test.

## Warnings

| code | means |
|---|---|
| `NO_ACTIVITY_PAYLOAD` | archived, and nothing carried post data |
| `PATTERN_MISMATCH` | activity arrived on an endpoint no specific pattern predicted |
| `CAPTURE_MISSES` | a watched response was seen and its body lost |
| `FEED_NOT_EXHAUSTED` | this capture is a prefix of the feed (D228) |
| `PAGE_NOT_LAID_OUT` | nothing ever measured taller than the viewport |
| `SESSION_IDENTITY_UNAVAILABLE` | no `/voyager/api/me`, so no urn could be checked against the operator |
| `POSTED_AT_RELATIVE_ONLY` | every rendered time is relative |
| `DOM_SNAPSHOT_FAILED` / `DOM_SNAPSHOT_NOT_ARCHIVED` / `ACTIVITY_CONTAINER_NOT_RENDERED` | the three distinct snapshot outcomes |
| `RESPONSE_STATUS_UNRECOGNIZED` | D111 |
| `TAB_NOT_FOREGROUND` | lazy cards may not have loaded |

## After a run

```
npm run fixtures:promote -- --run=<runId> --capability=profile.posts --surface=activity
```

`--surface=activity` selects the relevance predicate, the JSON probes and the DOM map
together (D226).
