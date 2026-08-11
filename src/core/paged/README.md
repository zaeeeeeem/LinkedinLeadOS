# `core/paged` — the paged-run contract

The loop L2 needs and L1 never did: read a search page by page, over a run that
can die at page 7 of 20, without the ledger ever telling a lie.

Tasks 36, 39 and 40 **consume** this. Do not re-derive the ordering inside a
capability, and do not add a second checkpoint mechanism or a second ledger
path — this module composes `RunContext.checkpoint()`, `RawArchive` and the
budget ledger, all three unchanged.

## The contract

For each page N:

| | step | what it writes |
|---|---|---|
| 1 | **spend** | the ledger line(s) for page N, *before* page N is requested |
| 2 | **load** | nothing on disk — the source navigates and returns |
| 3 | **archive** | page N's raw bodies, untouched, gzipped |
| 4 | **checkpoint** | page N complete, naming the archive entries that prove it |

A resume through the existing `--run-id` path reads the last checkpoint,
**verifies every completed page against the archive on disk** — not against the
checkpoint's own claim — and continues at the first unproved page without
re-spending the proved ones.

**The direction of failure is part of the contract.** A crash can waste a spent
page. It can never produce an unpaid load, an under-counting ledger, or a
receipt claiming a page with no bytes.

## What survives a crash at each boundary

The order below is the real one: the attempt record is written before the spend
so a crash mid-spend leaves a trace, and it is never read as proof of payment.

| killed at | on disk afterwards | what the resume does |
|---|---|---|
| inside the spend phase | attempt record, plan named, spend unconfirmed | re-spends; reports the possible extra line as `unconfirmed` |
| after the spend, before the load | attempt record, spend confirmed, no bytes | re-spends and re-loads; the old spend is `wasted` |
| after the load, before any byte | same | same |
| part-way through archiving | attempt record + *some* bytes | re-spends and re-loads; the partial bytes become `orphans` |
| after every byte, before the completion write | attempt record + *all* bytes | **adopts** the page with its original spend — never charged twice |
| after the completion write | a complete page | continues at the next page |

Two things follow from that table and are deliberate:

- **Orphans are kept, never deleted and never claimed.** Raw-first (D2) means
  archived bytes are not tidied away, and a partially archived page cannot be
  told from a whole one after the fact. They are reported as
  `RESUMED_ORPHAN_CAPTURES`, counted, and claimed by no page.
- **"All its bytes" means something different per source shape (D403).** A
  source that hands the loop its captures has no ids until they are written, so
  everything above the attempt's high-water mark is that page's by construction
  and a **count** short of `expected` is a torn write. A source that archives
  through the network tap already knows its ids and records them — and must,
  because the tap also archives every other body the page fetched, so counting
  entries there would exceed `expected` on an ordinary page and re-spend a page
  that was entirely on disk. Adoption then means **every named id is present**.
  Both shapes refuse the same way: anything short is torn, re-loaded and
  re-paid, never adopted on the checkpoint's own claim.
- **One ledger line can be unattributable.** The window between a line
  committing and the checkpoint recording it is one write wide and cannot be
  closed by any ordering. The run reports it as `unconfirmed` — a bound, not a
  count. The ledger's true count for a run is always inside
  `[pages + wasted, pages + wasted + unconfirmed]`, so it can over-count and
  never under-count (D347).

## Costs and caps

One results page costs **one `search_page` and one `page_load`** (D343). Both
kinds land on the ledger for every M5 capability's `cost()`, uniformly.

Sub-caps live where every other capability's do, in
`src/core/budget/constants.ts` (D345). Nothing here can raise them.

## Bounds — a search is never read to the bottom

`MAX_PAGES_PER_RUN` is a ceiling that exists before the run does; `maxPages`
only ever lowers it. `--limit` stops on rows. `hasMore: false` ends the run as
`end-of-results` — the only stop that means *complete*. Every other stop is
partial and says so on the receipt.

A page whose `fingerprint` matches the page before it stops the run as
`no-advance`. The reference worker trusted the pager's own page number here and
could accept a re-render as an advance.

## Pause

Three ways to stop cleanly, all checked at a page boundary and all before the
next page is paid for:

- `stopRequested` — any predicate the capability wants.
- `pauseFileStop(run.dir)` — a `PAUSE` file in the run directory. An agent
  supervising a run has the run id and no pid.
- `installSignalPause()` — the first Ctrl-C stops at the boundary; the second
  restores the default handler and re-raises.

A paused run exits 0 with `complete: false` and resumes with `--run-id`. Budget
exhaustion mid-run is the same clean stop at exit 7 via `budgetStopError()`,
with the cap that refused named and the checkpoint intact.

## Using it

```ts
const outcome = await runPaged({
  run: ctx.run,
  budget: ctx.budget,             // RunBudget — already bound to run + capability
  archive: ctx.browser.archive,
  capability: "salesnav.leads.list",
  plan: normalizedSearchUrl,      // a resume under a different plan is refused
  limit: ctx.args.limit,
  stopRequested: pauseFileStop(ctx.run.dir),
  source: {
    async loadPage({ page, cursor, respent }) {
      const entries = await navigateAndCapture(page, cursor, respent);
      return { archived: entries, items: entries.rows, hasMore, cursor: next, fingerprint };
    },
  },
});
if (outcome.stop === "budget-exhausted") throw budgetStopError(outcome);
```

A source returns either `captures` (bodies the loop archives) or `archived`
(entries the network tap already wrote). Returning neither is
`PAGED_PAGE_NO_BYTES` — a page with no bytes is never checkpointed.

`outcome.loaded` holds only the pages *this session* loaded, with the source's
own `data`. Earlier sessions' bytes are in `raw/`; re-reading them is the
capability's decision, not the loop's.

## Contract tests

- `tests/paged-run-core.test.ts` — ordering, bounds, pause, dwell distribution.
- `tests/paged-run-resume.test.ts` — a 3-page run killed between **every**
  adjacent pair of steps, resumed, converged; plus corroboration against the
  archive.
- `tests/paged-run-budget.test.ts` — mid-run exhaustion, resume after it, and
  the salesnav sub-caps.
