import { join } from "node:path";

/**
 * Where the lease lives by default. Repo-local `runs/`, alongside the budget
 * ledger (D11) and for the same reason: the lease is a safety mechanism, so it
 * must work when Supabase is down, when Docker is not running, and before any
 * storage exists. A local file is the only thing that still works then.
 */
export function defaultLeasePath(): string {
  return join(process.cwd(), "runs", "tab.lock");
}

/**
 * How long a refused caller is told to wait. A held lease clears when the holder
 * finishes a capability, which is seconds-to-minutes, so a sub-second retry is
 * pure noise.
 */
export const LEASE_RETRY_AFTER_MS = 5_000;

/**
 * Reclaim settle window. Reclaiming replaces the lock with `rename`, which is
 * last-writer-wins: several processes may all replace it before any of them
 * looks. Waiting this long before the read-back check lets every racer's write
 * land first, so the read-back sees the final winner and the losers refuse
 * instead of all believing they hold it. Randomized so racers do not re-collide
 * in lockstep.
 */
export const LEASE_SETTLE_MS = 40;
