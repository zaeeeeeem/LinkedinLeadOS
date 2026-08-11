# `salesnav.leads.list`

Reads a bounded Sales Navigator people search from the labeled
`salesApiLeadSearch` response, page by page. Page 1 is a normal navigation. Later pages use
the measured, resolved-or-refused Next control through `HumanCursor`; the response body's
`paging.start` proves which page arrived. The capability never opens a lead and never reads a
result field from the DOM.

## Arguments

| argument | default | contract |
|---|---:|---|
| `--url` | required on a fresh run | A LinkedIn `/sales/search/people` URL. Query parameters are preserved. Resume may omit it and recover the exact plan from the checkpoint. |
| `--pages` | `2` | Total page ceiling for the run, including pages proved by an earlier process; 1–20. |
| `--limit` | `50` | Result-row ceiling; 1–500. It never raises the page ceiling. |
| `--scrolls` | randomized 3–6 | Optional measured-scroll override; 0–12. The live gate uses the default. |
| `--capture-timeout-ms` | `60000` | Wait for the named lead-search response; 100–120000 ms. |
| `--layout-timeout-ms` | `60000` | Wait for render confirmation before the page read; 10–120000 ms. |

One results page costs one `page_load` and one `search_page` (D343). `cost()` reports the
requested page ceiling, so the default estimate is 2 + 2. Actual receipt cost comes from the
ledger. Freshness does not apply: a fresh rerun receives a fresh run/search id and spends
again. `--run-id=<id>` resumes the same observation.

## Resume contract

`runPaged` owns spend → load → archive → checkpoint. The tap-driven source returns the exact
archive filenames it claims; resume corroborates those files on disk and never adopts a page
by counting unrelated tap captures (D403). The checkpoint carries only page numbers, paging
offsets, a hash of stable person urns, the Sales Navigator `sessionId`, and click metadata—no
third-party names, headlines or URLs.

A hard-killed process also leaves its worker target id in `run.json`. Resume reattaches only
to that exact run-owned page so a click-only next page keeps the proved result-set session;
if Chrome no longer has the target, it refuses rather than loading page 1 again. Normal
teardown clears the id because it closes the worker tab.

The tab must still be on the prior proved page and carry the same `sessionId` before Next is
pressed. A changed session is a different result set and raises `SALESNAV_SESSION_CHANGED`;
an unchanged pager/body offset raises `PAGE_DID_NOT_ADVANCE`. A challenge merges its marker
beside the paged checkpoint, takes a screenshot and exits 2, leaving the run resumable.

Storage is projected from every page whose archive claims survive reconciliation, including
pages loaded by a prior process or adopted after a kill. That is deliberately after the paged
loop: putting store writes inside `loadPage` would create a checkpoint/store interleaving the
core cannot prove. Existing positions are adopted; a different identity at a stored position
is refused.

## Storage

`search_id` is the run id: stable across resume, new on a fresh rerun. The capability creates
or corroborates an immutable `searches(kind='sn_leads')` definition, mirrors the parent `runs`
row required by `search_results.run_ref`, and inserts one bounded page per write with only:

- `search_id`
- page-relative `page` and `position`
- `person_urn`
- `run_ref`

It never inserts or updates `persons`, `companies`, or either table's `last_seen`. Use
`--no-store` for archive-only execution.

```sql
select search_id, page, position, person_urn, run_ref
from search_results
where search_id = '<run id>'
order by page, position;
```

## Failure modes

- Exit 2/3/4: challenge, rate limit, or dead session from the existing challenge gate. No
  challenge is solved or retried.
- Exit 5: reserved for LinkedIn response-shape drift.
- Exit 6: transient CDP, tap, lease, or store availability failure.
- Exit 7: a global, capability, or invocation budget stops the run. Completed pages remain
  archive-proved and resumable.
- Exit 1: unresolved pager control, wrong search vertical/start page, changed result-set
  session, non-advancing body offset, ambiguous body identities, or immutable store conflict.

Receipts contain counts, page numbers, run/search ids and the accessible name of any pager
control pressed. They never contain returned names, headlines, profile URLs, or filter URLs.
