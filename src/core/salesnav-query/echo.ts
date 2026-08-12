import { createHash } from "node:crypto";
import { parseSalesNavQuery, rawUrlParam, type QueryObject, type QueryValue } from "./grammar.js";

/**
 * The captured-wire echo comparator, promoted out of `salesnav.filters.probe`
 * so Task 44's `salesnav.filters.apply` reuses the one verdict rule rather than
 * forking it (D452). The probe keeps its own error codes by wrapping this class.
 *
 * Everything here is pure: strings in, verdicts out, no I/O and no network in the
 * dependency graph. Filter *values* never leave these functions — only filter
 * type names and verdicts do.
 */
export class QueryEchoError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "QueryEchoError";
  }
}

export type SearchPaging = { total: number; count: number; start: number };
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

function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new QueryEchoError("SEARCH_BODY_INVALID", "the named search body is not JSON");
  }
}

export function parseSearchPaging(body: string): SearchPaging {
  const paging = object(object(parsedBody(body))?.["paging"]);
  const total = nonNegativeInteger(paging?.["total"]);
  const count = nonNegativeInteger(paging?.["count"]);
  const start = nonNegativeInteger(paging?.["start"]);
  if (total === null || count === null || start === null) {
    throw new QueryEchoError(
      "PAGING_MISSING",
      "the named search body does not carry non-negative integer paging.total/count/start",
    );
  }
  return { total, count, start };
}

/**
 * The session LinkedIn minted for this execution, read from the one place it is
 * measured on a cold page-1 load: `$.metadata.tracking.sessionId` of the named
 * search response (run `01KZSZF6MXC6HHP9Z4RQBHXP19`, archive
 * `0016-5e81b94c63cd41b8`). The page-1 *request* carries no `trackingParam` —
 * that appears from page 2 on (D360/D413) — so the request URL is not a source
 * here, and the address bar is never one.
 *
 * Absent is a real answer, not an error: a body that does not carry the field
 * yields `null` and the caller reports it missing rather than inventing one.
 */
export function parseSearchSessionId(body: string): string | null {
  const tracking = object(object(object(parsedBody(body))?.["metadata"])?.["tracking"]);
  const sessionId = tracking?.["sessionId"];
  return typeof sessionId === "string" && sessionId !== "" ? sessionId : null;
}

export function requestQuery(url: string): string {
  const raw = rawUrlParam(url, "query");
  if (raw === null || raw === "") {
    throw new QueryEchoError("REQUEST_QUERY_MISSING", "the captured search request has no query parameter");
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
    throw new QueryEchoError(
      "QUERY_COMPARE_INVALID",
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
    throw new QueryEchoError("QUERY_COMPARE_INVALID", `${side} query has no filters list`);
  }
  const result = new Map<string, QueryObject>();
  for (const candidate of filters.items) {
    if (candidate.kind !== "object") {
      throw new QueryEchoError("QUERY_COMPARE_INVALID", `${side} query has a non-object filter`);
    }
    const type = child(candidate, "type");
    if (type?.kind !== "atom" || type.value === "") {
      throw new QueryEchoError("QUERY_COMPARE_INVALID", `${side} query has a filter without a type`);
    }
    if (result.has(type.value)) {
      throw new QueryEchoError("QUERY_COMPARE_INVALID", `${side} query repeats filter type ${type.value}`);
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
 * evidence contract is exact captured-wire fidelity, not semantic guessing (D433). */
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
