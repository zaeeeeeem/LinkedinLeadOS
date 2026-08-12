# `salesnav.filters.probe`

Task 42's one-page measuring capability. It accepts a typed LEAD `FilterSpec`, runs the
Task 41 provenance-backed builder before any spend, and navigates exactly once to the URL
that builder returns. It never accepts a URL argument, so a caller cannot bypass vocabulary
validation or hand it a query assembled elsewhere.

The tap archives the untouched page response, `salesApiLeadSearch`, filter-layout and other
Sales Navigator bodies before this capability reads them. The receipt contains only counts,
SHA-256 digests, archive ids, `paging.total/count/start`, per-filter echo verdicts, privacy-safe
filter-metadata counts, catalog-hash status and interaction counts. Filter values and result
rows stay in the archive; nothing is stored in Supabase.

Cost per invocation: **1 page load + 1 search page + 0 profile opens**. The daily capability
sub-cap is **6/6/0**, matching Task 42's hard cross-session budget. Page 1 only; zero clicks,
keystrokes and wheel events.

Failure modes include ordinary budget/auth/challenge exits plus parse-drift exit 5 when the
named search response is absent, its captured request has no query, paging is missing, more
than one incompatible search query fires, or the response identifies a page other than page 1.
Catalog hash drift is a warning here unless it breaks the probe's own paging/query claim; Task
44 decides the production apply behavior from the promoted evidence.

Example:

```bash
./node_modules/.bin/tsx src/cli/index.ts salesnav.filters.probe --spec="$TASK42_SPEC_JSON"
```

For an operator-scoped spec, keep the JSON in a shell variable and invoke the local CLI
directly. Do not use the npm script wrapper: npm echoes the expanded command line before the
receipt and would print private filter values (D432).

Every invocation is live and requires fresh operator approval immediately before execution.
