# `salesnav.leads.list` parser contract

Task 38 supplies the pure page parser; Task 39 wires capture, pagination and the CLI.
`parseSalesNavLeads` accepts one archived `salesApiLeadSearch` body and returns at most 25
rows, page-relative positions, offset paging, the stable `objectUrn`, the compound Sales Nav
profile urn, deterministic Sales Nav profile/company URLs, and the labeled row fields pinned
by the probe FIELD-MAP.

Rows are tagged `source: "labeled-body"`. A row is refused for its **identity only** — a
malformed subject urn or the operator's own (D373) — and a refusal leaves a gap in the page's
positions rather than shifting the rows below it. Every other field is content: when LinkedIn
stops sending one, the parser emits `PARSE_FIELD_MISSING` naming that field and stores the row
without it, so a rename costs a field rather than a page. It never falls back to the DOM. No browser, page load, search page, store write or receipt is involved
in this module.

The CLI name is registered as a zero-cost local refusal until Task 39 lands. It cannot acquire
a browser or spend; `cap salesnav.leads.list` returns `CAPABILITY_NOT_IMPLEMENTED` meanwhile.

Task 39 stores only `search_id`, page, position, `person_urn` and `run_ref` in
`search_results`. It does not insert or freshen `persons`; enrichment remains an L1 read.
Query provenance with:

```sql
select search_id, page, position, person_urn, run_ref
from search_results
where search_id = '<search id>'
order by page, position;
```
