# `profile.activity`

Reads the comments and reactions a person made on activity-feed content. It opens the person's
comments and reactions tabs once each, archives the untouched responses through the shared
network tap, and parses only the two measured `voyagerFeedDashProfileUpdates` envelopes.

```sh
npm run cap -- profile.activity --url=some-person
npm run cap -- profile.activity --url=some-person --limit=40
npm run cap -- profile.activity --url=some-person --since=2026-08-01T00:00:00.000Z
```

## Identity and source

The subject is resolved from captured `*vieweeProfile` data after removing the session identity
set. On each activity item the acting subject comes from the header's attributed profile urn;
the target post author comes from the update actor and remains a separate field. A session-owned
actor is excluded, and an unresolved or session-owned subject stops with exit 5.

Every parsed value comes from archived Voyager JSON. The parser follows each feed's `*elements`
references into `included[]` and never reads `meta.microSchema` declarations or rendered DOM.
The target post fields use `profile.posts`' shared post projection: activity urn, body, snowflake-
derived `posted_at`, and reaction/comment totals resolved through the social-detail graph.

## Work, cost, and receipt

The cost is two page loads and one distinct profile open: one comments tab and one reactions tab.
`--limit` defaults to 20 per tab and bounds both scroll passes and referenced items examined;
`--since` is inclusive on the snowflake-derived target-post timestamp and does not replenish the
work allowance. Both loads are delegated to `activity.capture`, so the ledger, Task 20 sub-cap,
challenge gates, human pacing, and raw-first archive remain in force.

Spec section 7 defines no table for outbound person activity. This capability therefore writes
nothing, even when the global `--no-store` flag is absent. Its fixed-size receipt reports comment
and reaction counts, work accounting, and a run-archive reparse hint. The operator-supervised live
gate is intentionally still pending.

## Failures

- `PROFILE_ACTIVITY_URL_INVALID` (exit 1): the target is a post permalink rather than a person.
- `PROFILE_ACTIVITY_SUBJECT_UNRESOLVED` (exit 5): exactly one non-session subject was not proven.
- Capture, challenge, rate-limit, authentication, transient, and budget failures pass through
  unchanged from the shared capture composition.
