# `inbox.thread`

Reads one LinkedIn messaging thread from one metered page load.

```sh
npm run cap -- inbox.thread --url=https://www.linkedin.com/messaging/thread/<id>/
npm run cap -- inbox.thread --url=https://www.linkedin.com/messaging/thread/<id>/ --limit=100
```

## Read-only boundary and side effect

The capability has no send, react, archive or mark action. It only navigates, scrolls, captures
and parses.

**Opening a thread may mark it read in LinkedIn.** This is the accepted side effect of viewing
the page, and every successful receipt states `side_effect.may_mark_read: true` rather than
letting the operator discover it afterward.

## Source and privacy

The primary source is the labeled `messengerMessagesBySyncToken.elements[]` Voyager body measured
on the first live list run (D296). The older conversation-list envelope remains a tested fallback.
Several payload pages are merged and deduplicated only by real message urn; sender identity is
`sender.hostIdentityUrn`, checked against the identity set returned by `sessionUrnsOf` to tag
`sent`, `received`, or `unknown`. A message without text is still emitted with `text_chars: 0`
and a counted warning.

Message text never reaches parser output, stdout, a receipt, or an event log. The receipt exposes only message
identity, sender urn, absolute time, direction, and text length. The raw body remains in the run
archive; promoted live fixtures go only to `.fixtures-private/inbox.thread/`, while tests use a
committed synthetic body.

## Bounds and budget

- Default `--limit`: 50; hard maximum: 100.
- Default scroll passes: 2; hard maximum: 4.
- `data.read.partial` is always true: no measured field proves the start of history was reached.
- Cost: 1 page load, 0 search pages, 0 profile opens.
- Daily inbox-thread sub-cap: 12 page loads, enforced by the ledger with no bypass flag.

## Failures

- A non-LinkedIn or non-thread URL is rejected before capture.
- Lower-layer challenge/auth/rate-limit errors pass through unchanged.
- No labeled thread payload, or a payload that does not name the requested thread, is parse
  drift (exit 5), never an empty successful result.

## Storage

The operator decided archive-only on 2026-08-10 (D294). No messaging table exists, so there is
no Supabase query to show.

- Add approved tables: queryable history and sender/direction filtering, at the cost of a second
  structured copy of message content plus migration, access, dedupe, retention and deletion
  policy work.
- Keep archive-only: one local raw copy and receipt counts, at the cost of reparsing archives for
  structured questions and no cross-run index.

Revisit only if a downstream capability actually needs structured message-history queries.
