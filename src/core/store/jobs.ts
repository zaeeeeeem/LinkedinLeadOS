import { getStore, storeError } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError, type StoreOpts } from "./persons.js";
import type { JobInput, JobsUpsertResult } from "./types.js";

function compact(value: JobInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** One atomic id-deduplicated batch. first_seen stays database-owned; last_seen is last. */
export async function upsertJobs(jobs: readonly JobInput[], opts: StoreOpts = {}): Promise<JobsUpsertResult> {
  const unique = [...new Map(jobs.map((row) => [row.id, row])).values()];
  if (unique.length === 0) return { rows: 0 };
  const client = opts.client ?? getStore(); const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const rows = unique.map((row) => ({ ...compact(row), last_seen: stamp }));
  const result = await client.from(TABLES.jobs).upsert(rows, { onConflict: "id" }).select("id");
  if (result.error) throw new StoreWriteError(storeError({ op: "upsert jobs", table: TABLES.jobs, kind: "write", status: result.status, cause: result.error }), 0);
  return { rows: result.data?.length ?? unique.length };
}
