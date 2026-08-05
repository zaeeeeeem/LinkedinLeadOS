import { join } from "node:path";
import { defaultRunsDir } from "../run/paths.js";

/**
 * Where the ledger lives by default (D11): repo-local, append-only, so the one
 * check standing between us and a burned account works when Supabase is down,
 * when Docker is off, and before any storage exists at all.
 */
export function defaultBudgetPath(): string {
  return join(defaultRunsDir(), "budget.ndjson");
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long compaction (D72) keeps a ledger line before dropping it. Wider
 * than `DAY_MS`, the widest window any limit actually enforces, because the
 * Supabase mirror D72 assumed as the real long-term copy (D11: "the table
 * may later mirror the file for reporting") has no writer yet — that is
 * Task 14. Until it lands, this is the only copy of spend history, so
 * compaction is deliberately conservative rather than matching the
 * enforcement window exactly. Revisit down to `DAY_MS` once Task 14 ships.
 */
export const COMPACTION_RETENTION_MS = 7 * DAY_MS;

/** The closed set of spend kinds §8 tracks. */
export const SPEND_KINDS = ["page_load", "search_page", "profile_open"] as const;
export type SpendKind = (typeof SPEND_KINDS)[number];

export type BudgetLimits = {
  pageLoadsPerHour: number;
  pageLoadsPerDay: number;
  searchPagesPerDay: number;
  distinctProfilesPerDay: number;
};

/** Spec §8 defaults. */
export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  pageLoadsPerHour: 60,
  pageLoadsPerDay: 400,
  searchPagesPerDay: 50,
  distinctProfilesPerDay: 120,
};

/** How long a stale ledger lockfile is trusted to be a live holder's. Comfortably
 *  longer than a read-evaluate-append cycle ever takes, short enough that a
 *  crash while holding it does not wedge every future spend. */
export const LEDGER_LOCK_STALE_MS = 5_000;

/** How long a caller waits for the ledger lock before giving up. */
export const LEDGER_LOCK_TIMEOUT_MS = 3_000;

export const LEDGER_LOCK_POLL_MS = 20;
