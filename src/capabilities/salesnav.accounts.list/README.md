# `salesnav.accounts.list`

`parseSalesNavAccounts` accepts one archived `salesApiAccountSearch` body and returns at most
25 rows with offset paging, page-relative positions, the stable plain
`urn:li:fs_salesCompany:<id>` identity, a deterministic Sales Nav company URL, and every
labeled row field pinned by the probe FIELD-MAP.

Rows are tagged `source: "labeled-body"`. There is deliberately no location projection: the
measured response carries location only in filter facets, not per account (D406). A row is
refused for its **identity only** — a malformed or non-company urn (D373) — and a refusal
leaves a gap in the page's positions rather than shifting the rows below it. Every other field
is content: its absence emits `PARSE_FIELD_MISSING` naming the field and the row is stored
without it. The parser never reads the DOM. No browser,
page load, search page, store write or receipt is involved in this module.

The live capability requires an operator-supplied `/sales/search/company` URL. Its defaults are
`--pages=2` and `--limit=50`; `--pages` may only lower Task 35's 20-page hard ceiling, and the
accounts daily sub-cap is 10 page loads / 10 search pages. Each results page costs one of each.
Page 1 navigates to the supplied URL. Later pages use the measured, trusted Next control and
accept arrival only from the named account-search body's offset under the same `sessionId`.

Raw bodies are archived before a page checkpoint. The capability uses the shared Task 35
`runPaged` module for spend, pacing, pause and archive-proved resume; it has no accounts-only
paged loop. `--run-id` resumes the original run and its persisted arguments. Challenges halt
with exit 2, parse drift with exit 5, budget exhaustion with exit 7 and a resumable receipt,
and an unchanged clicked offset refuses as `PAGE_DID_NOT_ADVANCE`.

Task 40 stores only `search_id`, page, position, `company_urn` and `run_ref` in
`search_results`, under a `searches` row with `kind: sn_accounts`. It does not insert or
freshen `persons` or `companies`. `--no-store` preserves capture and skips all database work.
Receipts contain counts, urns and page numbers, never company names or other third-party
display fields. Query provenance with:

```sql
select search_id, page, position, company_urn, run_ref
from search_results
where search_id = '<search id>'
order by page, position;
```
