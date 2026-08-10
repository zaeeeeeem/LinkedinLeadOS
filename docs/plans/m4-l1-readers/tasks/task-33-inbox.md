# Task 33 — `inbox.list` + `inbox.thread` (probe + capabilities, operator's own data)

**Model:** Opus · **Depends on:** Task 20 · **Spec:** §9 (`inbox.list`, `inbox.thread` —
read-only) · **Decisions owned:** D290–D299 (free as of 2026-08-10; D326 grants the DOM exception, D327 the private fixture root)
**Budget: max 4 page loads** (conversation list + a few threads).

## Objective

Read the operator's own messaging: the conversation list (`inbox.list`) and one thread's
messages (`inbox.thread`), **read-only** — no send, no read-receipt-triggering action
beyond what merely viewing already does. Operator's own data, no §7 table, so probe +
both capabilities + storage decision collapse into one task.

## Constraints

- **Read-only is load-bearing (L3 boundary).** Opening a thread may mark it read — that is
  a side effect the operator must accept knowingly. State it plainly in the README and the
  live-gate note; do nothing that sends, reacts, or archives. The M3 probes already
  observed messaging bodies (STATE.md notes them as private endpoints) — this task is the
  first to read them deliberately, so the archive/no-print rule is sharpest here: message
  text is personal data, never printed to stdout/logs/commits, `fixtures/` gitignored.
- **Probe first, same task:** capture the messaging surface, measure its scroller, sweep
  for where conversation-list fields (participant, last-message snippet, timestamp, unread
  flag) and thread-message fields (sender urn, text, sent_at) live. Fixture + tested
  FIELD-MAP. Sender urns checked against `sessionUrnsOf` to tag operator-sent vs received.
- **Storage decision (`[DECISION NEEDED]`):** §7 has no messaging tables. Present the
  operator: add tables (approved migration) or return receipt-counts + archived-only.
  Default archive-only. Given message content sensitivity, storing is the operator's
  explicit call, not a default.
- **The DOM exception is already granted (D326, 2026-08-10)**, read-only, with the same
  measure-first condition as D325: a labeled network body still wins over a DOM read.
- **Fixtures go to `.fixtures-private/`, never to `fixtures/` (D327).** D118's deny-list is
  **unchanged** and still has no flag — this capability names the private root as its
  destination explicitly, which is a different operation with a different target, not the
  deny-list being bypassed. The promoter needs a private-root destination before this task's
  fixture step can run; that plumbing is part of this task.
- **A private fixture is not reproducible on another machine.** Parser tests are written against
  a redacted or synthetic fixture committed to the repo; the private one is for the live
  measurement only. The offline-provability rule is not waived, it is satisfied by the synthetic
  copy.
- Metered through the ledger + an inbox sub-cap.

## Deliverables

`src/capabilities/inbox.list/` and `src/capabilities/inbox.thread/` with READMEs; probe
fixtures + tested FIELD-MAPs; parsers + tests; the read-only side-effect note; the storage
and exception `[DECISION NEEDED]`s; if approved, migration + write paths.

## Acceptance criteria

- Offline suite green; typecheck clean; FIELD-MAP paths resolve against fixtures with
  meaning-checked assertions; operator-sent vs received tagging proven; a test asserts no
  message text ever reaches a receipt/stdout path.
- **Live gate, default flags, operator-supervised:** `inbox.list` exit 0 returning real
  conversation counts; `inbox.thread` exit 0 on one thread; both verified by counts /
  queries without any message body printed; the read-marking side effect acknowledged in
  the run note.
- **Discipline gate** — all four m1-m3 review shapes.
