import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError, type StoreOpts } from "./persons.js";
import type { CompanyInput, CompanyRow, CompanyUpsertResult, StoredCompany } from "./types.js";

function compact<T extends object>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** One atomic request. `first_seen` is never sent; `last_seen` is appended last. */
export async function upsertCompany(input: CompanyInput, opts: StoreOpts = {}): Promise<CompanyUpsertResult> {
  const client = opts.client ?? getStore();
  const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const result = await client.from(TABLES.companies)
    .upsert({ ...compact(input), last_seen: stamp }, { onConflict: "urn" })
    .select("urn");
  if (result.error) {
    throw new StoreWriteError(storeError({
      op: "upsert company", table: TABLES.companies, kind: "write",
      status: result.status, cause: result.error,
    }), 0);
  }
  return { urn: input.urn, rows: 1 };
}

export async function findCompanyByUrn(urn: string, opts: StoreOpts = {}): Promise<StoredCompany | null> {
  const client = opts.client ?? getStore();
  const result = await client.from(TABLES.companies).select("*").eq("urn", urn).maybeSingle();
  if (result.error) throw storeError({ op: "select company by urn", table: TABLES.companies, kind: "read", status: result.status, cause: result.error });
  return result.data ? { company: result.data as CompanyRow } : null;
}

export async function findCompanyByVanity(vanity: string, opts: StoreOpts = {}): Promise<StoredCompany | null> {
  const client = opts.client ?? getStore();
  const result = await client.from(TABLES.companies).select("*", { count: "exact" })
    .eq("vanity", vanity).order("last_seen", { ascending: false }).limit(1);
  if (result.error) throw storeError({ op: "select company by vanity", table: TABLES.companies, kind: "read", status: result.status, cause: result.error });
  const row = (result.data?.[0] ?? null) as CompanyRow | null;
  return row === null ? null : { company: row, vanityMatches: result.count ?? result.data?.length ?? 0 };
}
