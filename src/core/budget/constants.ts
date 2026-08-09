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

/**
 * A single capability's own daily ceiling, evaluated *in addition to* the
 * global `BudgetLimits` above (D153). The global limits protect the account;
 * these protect every other capability from one runaway reader — a pagination
 * loop that does not terminate, or a `--limit` that bounds output but not
 * work, trips its own cap at exit 7 long before it can drain the shared 400.
 *
 * Daily only, deliberately: the hourly window already exists globally and is
 * the pacing guard; the sub-cap is a blast-radius guard, and a blast radius is
 * a per-day quantity.
 */
export type CapabilitySubCaps = {
  pageLoadsPerDay: number;
  searchPagesPerDay: number;
  distinctProfilesPerDay: number;
};

/**
 * The cap a capability with no entry in `CAPABILITY_SUB_CAPS` gets. Every
 * capability is capped: a new reader added without touching this file must
 * land capped rather than uncapped, because "uncapped by omission" is exactly
 * the failure D153 exists to prevent. Each number is a fraction of the §8
 * global for the same kind (150/400, 25/50, 60/120), so one bad reader can
 * spend at most roughly a third of the day before its own cap stops it.
 */
export const DEFAULT_CAPABILITY_SUB_CAPS: CapabilitySubCaps = {
  pageLoadsPerDay: 150,
  searchPagesPerDay: 25,
  distinctProfilesPerDay: 60,
};

/**
 * Per-capability tuning. Only capabilities whose caps should differ from
 * `DEFAULT_CAPABILITY_SUB_CAPS` appear here; absence is not an exemption.
 *
 * A table entry is not an "override" in the §8 sense — it is the capability's
 * default, and it may sit above the fallback. The lower-only rule (§8) governs
 * per-invocation overrides passed to `check`/`spend`, which can never raise the
 * number resolved here.
 */
export const CAPABILITY_SUB_CAPS: Readonly<Record<string, CapabilitySubCaps>> = {
  // The primary L1 reader: allowed more page loads than the fallback because
  // it is the capability the day's work actually runs through, and zero search
  // pages because it never issues a search — a search spend recorded under this
  // name would mean the capability is doing something it was not built to do.
  "profile.capture": { pageLoadsPerDay: 200, searchPagesPerDay: 0, distinctProfilesPerDay: 90 },
  // profile.get delegates to profile.capture's `run`, but the RunBudget it
  // passes down is bound to *its own* name, so its loads land on ledger lines
  // reading `capability: "profile.get"`. It therefore needs its own entry:
  // inheriting profile.capture's would silently leave it on the fallback.
  "profile.get": { pageLoadsPerDay: 200, searchPagesPerDay: 0, distinctProfilesPerDay: 90 },
  "company.get": { pageLoadsPerDay: 150, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  "company.posts": { pageLoadsPerDay: 150, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  "company.people": { pageLoadsPerDay: 150, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  "company.jobs": { pageLoadsPerDay: 150, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  // A probe is a measuring instrument, not a reader. Its whole job is a handful
  // of loads on one target, and its stated per-run ceiling is 6 (CONTEXT rule
  // 8) — so 12 is two full probe runs in a day and nothing more. Zeroes for the
  // other two kinds are assertions, not allowances: a probe that ever recorded
  // a search page or a profile open would be doing something it was not built
  // to do, and a cap of zero is what turns that into exit 7 instead of a habit.
  "company.probe": { pageLoadsPerDay: 12, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  // post.get reads one permalink per run and opens nobody's profile — a
  // permalink is a post, not a person (D222). The zeroes are assertions in the
  // same sense as company.probe's: a profile open or a search page recorded
  // under this name would mean the reader is doing something it was not built
  // to do, and zero turns that into exit 7 rather than a quiet habit.
  "post.get": { pageLoadsPerDay: 60, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
  // The Task 26 probe. Capped well below the fallback because it is a
  // measurement capability, not a working reader: its whole job is a handful of
  // supervised page loads per surface, and a number in the hundreds would let a
  // mis-typed loop spend the day's budget on pages nobody is reading. Zero
  // search pages for the same reason profile.capture has zero — it never
  // issues a search, so a search spend under this name means it is doing
  // something it was not built to do (D221).
  "activity.capture": { pageLoadsPerDay: 30, searchPagesPerDay: 0, distinctProfilesPerDay: 20 },
  // The job probe, same reasoning: listed rather than left to the reader
  // fallback, and zero profile opens because it never opens a person.
  "job.capture": { pageLoadsPerDay: 12, searchPagesPerDay: 0, distinctProfilesPerDay: 0 },
};

/** The daily sub-caps in force for one capability. Never returns uncapped. */
export function subCapsFor(capability: string): CapabilitySubCaps {
  return CAPABILITY_SUB_CAPS[capability] ?? DEFAULT_CAPABILITY_SUB_CAPS;
}
