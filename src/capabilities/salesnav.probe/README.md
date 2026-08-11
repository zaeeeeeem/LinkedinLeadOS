# `salesnav.probe` — measure the Sales Navigator search surfaces

Loads the Sales Navigator surfaces and archives everything, so Task 38's parsers are
written against measurement instead of memory (D152). It **stores nothing and resolves no
identity**, and the only thing it reads out of a body is the two integers of `paging`
(below). Its product is what it leaves on disk plus the verdicts on its receipt.

It clicks exactly one kind of thing: the pager's **next** control, to reach page 2 — granted
by D400 on 2026-08-11 and bounded by every clause in [`pager.ts`](./pager.ts). Nothing else
on any page is clickable.

The measured results are in [`FIELD-MAP.md`](./FIELD-MAP.md). Read that before writing any
salesnav parser.

## The two verdicts it exists to produce

**1. Where do the result-row fields live** — a labeled network body, or the DOM only. The
answer decides whether M5 needs CLAUDE.md's DOM exception list to grow. *Measured
2026-08-10: labeled body (`salesApiLeadSearch`). The list does not grow.*

**2. How does the real UI reach page 2** — a url the address bar produces (a navigation) or
a script-only control (a click). *Measured 2026-08-10: click-only — 12 buttons, 0 anchors.
The operator granted the click on 2026-08-11 (D400), so the probe now reaches page 2 by
pressing next, and Tasks 39/40 are unblocked.*

**Which page actually arrived is read from the body**, never from the pager's label: a
re-render can advance the label without changing a row. `pagingFromCaptures` takes
`paging.start` / `paging.count` out of the largest non-document body and the receipt reports
them under `data.verdicts.paging`; a clicked surface with no advanced offset raises
`PAGE_DID_NOT_ADVANCE` rather than being promoted as page 2.

Both land on the receipt under `data.verdicts`, not as prose to be inferred from counts.

## Usage

```bash
# The seat check on its own — 1 page load, 0 search pages.
npm run cap -- salesnav.probe --surfaces=home

# A real leads search, page 1, and page 2 only if page 1 proves the ui offers it.
npm run cap -- salesnav.probe --surfaces=leads,leads2 --url='<a search url the ui produced>'
```

| flag | meaning |
|---|---|
| `--url` | the leads search to probe. Omitted: `/sales/search/people` |
| `--accountsUrl` | the accounts search. Omitted: `/sales/search/company` |
| `--surfaces` | `home,leads,leads2,accounts`. Omitted: all four |
| `--scrolls` | scroll passes per surface. Omitted: `profile.capture`'s randomized 3–6 |

**Do not pass a filter url you built yourself.** M6 owns filter building; a probe of an
invented query measures a page the product does not itself produce. Use a saved search, or
a search url copied from a link the Sales Navigator UI itself rendered. The unfiltered
default urls render an empty search-entry state with **zero rows** — measured, and useless
as a fixture.

## Cost

| surface | page loads | search pages |
|---|---|---|
| `home` | 1 | 0 — the app shell runs no search |
| `leads` / `leads2` / `accounts` | 1 each | 1 each (D343) |

Ceilings: `PROBE_MAX_PAGE_LOADS` 10, `PROBE_MAX_SEARCH_PAGES` 10 (raised from 6/6 on
2026-08-11, D401), neither raisable by a flag. The daily sub-caps are in
`src/core/budget/constants.ts` — also 10/10 — and nothing here can raise them.

`cost()` reports page 2 as if it will be loaded. It is skipped whenever no pager rendered,
and an estimate that under-states is the one direction a budget estimate must never take.

**A clicked page costs exactly what a navigated one costs** (D400 clause 5). Clicking is
cheaper in wall-clock than a navigation and that must never turn into paging faster or
further: the same two ledger lines, the same sub-caps, the same dwell.

## The order it runs in, and why

1. **`home` first — the seat check.** `/sales/` renders the app or an upsell. An upsell ends
   the run: `SALESNAV_NO_SEAT`, exit 1, no retry, `[DECISION NEEDED]`. It runs before
   anything metered so a seatless account never spends a search page.

   The verdict is three-valued. A surface that could not be measured returns `null`, not
   `false` — an unmeasurable page is a different failure, and calling it seatless would send
   the operator to buy something they may already own.

2. **`leads`** — one metered search page.

3. **`leads2`, reached the way page 1 proved the UI reaches it.** An href carrying `page=N`
   makes it a navigation; a buttons-only pager makes it a click on **next** (D400). A page
   that rendered no pager at all is skipped, unspent, with the reason on the receipt —
   there is no page 2 to reach and spending one to find that out measures nothing. This is
   the gate that keeps the probe inside M5 CONTEXT rule 4.

4. **`accounts`** — one metered search page.

Per surface: budget checked, then spent, then navigated (§8 — a crash mid-load must leave
the ledger over-counting); challenge gate after navigation *and* before the surface is
declared done; `readLikeAHuman` for pacing; DOM snapshot archived; `tap.drain()` in a
`finally` covering the whole loop, so a throw on surface three still leaves one and two
fully archived.

## What the structural measurement may return

Counts, tag names, element ids, attribute **names**, page **numbers** and booleans. Never a
row's text, never an href — a pager href carries the operator's whole filter blob, so the
probe reports *whether* it paginates and *which page* it points at, and the href itself
stays in the archived snapshot. Receipts go to stdout (§4.1, D3) and search results are
third parties (M5 CONTEXT rule 6).

Every page-controlled string is clamped in `interpretSurface`, on the way in. "The browser
would not do that" is not a bound.

## Fixtures

`salesApiNavChrome` carries the operator's own `fs_salesProfile` and is excluded as a
private endpoint (D118/D119) — the promoter skipped 8 such bodies on the 2026-08-10 run.

A search surface has **no single subject**, so the promoter's subject-scoping does not apply
here and it falls back to "any body carrying person data". That is correct for this surface
and is why its fixtures stay gitignored while `FIELD-MAP.md` and
`tests/salesnav-fieldmap.test.ts` are what land in git.

## Tests

- `tests/salesnav-probe-url.test.ts` — url normalization; the query is **preserved**, unlike
  every other normalizer in the repo, because on a search the query is the target.
- `tests/salesnav-probe-surface.test.ts` — the measurement's bounds against a hostile page,
  and the pagination verdict.
- `tests/salesnav-probe-verdicts.test.ts` — the seat gate, the page-2 gate, the source
  verdict, and every warning branch.
- `tests/salesnav-pager-click.test.ts` — the click: name matching, every refusal branch,
  wheel-to-reveal, and the body-side arrival check. Its headline assertion is that nothing
  is clicked on any refusal path.
- `tests/salesnav-fieldmap.test.ts` — every FIELD-MAP path against the promoted fixture.
  Skips itself when the fixture is absent, because a gitignored fixture is not a defect.
