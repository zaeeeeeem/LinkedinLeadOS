import {
  QueryEchoError,
  compareQueryEcho as compareEcho,
  parseSearchPaging as parsePaging,
  requestQuery as readRequestQuery,
  type QueryEcho,
  type SearchPaging,
} from "../../core/salesnav-query/echo.js";

export { bodyDigest, queryDigest } from "../../core/salesnav-query/echo.js";
export type {
  FilterEchoVerdict,
  QueryEcho,
  RecentSearchEchoVerdict,
  SearchPaging,
} from "../../core/salesnav-query/echo.js";

export class FilterProbeParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FilterProbeParseError";
  }
}

/**
 * The comparator itself lives in `src/core/salesnav-query/echo.ts` so Task 44's
 * `salesnav.filters.apply` shares one verdict rule with this probe rather than
 * forking it (D452). This module is the adapter that keeps Task 42's measured
 * contract intact: the probe's `FILTER_PROBE_*` codes, which its receipts,
 * README and D430 all name, are unchanged.
 */
const CODES: Readonly<Record<string, string>> = {
  SEARCH_BODY_INVALID: "FILTER_PROBE_SEARCH_BODY_INVALID",
  PAGING_MISSING: "FILTER_PROBE_PAGING_MISSING",
  REQUEST_QUERY_MISSING: "FILTER_PROBE_REQUEST_QUERY_MISSING",
  QUERY_COMPARE_INVALID: "FILTER_PROBE_QUERY_COMPARE_INVALID",
};

function probeCodes<T>(fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    if (cause instanceof QueryEchoError) {
      throw new FilterProbeParseError(CODES[cause.code] ?? `FILTER_PROBE_${cause.code}`, cause.message);
    }
    throw cause;
  }
}

export type SearchFilterMetadata = {
  filter_blocks: number;
  value_rows: number;
  selected_value_rows: number;
  selected_filter_types: string[];
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function parseSearchPaging(body: string): SearchPaging {
  return probeCodes(() => parsePaging(body));
}

export function requestQuery(url: string): string {
  return probeCodes(() => readRequestQuery(url));
}

export function compareQueryEcho(built: string, captured: string): QueryEcho {
  return probeCodes(() => compareEcho(built, captured));
}

/** Task 42's passive-corroboration projection (D434): counts only, never the
 *  option values themselves. It stays here because it is the probe's measuring
 *  instrument, not part of apply's verdict. */
export function parseSearchFilterMetadata(body: string): SearchFilterMetadata {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    throw new FilterProbeParseError("FILTER_PROBE_SEARCH_BODY_INVALID", "the named search body is not JSON");
  }
  const filters = object(object(root)?.["metadata"])?.["filters"];
  if (!Array.isArray(filters)) return { filter_blocks: 0, value_rows: 0, selected_value_rows: 0, selected_filter_types: [] };
  let valueRows = 0;
  let selectedRows = 0;
  const selectedTypes = new Set<string>();
  for (const wrapper of filters) {
    const metadata = object(object(wrapper)?.["singleFilterMetadata"]);
    const type = metadata?.["type"];
    const values = metadata?.["values"];
    if (typeof type !== "string" || !Array.isArray(values)) continue;
    valueRows += values.length;
    for (const candidate of values) {
      const selectionType = object(candidate)?.["selectionType"];
      if (selectionType === "INCLUDED" || selectionType === "EXCLUDED") {
        selectedRows += 1;
        selectedTypes.add(type);
      }
    }
  }
  return {
    filter_blocks: filters.length,
    value_rows: valueRows,
    selected_value_rows: selectedRows,
    selected_filter_types: [...selectedTypes],
  };
}
