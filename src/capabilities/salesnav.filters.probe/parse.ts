import { createHash } from "node:crypto";
import { parseSalesNavQuery, rawUrlParam, type QueryObject, type QueryValue } from "../../core/salesnav-query/grammar.js";

export class FilterProbeParseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FilterProbeParseError";
  }
}

export type SearchPaging = { total: number; count: number; start: number };
export type SearchFilterMetadata = {
  filter_blocks: number;
  value_rows: number;
  selected_value_rows: number;
  selected_filter_types: string[];
};
export type FilterEchoVerdict = "honored" | "rewritten" | "dropped";
export type RecentSearchEchoVerdict = FilterEchoVerdict | "injected" | "absent";
export type QueryEcho = {
  filters: Array<{ type: string; verdict: FilterEchoVerdict }>;
  injected_filter_types: string[];
  recent_search: RecentSearchEchoVerdict;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseSearchPaging(body: string): SearchPaging {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    throw new FilterProbeParseError("FILTER_PROBE_SEARCH_BODY_INVALID", "the named search body is not JSON");
  }
  const paging = object(object(root)?.["paging"]);
  const total = nonNegativeInteger(paging?.["total"]);
  const count = nonNegativeInteger(paging?.["count"]);
  const start = nonNegativeInteger(paging?.["start"]);
  if (total === null || count === null || start === null) {
    throw new FilterProbeParseError(
      "FILTER_PROBE_PAGING_MISSING",
      "the named search body does not carry non-negative integer paging.total/count/start",
    );
  }
  return { total, count, start };
}

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

export function requestQuery(url: string): string {
  const raw = rawUrlParam(url, "query");
  if (raw === null || raw === "") {
    throw new FilterProbeParseError("FILTER_PROBE_REQUEST_QUERY_MISSING", "the captured search request has no query parameter");
  }
  return raw;
}

export function queryDigest(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export function bodyDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function parsedQuery(raw: string, side: "built" | "captured"): QueryObject {
  try {
    return parseSalesNavQuery(raw);
  } catch (cause) {
    throw new FilterProbeParseError(
      "FILTER_PROBE_QUERY_COMPARE_INVALID",
      `${side} query cannot be compared: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function child(parent: QueryObject, key: string): QueryValue | null {
  return parent.entries.find((entry) => entry.key === key)?.value ?? null;
}

function filtersByType(root: QueryObject, side: "built" | "captured"): Map<string, QueryObject> {
  const filters = child(root, "filters");
  if (filters?.kind !== "list") {
    throw new FilterProbeParseError("FILTER_PROBE_QUERY_COMPARE_INVALID", `${side} query has no filters list`);
  }
  const result = new Map<string, QueryObject>();
  for (const candidate of filters.items) {
    if (candidate.kind !== "object") {
      throw new FilterProbeParseError("FILTER_PROBE_QUERY_COMPARE_INVALID", `${side} query has a non-object filter`);
    }
    const type = child(candidate, "type");
    if (type?.kind !== "atom" || type.value === "") {
      throw new FilterProbeParseError("FILTER_PROBE_QUERY_COMPARE_INVALID", `${side} query has a filter without a type`);
    }
    if (result.has(type.value)) {
      throw new FilterProbeParseError("FILTER_PROBE_QUERY_COMPARE_INVALID", `${side} query repeats filter type ${type.value}`);
    }
    result.set(type.value, candidate);
  }
  return result;
}

function structuralEqual(left: QueryValue | null, right: QueryValue | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Privacy-safe, field-for-field comparison of the builder output with the
 * captured request query. Values never leave this function; only filter type
 * names and verdicts do. Reordering a filter subtree is a rewrite because the
 * evidence contract is exact captured-wire fidelity, not semantic guessing. */
export function compareQueryEcho(built: string, captured: string): QueryEcho {
  const builtRoot = parsedQuery(built, "built");
  const capturedRoot = parsedQuery(captured, "captured");
  const builtFilters = filtersByType(builtRoot, "built");
  const capturedFilters = filtersByType(capturedRoot, "captured");
  const filters = [...builtFilters].map(([type, expected]) => {
    const observed = capturedFilters.get(type);
    const verdict: FilterEchoVerdict = observed === undefined
      ? "dropped"
      : structuralEqual(expected, observed) ? "honored" : "rewritten";
    return { type, verdict };
  });
  const injected = [...capturedFilters.keys()].filter((type) => !builtFilters.has(type));
  const builtRecent = child(builtRoot, "recentSearchParam");
  const capturedRecent = child(capturedRoot, "recentSearchParam");
  const recent_search: RecentSearchEchoVerdict = builtRecent === null && capturedRecent === null
    ? "absent"
    : builtRecent === null ? "injected"
    : capturedRecent === null ? "dropped"
    : structuralEqual(builtRecent, capturedRecent) ? "honored" : "rewritten";
  return { filters, injected_filter_types: injected, recent_search };
}
