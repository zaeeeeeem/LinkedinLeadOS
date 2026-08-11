import { join } from "node:path";
import { defaultRunsDir } from "../run/paths.js";

/**
 * Where the lease lives by default. Repo-local `runs/`, alongside the budget
 * ledger (D11) and for the same reason: the lease is a safety mechanism, so it
 * must work when Supabase is down, when Docker is not running, and before any
 * storage exists. A local file is the only thing that still works then.
 */
export function defaultLeasePath(): string {
  return join(defaultRunsDir(), "tab.lock");
}

/**
 * How long a refused caller is told to wait. A held lease clears when the holder
 * finishes a capability, which is seconds-to-minutes, so a sub-second retry is
 * pure noise.
 */
export const LEASE_RETRY_AFTER_MS = 5_000;

/**
 * How long a leftover temp or quarantine file must have gone untouched before an
 * acquire sweeps it away. A crash between writing a temp file and renaming it
 * leaves one behind forever otherwise. Comfortably longer than any single
 * rename sequence, so a concurrent acquire's in-flight file is never swept.
 */
export const LEASE_SCRATCH_TTL_MS = 60_000;

/** Prefix every temp / quarantine file shares, so the sweep can recognise them. */
export const LEASE_SCRATCH_PREFIX = ".tab.lock.";
