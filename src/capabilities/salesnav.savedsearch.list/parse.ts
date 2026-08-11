import type { SearchKind } from "../../core/store/types.js";

export const MAX_SAVED_SEARCHES_PER_VERTICAL = 50;

export type SavedSearchParseWarning = { code: string; n: number; field: string };

export type SavedSearchRow = {
  /** Store identity: vertical-prefixed because the two remote id namespaces
   * have not been proved globally disjoint. */
  search_id: string;
  /** The numeric id LinkedIn expects in `savedSearchId=`. */
  saved_search_id: string;
  kind: SearchKind;
  label: string | null;
  filter_url: string;
  created_at: string | null;
  last_viewed_at: string | null;
  filters_count: number;
  has_keywords: boolean;
};

export type ParseSavedSearchesResult = {
  ok: boolean;
  searches: SavedSearchRow[];
  examined: number;
  /** `$.paging.count`, which is the **requested page size** echoed back — the
   *  measured bodies carry `count: 50` against the request's own `&count=50`
   *  while holding one row each. This envelope carries **no total**: there is no
   *  `paging.total` key and `paging.links` is empty. Do not read this as a
   *  count of the operator's saved searches (D407's lesson, same shape). */
  requested_count: number | null;
  warnings: SavedSearchParseWarning[];
};

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function idOf(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d{0,19}$/.test(value)) return value;
  return null;
}

function epochIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function savedSearchUrl(kind: SearchKind, savedSearchId: string): string {
  const path = kind === "sn_leads" ? "people" : "company";
  const url = new URL(`https://www.linkedin.com/sales/search/${path}`);
  url.searchParams.set("savedSearchId", savedSearchId);
  return url.toString();
}

export function parseSavedSearches(body: string, kind: SearchKind): ParseSavedSearchesResult {
  let root: unknown;
  try { root = JSON.parse(body); } catch {
    return {
      ok: false, searches: [], examined: 0, requested_count: null,
      warnings: [{ code: "SAVED_SEARCH_ENVELOPE_MISSING", n: 1, field: "body is not JSON" }],
    };
  }
  const envelope = record(root);
  const elements = envelope?.["elements"];
  if (!Array.isArray(elements)) {
    return {
      ok: false, searches: [], examined: 0, requested_count: null,
      warnings: [{ code: "SAVED_SEARCH_ENVELOPE_MISSING", n: 1, field: "$.elements[] is missing" }],
    };
  }

  const warnings: SavedSearchParseWarning[] = [];
  const rows = elements.slice(0, MAX_SAVED_SEARCHES_PER_VERTICAL);
  const searches: SavedSearchRow[] = [];
  const seen = new Set<string>();
  let noIdentity = 0;
  let noLabel = 0;
  let noCreated = 0;
  let noViewed = 0;
  let duplicate = 0;

  for (const candidate of rows) {
    const row = record(candidate);
    const savedId = idOf(row?.["id"]);
    if (row === null || savedId === null) { noIdentity++; continue; }
    const searchId = `${kind}:${savedId}`;
    if (seen.has(searchId)) { duplicate++; continue; }
    seen.add(searchId);
    const label = stringOf(row["name"]);
    const created = epochIso(row["createdAt"]);
    const viewed = epochIso(row["lastViewedAt"]);
    if (label === null) noLabel++;
    if (created === null) noCreated++;
    if (viewed === null) noViewed++;
    searches.push({
      search_id: searchId,
      saved_search_id: savedId,
      kind,
      label,
      filter_url: savedSearchUrl(kind, savedId),
      created_at: created,
      last_viewed_at: viewed,
      filters_count: Array.isArray(row["filters"]) ? row["filters"].length : 0,
      has_keywords: stringOf(row["keywords"]) !== null,
    });
  }

  const examined = rows.length;
  const countRaw = record(envelope?.["paging"])?.["count"];
  const requestedCount = typeof countRaw === "number" && Number.isInteger(countRaw) && countRaw >= 0
    ? countRaw
    : null;
  if (elements.length > MAX_SAVED_SEARCHES_PER_VERTICAL) warnings.push({
    code: "SAVED_SEARCHES_NOT_EXAMINED", n: elements.length - MAX_SAVED_SEARCHES_PER_VERTICAL,
    field: `${elements.length - MAX_SAVED_SEARCHES_PER_VERTICAL} rows exceeded the ${MAX_SAVED_SEARCHES_PER_VERTICAL}-per-vertical bound`,
  });
  if (noIdentity > 0) warnings.push({
    code: "SAVED_SEARCH_ID_MISSING", n: noIdentity,
    field: `${noIdentity} of ${examined} examined rows had no positive saved-search id and were refused`,
  });
  if (duplicate > 0) warnings.push({
    code: "SAVED_SEARCH_ID_DUPLICATE", n: duplicate,
    field: `${duplicate} of ${examined} examined rows repeated a saved-search id and were refused`,
  });
  if (noLabel > 0) warnings.push({
    code: "SAVED_SEARCH_LABEL_MISSING", n: noLabel,
    field: `${noLabel} of ${searches.length} usable rows had no operator label`,
  });
  if (noCreated > 0) warnings.push({
    code: "SAVED_SEARCH_CREATED_AT_MISSING", n: noCreated,
    field: `${noCreated} of ${searches.length} usable rows had no absolute creation time`,
  });
  if (noViewed > 0) warnings.push({
    code: "SAVED_SEARCH_LAST_VIEWED_AT_MISSING", n: noViewed,
    field: `${noViewed} of ${searches.length} usable rows had no absolute last-viewed time`,
  });
  return { ok: true, searches, examined, requested_count: requestedCount, warnings };
}
