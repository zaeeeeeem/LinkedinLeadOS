import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";

export type PostProjection = {
  urn: string;
  text: string | null;
  posted_at: string;
  reactions: number | null;
  comments: number | null;
};

export type OwnedPostProjection<K extends "person_urn" | "company_urn"> =
  PostProjection & Record<K, string>;

export async function upsertPostRows<K extends "person_urn" | "company_urn">(
  owner: K,
  rows: readonly OwnedPostProjection<K>[],
  opts: { client?: StoreClient; now?: number } = {},
): Promise<number> {
  if (rows.length === 0) return 0;
  const client = opts.client ?? getStore();
  const table = owner === "person_urn" ? TABLES.personPosts : TABLES.companyPosts;
  const last_seen = new Date(opts.now ?? Date.now()).toISOString();
  const payload = rows.map((row) => ({ ...row, last_seen }));
  const result = await client.from(table)
    // The unparameterized Supabase client cannot express a table selected by
    // the generic owner key; the public input type above is the compile-time
    // contract, and Postgres remains the runtime schema check.
    .upsert(payload as never[], { onConflict: "urn" })
    .select("urn");
  if (result.error) {
    throw storeError({
      op: "upsert post rows", table, kind: "write", status: result.status, cause: result.error,
    });
  }
  return (result.data ?? []).length;
}
