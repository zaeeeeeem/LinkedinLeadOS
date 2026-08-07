import { getStore, storeError } from "./client.js";
import { TABLES } from "./constants.js";
import { StoreWriteError, type StoreOpts } from "./persons.js";
import type { CompanyPostInput, CompanyPostsUpsertResult } from "./types.js";

function compact(value: CompanyPostInput): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/** One atomic batch. first_seen is database-owned; last_seen is appended last. */
export async function upsertCompanyPosts(
  posts: readonly CompanyPostInput[],
  opts: StoreOpts = {},
): Promise<CompanyPostsUpsertResult> {
  if (posts.length === 0) return { rows: 0 };
  const client = opts.client ?? getStore();
  const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const rows = posts.map((post) => ({ ...compact(post), last_seen: stamp }));
  const result = await client.from(TABLES.companyPosts)
    .upsert(rows, { onConflict: "urn" }).select("urn");
  if (result.error) {
    throw new StoreWriteError(storeError({
      op: "upsert company posts", table: TABLES.companyPosts, kind: "write",
      status: result.status, cause: result.error,
    }), 0);
  }
  return { rows: result.data?.length ?? posts.length };
}
