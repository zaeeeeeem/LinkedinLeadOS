---
name: monitor-account
description: Use when checking the operator's own LinkedIn account — who replied or messaged, what's in the inbox, what the feed shows, triaging conversations, or watching for responses to outreach. Read-only surfaces only.
---

# Monitor the Operator's Own Account

**Read the `linkedin-session` skill first** — preflight, budgets, exit codes.

These readers look at the operator's *own* data — feed and inbox. They are **strictly
read-only**: nothing sends, reacts, archives, or marks. How often to check and what counts
as "needs attention" is your triage policy; the toolkit's part is bounded reads and a hard
privacy line on message content.

## The privacy line (non-negotiable)

**Message text never leaves the archive.** Not to stdout, not to a receipt, not to a log,
not to a commit, not quoted in your own summary. Receipts carry identity, sender, time,
direction, unread counts and `text_chars` — triage on those. The raw bodies stay in the
run archive; promoted fixtures go only to `.fixtures-private/`, never `fixtures/`.

## Inbox

```sh
npm run cap -- inbox.list                 # 20 conversations; --limit up to 100
npm run cap -- inbox.thread --url=https://www.linkedin.com/messaging/thread/<id>/
```

- Cost: 1 page load each. Sub-caps: **12/day** for list, **12/day** for thread — a
  polling loop that checks every few minutes will exhaust the day; pick a cadence.
- `inbox.list` receipt per conversation: participants, latest sender + timestamp,
  `unreadCount`, `text_chars`. Enough to answer "did anyone reply since yesterday"
  without opening anything.
- **Reading may mark things read on LinkedIn.** Opening a thread does; and even
  `inbox.list`'s `/messaging/` load has been measured auto-opening the top thread
  (D295) — so unread state can never be guaranteed preserved, only minimized by
  stopping at `inbox.list`. The receipt states the possible side effect
  (`side_effect.may_mark_read: true` on threads); surface it to the operator rather
  than letting them discover it.
- `data.read.partial` is always true on both — a bounded prefix, never "the whole inbox".

## Feed

```sh
npm run cap -- feed.get --limit=10        # up to 25; passes capped at 8
```

- Cost: 1 page load; sub-cap 24/day; archive-only (no Supabase table).
- Receipt rows: author (resolved from the card's label, or honestly `null` —
  `PARSE_AUTHOR_UNRESOLVED` is reported, never guessed), post urn when resolvable,
  reaction/comment totals, `posted_at`, `text_chars`. Post bodies stay in the archive.
- A feed does not end: `partial` is always true, nothing reads to the bottom. Use it for
  "what's crossing the operator's feed", not as a completeness claim.

## Triage patterns

- **Reply watch:** `inbox.list` once or twice a day; diff `unreadCount` / latest-sender
  timestamps against the previous receipt (receipts persist under `runs/`). Report *who*
  and *when*, let the operator read *what*.
- **Signal watch:** `feed.get` rows where a known lead is the author (join against stored
  `persons`) — a lead posting is a research trigger for `research-lead`, on their public
  surface, where reading is in scope.
- Escalate to the operator by pointing at the thread URL — never by summarizing message
  content you were never shown.

## Stop and ask the operator

- Anything that answers, reacts, archives, marks, or drafts *into* LinkedIn — L3, out of
  scope, no exceptions.
- Any request to quote or summarize message text — the line above holds even when asked
  casually; the operator reads their own mail in LinkedIn.
- Exit 2/3/4 — per `linkedin-session`.
