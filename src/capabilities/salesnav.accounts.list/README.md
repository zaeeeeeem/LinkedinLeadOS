# `salesnav.accounts.list` parser contract

Task 38 supplies the pure page parser; Task 40 wires capture, pagination and the CLI.
`parseSalesNavAccounts` accepts one archived `salesApiAccountSearch` body and returns at most
25 rows with offset paging, page-relative positions, the stable plain
`urn:li:fs_salesCompany:<id>` identity, a deterministic Sales Nav company URL, and every
labeled row field pinned by the probe FIELD-MAP.

Rows are tagged `source: "labeled-body"`. There is deliberately no location projection: the
measured response carries location only in filter facets, not per account (D406). Invalid
identity or required-field drift refuses the row; the parser never reads the DOM. No browser,
page load, search page, store write or receipt is involved in this module.

The CLI name is registered as a zero-cost local refusal until Task 40 lands. It cannot acquire
a browser or spend; `cap salesnav.accounts.list` returns `CAPABILITY_NOT_IMPLEMENTED` meanwhile.

Task 40 stores only `search_id`, page, position, `company_urn` and `run_ref` in
`search_results`. It does not insert or freshen `companies`. Query provenance with:

```sql
select search_id, page, position, company_urn, run_ref
from search_results
where search_id = '<search id>'
order by page, position;
```
