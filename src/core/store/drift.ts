import { CapabilityError, EXIT } from "../run/receipt.js";
import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";

/** A parser is currently bounded to at most 100 experience rows, with a few
 * warnings per row. This independent ceiling keeps a future caller from turning
 * one drift observation into an unbounded PostgREST payload. */
export const MAX_DRIFT_ROWS_PER_WRITE = 512;

export type ParseDriftObservation = {
  field: string;
  n: number;
};

export type DriftStoreOpts = {
  client?: StoreClient;
  capability: string;
  shapeHash: string | null;
};

/** Persists parser misses for aggregate SQL reporting. The run event remains
 * the forensic record used by `log.drift`; this table is the queryable mirror.
 * No `.select()` is chained, so a successful insert returns no captured data. */
export async function recordParseDrift(
  observations: readonly ParseDriftObservation[],
  opts: DriftStoreOpts,
): Promise<number> {
  if (observations.length === 0) return 0;
  if (observations.length > MAX_DRIFT_ROWS_PER_WRITE) {
    throw new CapabilityError({
      code: "STORE_WRITE_REJECTED",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message:
        `record parse drift on ${TABLES.parseDrift} refused ${observations.length} rows; ` +
        `the per-write bound is ${MAX_DRIFT_ROWS_PER_WRITE}`,
      evidence: JSON.stringify({
        op: "insert parse drift", table: TABLES.parseDrift,
        rows: observations.length, limit: MAX_DRIFT_ROWS_PER_WRITE,
      }),
    });
  }

  const client = opts.client ?? getStore();
  const rows = observations.map((observation) => ({
    capability: opts.capability,
    field: observation.field,
    shape_hash: opts.shapeHash,
    n: observation.n,
  }));
  const result = await client.from(TABLES.parseDrift).insert(rows);
  if (result.error) {
    throw storeError({
      op: "insert parse drift",
      table: TABLES.parseDrift,
      kind: "write",
      status: result.status,
      cause: result.error,
    });
  }
  return rows.length;
}
