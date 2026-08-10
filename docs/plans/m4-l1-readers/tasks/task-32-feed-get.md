# Task 32 — `feed.get` (probe + capability, operator's own data)

**Model:** Opus · **Depends on:** Task 20 · **Spec:** §9 (`feed.get` — operator's own feed)
**Decisions owned:** D280–D289 (free as of 2026-08-10; D325 already grants the DOM exception)
**Budget: max 3 page loads.**

## Objective

Read the operator's own `/feed/`. Because this is the operator's own data (lowest novelty
risk) and spec §7 defines **no feed table**, probe and capability collapse into one task
that ends with an explicit storage decision.

## Constraints

- **Probe first, in the same task:** live-capture `/feed/`, archive every body + DOM
  snapshot, measure the feed scroller, sweep for where each feed item's fields live
  (author, text, posted_at, reaction/comment counts, item urn). Fixture + tested
  FIELD-MAP, subject-scoping here meaning per-item author resolution (the feed is *all*
  other people's content — the "subject" framing inverts; every item's author is a
  different urn, checked against `sessionUrnsOf` only to tag the operator's own items).
- **The DOM exception is already granted (D325, 2026-08-10)** — approved ahead of the
  measurement, so do not stop to ask for it. It comes with a condition that is not optional:
  **the probe still measures, and a labeled network body still wins.** A DOM read of a field
  that was available in a captured body is a defect here, not a shortcut. Report what the sweep
  found either way.
- **Do not read this surface to the bottom.** D320's `untilBottom` is for pages that end. A feed
  does not: bound the read by `--limit` and a fixed pass count, and flag a partial read as
  partial rather than reporting it as the whole (the discipline D313 put on comments).
- **Storage decision (`[DECISION NEEDED]`):** §7 has no `feed_items` table. End the task
  by presenting the operator the choice — add a table (approved migration) or return the
  feed as receipt-counts + archived-only. Default to archive-only until decided; do not
  invent schema.
- Metered through the ledger + a feed sub-cap; `--limit` bounds scroll work.

## Deliverables

`src/capabilities/feed.get/` with README; probe fixture + tested FIELD-MAP; parser +
tests; the written storage `[DECISION NEEDED]`; if approved in-cycle, migration + write path.

## Acceptance criteria

- Offline suite green; typecheck clean; FIELD-MAP paths resolve against the fixture with
  meaning-checked assertions; per-item author resolution proven, operator's own items
  correctly tagged.
- **Live gate, default flags:** exit 0 reading the operator's real feed; receipt counts
  match an independent count of archived items; if storage approved, rows verified by query.
- **Discipline gate** — all four m1-m3 review shapes.
