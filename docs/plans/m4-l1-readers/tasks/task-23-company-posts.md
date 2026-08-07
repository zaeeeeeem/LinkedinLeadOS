# Task 23 — `company.posts`

**Model:** Sonnet · **Depends on:** Task 21 (fixtures), Task 22 (companies write path)
**Spec:** §7 company_posts, §9 (`--limit`, `--since`) · **Decisions owned:** D190–D199

> **Blocked until** Task 21's posts fixture exists and any DOM-source decision for the
> company surface is recorded. *Source verdict from Task 21:* **not yet measured.** `company.probe` exists and is
> tested (D170–D179), but the live run has not happened, so no field's source is known.
> Do not begin: there is nothing on disk to write a parser against (D152).

## Objective

Read a company's posts into `company_posts`: post urn, company urn, text, posted_at,
reaction and comment counts, honoring `--limit` and `--since`.

## Constraints

- Parser pure and offline against Task 21's fixture. Post identity is the activity urn;
  refuse posts whose author urn is not the subject company (reposts/suggested content are
  the sidebar-stranger trap of this surface — the fixture must contain or simulate one,
  and the test proves it is excluded or explicitly marked, per what Task 21 measured).
- `posted_at`: LinkedIn shows relative times in the DOM; only store a timestamp the
  measured source actually carries. A derived-from-relative time is drift-prone guessing —
  if no absolute time exists in the source, that is a schema conversation, not a
  silent approximation (record the decision).
- Pagination/scroll depth follows what Task 21 measured for the posts sub-page; every
  page load goes through the ledger; `--limit` bounds work, not just output.
- `company_posts.company_urn` rows require the company entity path from Task 22 to exist
  in code, but **no FK forces the company row to exist** (D94) — do not add one.
- Store ordering discipline: batch upsert keyed on post urn; a partial failure leaves
  extra-or-absent rows, never a fresh-looking incomplete set.

## Deliverables

`src/capabilities/company.posts/` with README; parser + tests; `company_posts` write path.

## Acceptance criteria

- Offline suite green; typecheck clean; mutation-verified: non-subject-author exclusion,
  `--since` boundary, `--limit` as a work bound.
- **Live gate, default flags:** exit 0 against a real company with posts; rows verified by
  independent Supabase query; second run freshness behavior per the receipt contract.
- **Discipline gate** — all four m1-m3 review shapes.
