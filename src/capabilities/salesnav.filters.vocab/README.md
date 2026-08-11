# `salesnav.filters.vocab`

Offline vocabulary inspection and archive harvesting. It costs 0 page loads, 0 search pages
and 0 profile opens, needs no browser or LinkedIn session, and never emits a request.

Operations:

- `lookup` — `--vertical=LEAD|ACCOUNT --facet=<TYPE> --text=<display text>`.
- `list` — `--vertical=... --facet=...`, bounded by `--limit` (default 50, max 100).
- `audit` — `--row-id=<24 hex chars>` re-harvests the named archived source and requires the
  exact vertical/facet/id/text tuple at the recorded locator.
- `harvest` — `--run-ids=<id,id,...>` reads request meta files and
  `salesApiSavedSearchesV2` bodies only. It writes non-private rows to the committed registry
  and PERSONA/list/CRM rows to `runs/salesnav-filter-vocabulary.private.json`, which is already
  under the gitignored archive root.

Every row carries a deterministic row id and one or more provenance records: run id, archive
id, source file, source kind and locator. A missing or malformed provenance list is parse drift,
not a row to use anyway. Merging refuses one `(vertical, facet, id)` resolving to different
display text; private rows cannot silently shadow public rows.

Only exact endpoint pathnames and 2xx response sidecars are eligible. A malformed metadata file,
query, body or non-2xx response is skipped with a typed warning and counted on the receipt; a
bad sibling capture does not discard valid rows from the rest of the harvest (D429). Bad run ids
and unreadable run directories are usage failures (exit 1), while a corrupt registry is parse
drift (exit 5).

No Supabase table is used (D420), so there are no database queries. The audit operation is the
verification recipe: choose a row from `list`, then audit its `row_id` against the archive.
When the operator archive is absent, committed public rows can resolve against the scrubbed,
hash-pinned archive fixture under `src/core/salesnav-query/test-fixtures/archive/`.
