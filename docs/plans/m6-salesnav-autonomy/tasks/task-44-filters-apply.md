# Task 44 — `salesnav.filters.apply`: navigate, verify, count (offline build + live gate)

**Model:** Opus · **Depends on:** Task 42 (echo rules + fixtures) · **Decisions owned:**
D450–D459 (check free first) · **Live budget: max 4 page loads / 4 search pages**
(gate target: 1/1 green; the rest is retry headroom, not a loop).
**Sub-cap decision:** `salesnav.filters.apply` daily numbers land in
`src/core/budget/constants.ts` in this range — proposed 10/10 (a loop of ~6 applies plus
headroom; 20% of the global 50/day), accepted or amended by the operator at review.

## Objective

The metered half of the loop: take a built URL (or a `FilterSpec` it builds internally —
decide the CLI shape in-range), spend 1 page load + 1 search page, navigate, and report —
from captured bodies only — whether the audience LinkedIn searched is the audience the
spec described, and how big it is.

## Composition

Offline first, against Task 42's fixtures, mirroring the M5 discipline:

- **Receipt:** per-filter verdict (honored / rewritten / dropped, with Task 42's evidence
  rules), `paging.total`, the executed `sessionId` (for a later `leads.list` run to
  reuse-or-not per D391's corrected understanding), warnings
  (`FILTER_CATALOG_DRIFT`, `PAGING_SOURCE_INDIRECT`…), spend. **No entity data:** counts
  and verdicts only — result rows are neither parsed for content nor stored.
- **Verification parser is pure** (`parse.ts` + offline tests): inputs are the built
  query, the captured request URL, and the search body; output is the verdict struct.
  Fixture-tested against: clean echo, rewritten filter, dropped filter (from the
  invalid-id experiment), raw-text echo, zero-result body.
- **Exit codes:** 0 = ran and verified (including count 0, including verdicts with
  drops — the *loop* decides what a drop means; apply reports); 2/3/4/6/7 as
  standard; 5 = no search request captured, or grammar/echo unparseable — archive named.
- **Storage decision (D45x):** does apply write a `searches` row (vertical `sn_leads` /
  `sn_accounts`, `filter_url`, plus the verdict and count) with 0 `search_results`?
  Walk it against §7 and Task 38's semantics: a row per iteration gives the loop
  durable history and gives `leads.list` a ready target row; archive-only keeps
  `searches` meaning "a search whose rows were read". Decide with the operator at
  review, record, don't drift.
- **Reuses, never forks:** the M5 navigation/session/tap/budget path and the Task 41
  grammar. The D411 precheck idea (refuse-before-spend on URL-derived impossibilities)
  may be adopted here **only** by changing the shared Task 35 contract properly — not by
  a local bypass; if adopted, it is its own decision and test set.

## Live gate

One default-flags apply of the reconstructed CXO spec (or a Task 43-vocabulary spec the
operator picks): exit 0, all filters honored, plausible nonzero count. Verified
independently: the named request/response archives exist; the built and captured queries
match under the echo rules; ledger has exactly 1 page load + 1 search page for the run;
Supabase `searches`/`search_results` deltas match the storage decision exactly
(including "no delta" if archive-only).

## Constraints

- Page 1 only; no pager interaction of any kind lives in this capability.
- The challenge/interstitial path is exercised in tests via the merged checkpoint like
  every M5 capability; Sales Nav markers remain the defended-surface rule (M5 CONTEXT 3).
- Deliberate mutations, each verified to bite: verdict read from address bar instead of
  captured request (test fails), a dropped filter reported as honored (fails), spend
  moved after load (ordering test fails), `--no-store`/storage-decision bypass (fails).

## Acceptance criteria

- Full suite green, zero skips, typecheck clean; all four review shapes walked in an
  approach doc as Tasks 39/40 did.
- Gate passed as above with three-place spend agreement, and the receipt's verdict
  reproduced offline by re-running the parser on the archived pair.
- README.md contract doc complete; sub-cap constants merged with the accepted numbers.
