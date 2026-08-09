import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import type { JobInput, JobUpsertResult } from "./types.js";

export async function upsertJob(input: JobInput, opts: { client?: StoreClient; now?: number } = {}): Promise<JobUpsertResult> {
  const client = opts.client ?? getStore();
  const row: Record<string, unknown> = { last_seen: new Date(opts.now ?? Date.now()).toISOString() };
  for (const [key, value] of Object.entries(input)) if (value !== undefined) row[key] = value;
  const result = await client.from(TABLES.jobs).upsert(row, { onConflict: "id" }).select("id");
  if (result.error) throw storeError({ op: "upsert job", table: TABLES.jobs, kind: "write", status: result.status, cause: result.error });
  return { id: input.id, rows: 1 };
}
