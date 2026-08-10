import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError, type StoreOpts } from "./persons.js";
import type { JobInput, JobUpsertResult, JobsUpsertResult } from "./types.js";

/**
 * Both nullish forms are dropped, not just `undefined` — the same rule
 * `upsertJob` applies one function below, because both write the same row.
 *
 * The two writers arrive from opposite directions: `company.jobs` sees a list
 * of postings with a title and no description, `job.get` sees one posting with
 * a description. Whichever lands second must not erase what the first stored, so
 * neither may send a field it did not observe. `company.jobs` omits rather than
 * nulls today, so this is a guard on the contract rather than a live fix — but
 * the contract is what the other writer's monotonic promise rests on, and a
 * promise only one of two writers keeps is not one (D272).
 */
function compact(value: JobInput): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
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

/**
 * The description a collapsed job page yields is a prefix of the real one.
 *
 * Measured live on 2026-08-10, job 4434758293: `company.jobs` read 3602
 * characters out of the embedded JSON, then `job.get` read 940 from the
 * `expandable-text-box` — the page renders it collapsed, and nothing clicked
 * "see more" — and stored 1438, cutting the text mid-section at "What are we
 * looking for?". Re-running `company.jobs` restored the full text, so what a row
 * holds depended on which capability ran last.
 *
 * A truncation is the erasure the monotonic promise exists to prevent; it is
 * only partial. So the longer text wins. The cost is that a genuinely shortened
 * posting keeps its old description until something clears it explicitly, which
 * is the same trade D272 already made for absent fields, and the safer direction:
 * stale detail is recoverable, destroyed detail is not (D323).
 */
async function keepsStoredDescription(
  client: StoreClient,
  input: JobInput,
): Promise<boolean> {
  const incoming = input.description;
  if (typeof incoming !== "string" || incoming === "") return false;
  const found = await client.from(TABLES.jobs).select("description").eq("id", input.id).limit(1);
  // A failed read is not a reason to refuse the write: the field is being
  // enriched either way, and the worst case is the behaviour that shipped before.
  if (found.error) return false;
  const stored = (found.data?.[0] as { description?: string | null } | undefined)?.description;
  return typeof stored === "string" && stored.length > incoming.length;
}

/** One job, enriched monotonically: a null or absent field never erases detail already stored. */
export async function upsertJob(input: JobInput, opts: { client?: StoreClient; now?: number } = {}): Promise<JobUpsertResult> {
  const client = opts.client ?? getStore();
  const truncated = await keepsStoredDescription(client, input);
  const row: Record<string, unknown> = { last_seen: new Date(opts.now ?? Date.now()).toISOString() };
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (key === "description" && truncated) continue;
    row[key] = value;
  }
  const result = await client.from(TABLES.jobs).upsert(row, { onConflict: "id" }).select("id");
  if (result.error) throw storeError({ op: "upsert job", table: TABLES.jobs, kind: "write", status: result.status, cause: result.error });
  return { id: input.id, rows: 1, ...(truncated ? { descriptionKept: "stored" as const } : {}) };
}
