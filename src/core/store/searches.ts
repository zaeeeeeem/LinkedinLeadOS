import { CapabilityError, EXIT } from "../run/receipt.js";
import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError } from "./persons.js";
import type { SearchInput, SearchInsertResult, SearchResultInput, SearchResultsInsertResult } from "./types.js";

export type SearchStoreOpts = { client?: StoreClient };
export const MAX_SEARCH_RESULTS_PER_WRITE = 25;

type StoredSearch = { search_id: string; kind: string; filter_url: string | null; filter_json: unknown };

function invalid(field: string): CapabilityError {
  return new CapabilityError({
    code: "SEARCH_RESULT_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `search result write refused: ${field} is invalid`,
  });
}

function compactSearch(input: SearchInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

/**
 * Inserts one immutable search definition. `created_at` stays database-owned;
 * an existing `search_id` is a conflict, never a definition-changing upsert (D371).
 */
export async function insertSearch(input: SearchInput, opts: SearchStoreOpts = {}): Promise<SearchInsertResult> {
  const client = opts.client ?? getStore();
  const result = await client.from(TABLES.searches).insert(compactSearch(input)).select("search_id").single();
  if (result.error) throw new StoreWriteError(storeError({ op: "insert search", table: TABLES.searches, kind: "write", status: result.status, cause: result.error }), 0);
  return { search_id: input.search_id, rows: 1 };
}

/**
 * Resume-safe search initialization. A missing definition is inserted; an
 * identical one is adopted; a changed one is refused. This does not weaken
 * `insertSearch`'s insert-only contract — it is the corroboration path for a
 * run that may have died on either side of the first insert.
 */
export async function ensureSearch(input: SearchInput, opts: SearchStoreOpts = {}): Promise<SearchInsertResult & { inserted: boolean }> {
  const client = opts.client ?? getStore();
  const found = await client.from(TABLES.searches)
    .select("search_id,kind,filter_url,filter_json")
    .eq("search_id", input.search_id)
    .maybeSingle();
  if (found.error) throw storeError({ op: "select search", table: TABLES.searches, kind: "read", status: found.status, cause: found.error });
  const existing = found.data as StoredSearch | null;
  if (existing === null) {
    await insertSearch(input, { client });
    return { search_id: input.search_id, rows: 1, inserted: true };
  }
  const expectedUrl = input.filter_url ?? null;
  const expectedJson = input.filter_json ?? null;
  if (existing.kind !== input.kind || existing.filter_url !== expectedUrl || JSON.stringify(existing.filter_json) !== JSON.stringify(expectedJson)) {
    throw invalid("stored search definition");
  }
  return { search_id: input.search_id, rows: 1, inserted: false };
}

type PositionRow = { search_id: string; page: number; position: number; person_urn: string | null; company_urn: string | null };

function key(row: Pick<SearchResultInput, "search_id" | "page" | "position">): string {
  return `${row.search_id}\0${row.page}\0${row.position}`;
}

function validate(rows: readonly SearchResultInput[]): SearchResultInput[] {
  if (rows.length > MAX_SEARCH_RESULTS_PER_WRITE) throw invalid("rows bound");
  const byKey = new Map<string, SearchResultInput>();
  for (const row of rows) {
    const person = typeof row.person_urn === "string" && row.person_urn.length > 0;
    const company = typeof row.company_urn === "string" && row.company_urn.length > 0;
    if (!row.search_id || !Number.isInteger(row.page) || row.page < 1 || !Number.isInteger(row.position) || row.position < 1 || row.position > MAX_SEARCH_RESULTS_PER_WRITE || person === company) throw invalid("provenance");
    const existing = byKey.get(key(row));
    if (existing !== undefined && (existing.person_urn !== row.person_urn || existing.company_urn !== row.company_urn || existing.run_ref !== row.run_ref)) throw invalid("duplicate position");
    byKey.set(key(row), row);
  }
  return [...byKey.values()];
}

/**
 * Inserts immutable provenance rows. Existing `(search_id,page,position)` rows
 * are adopted and counted as skipped; nothing is updated or deleted (D370).
 *
 * All reads finish before the one insert, so a failure leaves either no new rows
 * or the whole missing batch. The unique index is the final race guard.
 */
export async function insertSearchResults(rows: readonly SearchResultInput[], opts: SearchStoreOpts = {}): Promise<SearchResultsInsertResult> {
  const unique = validate(rows);
  if (unique.length === 0) return { rows: 0, skipped: 0 };
  const client = opts.client ?? getStore();
  const groups = new Map<string, { searchId: string; page: number }>();
  for (const row of unique) groups.set(`${row.search_id}\0${row.page}`, { searchId: row.search_id, page: row.page });
  const present = new Map<string, PositionRow>();
  for (const group of groups.values()) {
    const found = await client.from(TABLES.searchResults).select("search_id,page,position,person_urn,company_urn").eq("search_id", group.searchId).eq("page", group.page);
    if (found.error) throw storeError({ op: "select stored search positions", table: TABLES.searchResults, kind: "read", status: found.status, cause: found.error });
    for (const row of (found.data ?? []) as PositionRow[]) present.set(key(row), row);
  }
  for (const row of unique) {
    const previous = present.get(key(row));
    if (previous !== undefined && (previous.person_urn !== (row.person_urn ?? null) || previous.company_urn !== (row.company_urn ?? null))) throw invalid("stored position identity");
  }
  const missing = unique.filter((row) => !present.has(key(row)));
  if (missing.length === 0) return { rows: 0, skipped: unique.length };
  const payload = missing.map((row) => ({
    search_id: row.search_id,
    page: row.page,
    position: row.position,
    person_urn: row.person_urn ?? null,
    company_urn: row.company_urn ?? null,
    run_ref: row.run_ref ?? null,
  }));
  const inserted = await client.from(TABLES.searchResults).insert(payload).select("id");
  if (inserted.error) throw new StoreWriteError(storeError({ op: "insert search results", table: TABLES.searchResults, kind: "write", status: inserted.status, cause: inserted.error }), 0);
  return { rows: inserted.data?.length ?? missing.length, skipped: unique.length - missing.length };
}
