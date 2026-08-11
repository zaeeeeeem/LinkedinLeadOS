import { CapabilityError, EXIT } from "../run/receipt.js";
import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import type { RunRecordFinish, RunRecordInput } from "./types.js";

export type RunStoreOpts = { client?: StoreClient };

type StoredRun = { run_id: string; capability: string };

function mismatch(): CapabilityError {
  return new CapabilityError({
    code: "RUN_STORE_IDENTITY_MISMATCH",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "the store already has this run id under a different capability",
  });
}

/**
 * Ensures the database parent required by `search_results.run_ref` exists.
 *
 * A hard-killed run deliberately remains `running`. Resume reopens the same
 * row; a missing mirror is inserted, and a row belonging to another capability
 * is refused rather than adopted. No captured value reaches an error.
 */
export async function ensureRunRecord(input: RunRecordInput, opts: RunStoreOpts = {}): Promise<void> {
  const client = opts.client ?? getStore();
  const found = await client.from(TABLES.runs).select("run_id,capability").eq("run_id", input.run_id).maybeSingle();
  if (found.error) throw storeError({ op: "select run", table: TABLES.runs, kind: "read", status: found.status, cause: found.error });
  const existing = found.data as StoredRun | null;
  if (existing !== null && existing.capability !== input.capability) throw mismatch();

  if (existing === null) {
    const inserted = await client.from(TABLES.runs).insert({
      run_id: input.run_id,
      capability: input.capability,
      args: input.args,
      status: "running",
    }).select("run_id").single();
    if (inserted.error) throw storeError({ op: "insert run", table: TABLES.runs, kind: "write", status: inserted.status, cause: inserted.error });
    return;
  }

  const reopened = await client.from(TABLES.runs).update({
    status: "running",
    ended_at: null,
    exit_code: null,
  }).eq("run_id", input.run_id).select("run_id").single();
  if (reopened.error) throw storeError({ op: "resume run", table: TABLES.runs, kind: "write", status: reopened.status, cause: reopened.error });
}

/** Finalizes the mirrored run row. The local receipt remains the record of truth. */
export async function finishRunRecord(
  runId: string,
  finish: RunRecordFinish,
  opts: RunStoreOpts = {},
): Promise<void> {
  const client = opts.client ?? getStore();
  const updated = await client.from(TABLES.runs).update({
    ...finish,
    ended_at: new Date().toISOString(),
  }).eq("run_id", runId).select("run_id").single();
  if (updated.error) throw storeError({ op: "finish run", table: TABLES.runs, kind: "write", status: updated.status, cause: updated.error });
}
