# `inbox.list`

Reads a bounded prefix of the operator's LinkedIn conversation list from one metered page
load. It is read-only: no send, react, archive or mark action exists in the capability.

**LinkedIn may auto-open a thread on `/messaging/` and mark it read.** The first live list run
fetched `messengerMessages` twice without an explicit thread click (D295), so every successful
receipt states this possible side effect.

```sh
npm run cap -- inbox.list
npm run cap -- inbox.list --limit=40
```

## Source and output

The source is the labeled `messengerConversations` Voyager body. The real private fixture
measured 20 conversation rows; all 20 carried two participants, one latest message, an
absolute `deliveredAt`, and `unreadCount`. The rendered DOM remains a probe artifact only—a
field available in that body must not be read from DOM under the measure-first condition in
the fifth DOM grant (D326).

The receipt returns participant identity/name, conversation identity/URL, latest sender and
timestamp, unread count, and `text_chars`. It never returns the latest-message text. The
untouched body remains in the run archive and can be promoted only to
`.fixtures-private/inbox.list/`.

## Bounds and budget

- Default `--limit`: 20; hard maximum: 100.
- At most 20 participants are projected per conversation; excess rows are counted.
- Default scroll passes: 2; hard maximum: 4.
- `data.read.partial` is always true: the sync token is not a completion signal.
- Cost: 1 page load, 0 search pages, 0 profile opens.
- Daily inbox-list sub-cap: 12 page loads. The ledger enforces it; no flag bypasses it.

## Failures

- Challenge/auth/rate-limit classifications from the capture layer pass through unchanged.
- No labeled conversation payload is parse drift (exit 5), not a silent empty inbox.
- A conversation with no optional snippet or timestamp is still emitted and counted in a
  warning whose denominator is the rows actually examined.

## Storage

The operator decided archive-only on 2026-08-10 (D294). The approved schema has no messaging
tables, and there is no Supabase query because this capability stores no rows.

- Add approved conversation/message tables: enables structured cross-run queries and history,
  but duplicates private correspondence into Supabase and requires identity, dedupe, access,
  retention and deletion rules plus a migration.
- Keep archive-only: keeps one local raw copy and receipts with counts/summaries, but any
  structured query requires reparsing selected archives and there is no cross-run index.

Revisit only if a downstream capability actually needs structured message-history queries.
