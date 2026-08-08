# `profile.posts`

Reads a person's own posts from the Voyager response LinkedIn's activity page fetches and
batch-upserts them into `person_posts`.

```sh
npm run cap -- profile.posts --url=some-person
npm run cap -- profile.posts --url=https://www.linkedin.com/in/some-person/recent-activity/all/ --limit=40
npm run cap -- profile.posts --url=some-person --since=2026-08-01T00:00:00.000Z
```

## Source and identity

All stored fields come from archived `voyagerFeedDashProfileUpdates` JSON. The parser follows
the feed's `*elements` references into `included[]`; it never walks `meta.microSchema`, whose
`text`, `commentary`, and count entries are declarations rather than values. No DOM content is
read by this capability.

The subject is resolved from the captured profile-components `*vieweeProfile` value after
removing the existing session identity set. Exactly one non-session profile urn must remain.
Each resolved update's actor must equal it; reposts and interleaved stranger cards are skipped.
A `persons` row is not required because `person_posts.person_urn` deliberately has no FK (D94).
Post permalinks are refused before capture; this reader requires a person activity surface.

## Time, limits, and cost

`posted_at` is derived solely from the activity snowflake's top 42 bits. Relative labels and
image-CDN expiry fields are ignored. `--since` is an inclusive filter on that exact stored ISO
timestamp.

`--limit` defaults to 20 and bounds work: through 20 items the capture performs no scroll pass,
then allows one pass per next 20 up to the existing 12-pass ceiling; the parser separately stops
after examining exactly the requested number of feed references. Stranger and since filtering
do not replenish the work allowance. The delegated activity capture meters the one page load
and distinct profile open through the ledger under `profile.posts`, so Task 20's capability
sub-cap and the global limits both apply.

Reaction and comment counts follow the update's `*socialDetail` reference to its
`fsd_socialActivityCounts` entity. This retains counts whether LinkedIn keys that entity by an
activity, ugcPost, or share urn.

## Storage and receipt

Rows are projected through the shared post shape in `src/core/store/posts.ts`, which Task 23's
`company_posts` writer can reuse. The write is one batch upsert on the post urn and refreshes
`last_seen`; reaction/comment counts are current observations, not histories. `--no-store`
still captures and parses but writes no database rows. Bulk post data never reaches stdout.

The live gate is operator-supervised because it spends a metered page load. This implementation
stops before that gate.

Useful verification query:

```sql
select urn, person_urn, text, posted_at, reactions, comments
from person_posts
where person_urn = 'urn:li:fsd_profile:<id>'
order by posted_at desc;
```
