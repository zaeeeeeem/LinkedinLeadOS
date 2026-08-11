-- Task 38 / D370. This is a new migration because the M1-M3 migration has
-- already been applied and is append-only (D99).
--
-- Search observations remain append-only across searches. Within one search,
-- page and position identify the row so a resumed page cannot double-insert it.
create unique index if not exists search_results_search_page_position_uidx
  on public.search_results (search_id, page, position);

comment on table public.search_results is
  'Append-only search provenance. The same entity in two searches is two rows; within one search, (search_id, page, position) identifies one observation so resume/re-run page writes are skipped, never replaced.';
