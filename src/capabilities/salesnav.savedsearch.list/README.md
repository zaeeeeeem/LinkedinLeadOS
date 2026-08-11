# `salesnav.savedsearch.list`

Lists the operator's Lead and Account saved searches from the Saved searches
panel on `/sales/`. It is read-only: it does not run a search, open a result,
save a list, or perform any L3 action.

```sh
npm run cap -- salesnav.savedsearch.list
```

## Source and navigation

One metered navigation loads `/sales/`. The capability then takes two measured,
resolved-or-refused trusted clicks:

1. D408's unique `button[data-x--link--saved-searches]` opens the operator's
   panel and loads the default Lead list.
2. D409's measured Account tab switches that same panel to Account searches.

Both controls have no href, create no third-party trace, and are recorded on the
receipt. They use `HumanCursor`, wheel reveal, and D404's centre-point hit test.
No saved-search row is clicked.

Rows come only from archived `salesApiSavedSearchesV2` response bodies. The DOM
snapshot corroborates the panel and the UI-produced re-execution route; it
supplies no row field. A missing or unparseable labeled body is parse drift, while
a valid `elements: []` envelope is an empty list.

## Output and privacy

Each row contains a vertical-prefixed store identity, the remote saved-search id,
kind, operator-authored label, derived `filter_url`, timestamps, filter count, and
whether keywords exist. Filter values, keyword text, seat data, and any
third-party result name stay in the raw archive. Operator labels are intentionally
allowed because they are how the operator selects a saved search (D364).

The parser examines at most 50 rows per vertical. Excess rows and rows without a
positive identity are refused with named warnings; optional missing fields warn.

## Budget and storage

- Per invocation: 1 page load, 0 search pages, 0 profile opens.
- Task 37 live research used 3 page loads rather than its planned 2: the first
  positive row was saved under Account while the panel defaults to Lead, so the
  Account tab had to be measured before it could be clicked.
- Listing writes no database rows. Under D363, the matching Task 39/40 execution
  inserts the immutable `searches` definition immediately before its first result
  rows. Re-execution reuses that identity; it cannot upsert or move old results.

Raw bodies and the open-panel snapshot remain available through the run artifacts.
