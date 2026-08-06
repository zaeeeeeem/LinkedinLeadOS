import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilityError, EXIT } from "../run/receipt.js";
import type { Counts, Cost, Receipt } from "../run/receipt.js";
import { readEvents } from "../run/events.js";
import type { EventLevel, LoggedEvent } from "../run/events.js";
import type { RunMeta } from "../run/context.js";

/**
 * Read-only queries over the run archive Task 6 writes
 * (`runs/<id>/{run.json,summary.json,events.ndjson}`), for the four log-query
 * capabilities (spec §5, D5): bounded slices instead of a raw file dump.
 *
 * Deliberately independent of `RunContext`. `RunContext.open({ runId })`
 * mutates the run it opens — it appends a `resumed_at` timestamp to
 * `run.json` and logs a `checkpoint.resume` event — which is exactly wrong
 * for a query that must leave the run it is inspecting untouched. Every
 * function here only ever reads.
 */

/** Bounds every query's result (D3's fixed-size intent) — a receipt's `data`
 *  stays inlineable regardless of how long a run archive has grown. */
const RUN_LIST_LIMIT = 200;
const EVENTS_LIMIT = 500;
const DRIFT_GROUP_LIMIT = 200;

/**
 * The bound that actually matters, and the one a count cannot express. 500 events
 * of ordinary width serialize to 170KB — ~42k tokens on stdout, a hundred times
 * the "hundreds of tokens, not hundreds of thousands" this capability exists for,
 * and against `CLAUDE.md`'s "never print large results". Measured, not guessed:
 * a real capture's events run ~340 bytes each. Whichever bound bites first wins.
 */
export const MAX_RESULT_BYTES = 32_768;

/** Capabilities whose runs are queries *about* the archive rather than work
 *  recorded in it. Excluded from `log:runs` by default: each debugging session
 *  writes more of them, they sort newest-first, and left in they push the real
 *  runs past the cap — a query that answers with its own history (D142). */
const QUERY_CAPABILITY = /^log\./;

const UNKNOWN = "(unknown)";

function runPaths(runsDir: string, runId: string) {
  const dir = join(runsDir, runId);
  return { dir, meta: join(dir, "run.json"), summary: join(dir, "summary.json"), events: join(dir, "events.ndjson") };
}

function runNotFound(runId: string): CapabilityError {
  return new CapabilityError({
    code: "RUN_NOT_FOUND",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `no run found with id ${runId}`,
  });
}

/** `value: null, corrupt: false` when absent; `corrupt: true` when present
 *  but unparseable. Never throws — a damaged archive file for one run must
 *  not take down a query spanning many runs (log:runs, log:drift). */
function readJsonSafe<T>(path: string): { value: T | null; corrupt: boolean } {
  if (!existsSync(path)) return { value: null, corrupt: false };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) as T, corrupt: false };
  } catch {
    return { value: null, corrupt: true };
  }
}

/** Every run id under `runsDir` that actually has a `run.json` — filters out
 *  `budget.ndjson`, `tab.lock`, and anything else that is not a run directory. */
function listRunIds(runsDir: string): string[] {
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return []; // no runs/ directory yet — a fresh clone, not an error
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(runsDir, name, "run.json")));
}

/** Keeps the most recent `limit` items of an already-chronological array —
 *  truncation drops the oldest, keeping what is closest to "now" or to
 *  whatever just happened, which is the end most debugging starts from. */
function capTail<T>(
  items: T[],
  limit: number,
  maxBytes: number = MAX_RESULT_BYTES,
): { items: T[]; truncated: boolean; dropped: number } {
  const total = items.length;
  let kept = items.length <= limit ? items : items.slice(items.length - limit);

  // Then by size, dropping from the same end the count bound drops from, so the
  // two bounds never disagree about which events survive.
  // Never below one: a single event wider than the budget is still the answer to
  // "why did this fail", and returning nothing would be the silent-empty result
  // this capability exists to prevent.
  while (kept.length > 1 && JSON.stringify(kept).length > maxBytes) {
    // Proportional, so a 170KB result is not walked one event at a time.
    const over = JSON.stringify(kept).length / maxBytes;
    const drop = Math.min(kept.length - 1, Math.max(1, Math.floor(kept.length * (1 - 1 / over))));
    kept = kept.slice(drop);
  }

  return { items: kept, truncated: kept.length < total, dropped: total - kept.length };
}

/** The same two bounds for an array already ordered most-relevant-first, where
 *  truncation drops from the tail: run summaries, drift groups. */
function capHead<T>(
  items: T[],
  limit: number,
  maxBytes: number = MAX_RESULT_BYTES,
): { items: T[]; truncated: boolean; dropped: number } {
  const total = items.length;
  let kept = items.slice(0, limit);
  while (kept.length > 1 && JSON.stringify(kept).length > maxBytes) {
    const over = JSON.stringify(kept).length / maxBytes;
    kept = kept.slice(0, Math.min(kept.length - 1, Math.max(1, Math.floor(kept.length / over))));
  }
  return { items: kept, truncated: kept.length < total, dropped: total - kept.length };
}

// ---------------------------------------------------------------------------
// log:runs — run summaries within a time window
// ---------------------------------------------------------------------------

export type RunStatus = "ok" | "error" | "incomplete" | "corrupt";

export type RunSummary = {
  run_id: string;
  capability: string | null;
  created_at: string | null;
  /** max(created_at, every resumed_at) — what "recently active" filters on. */
  last_activity: string | null;
  status: RunStatus;
  exit?: number;
  error_code?: string;
  counts?: Counts;
  cost?: Cost;
};

function lastActivityMs(meta: RunMeta): number {
  const stamps = [meta.created_at, ...meta.resumed_at]
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  return stamps.length ? Math.max(...stamps) : NaN;
}

function summaryToRunSummary(
  runId: string,
  meta: RunMeta,
  activityMs: number,
  receipt: Receipt | null,
  summaryCorrupt: boolean,
): RunSummary {
  const base = {
    run_id: runId,
    capability: meta.capability ?? null,
    created_at: meta.created_at ?? null,
    last_activity: Number.isFinite(activityMs) ? new Date(activityMs).toISOString() : null,
  };
  if (summaryCorrupt) return { ...base, status: "corrupt" };
  // No summary.json: the run started and never finished — still running, or
  // it crashed mid-invocation. Distinguishing those two is what log:why and
  // log:errors are for; this query only reports that it is unresolved.
  if (!receipt) return { ...base, status: "incomplete" };
  if (receipt.ok) return { ...base, status: "ok", exit: 0, counts: receipt.counts, cost: receipt.cost };
  return { ...base, status: "error", exit: receipt.error.exit, error_code: receipt.error.code, cost: receipt.cost };
}

export type ListRunsResult = { runs: RunSummary[]; truncated: boolean; dropped: number };

/**
 * One line per run, most-recently-active first, optionally filtered to runs
 * active within `sinceMs`. A run whose `run.json` is corrupt is always
 * surfaced — with `status: "corrupt"` and no timestamp — rather than dropped
 * by a time filter it has no readable timestamp to be judged against; a
 * damaged run record is exactly the kind of thing an operator wants visible,
 * not silently absent from the list.
 */
export function listRuns(
  runsDir: string,
  o: { sinceMs?: number; now?: number; includeQueries?: boolean } = {},
): ListRunsResult {
  const now = o.now ?? Date.now();
  const out: RunSummary[] = [];

  for (const runId of listRunIds(runsDir)) {
    const paths = runPaths(runsDir, runId);
    const { value: meta, corrupt: metaCorrupt } = readJsonSafe<RunMeta>(paths.meta);
    if (metaCorrupt) {
      out.push({ run_id: runId, capability: null, created_at: null, last_activity: null, status: "corrupt" });
      continue;
    }
    if (!meta) continue; // listRunIds already confirmed run.json exists; a TOCTOU race, not a real case

    // A run of this very query, and of every earlier one. Excluded by default so
    // debugging does not crowd out the runs being debugged.
    if (!o.includeQueries && meta.capability !== undefined && QUERY_CAPABILITY.test(meta.capability)) continue;

    const activityMs = lastActivityMs(meta);
    if (o.sinceMs !== undefined && Number.isFinite(activityMs) && now - activityMs > o.sinceMs) continue;

    const { value: receipt, corrupt: summaryCorrupt } = readJsonSafe<Receipt>(paths.summary);
    out.push(summaryToRunSummary(runId, meta, activityMs, receipt, summaryCorrupt));
  }

  out.sort((a, b) => (Date.parse(b.last_activity ?? "") || 0) - (Date.parse(a.last_activity ?? "") || 0));
  const { items, truncated, dropped } = capHead(out, RUN_LIST_LIMIT);
  return { runs: items, truncated, dropped };
}

// ---------------------------------------------------------------------------
// log:why — every event for one item in one run
// ---------------------------------------------------------------------------

export type ItemEvents = {
  run_id: string; item_ref: string; events: LoggedEvent[]; truncated: boolean; dropped: number;
};

/**
 * Every event carrying `item_ref === itemRef`, in the order they were
 * written. Reuses `readEvents`, so a truncated trailing line from a killed
 * process is skipped rather than failing the whole read (spec constraint) —
 * the complete events before it are still returned, for an item that failed
 * outright and for an item that is one of several in a run that partly
 * succeeded alike.
 */
export function queryWhy(runsDir: string, runId: string, itemRef: string): ItemEvents {
  const paths = runPaths(runsDir, runId);
  if (!existsSync(paths.meta)) throw runNotFound(runId);

  const matched = readEvents(paths.events).filter((e) => e.item_ref === itemRef);
  const { items, truncated, dropped } = capTail(matched, EVENTS_LIMIT);
  return { run_id: runId, item_ref: itemRef, events: items, truncated, dropped };
}

// ---------------------------------------------------------------------------
// log:errors — failures and warnings for one run
// ---------------------------------------------------------------------------

export type ErrorEvents = { run_id: string; events: LoggedEvent[]; truncated: boolean; dropped: number };

const FAILURE_LEVELS: ReadonlySet<EventLevel> = new Set(["warn", "error"]);

/**
 * Every `warn`/`error`-level event in a run, in the order they were written.
 * `info`/`debug` events (the successful majority of a long run) are exactly
 * what this query exists to filter out.
 */
export function queryErrors(runsDir: string, runId: string): ErrorEvents {
  const paths = runPaths(runsDir, runId);
  if (!existsSync(paths.meta)) throw runNotFound(runId);

  const matched = readEvents(paths.events).filter((e) => FAILURE_LEVELS.has(e.level));
  const { items, truncated, dropped } = capTail(matched, EVENTS_LIMIT);
  return { run_id: runId, events: items, truncated, dropped };
}

// ---------------------------------------------------------------------------
// log:drift — parse.miss grouped by capability and field
// ---------------------------------------------------------------------------

export type DriftGroup = { capability: string; field: string; count: number };
export type QueryDriftResult = { groups: DriftGroup[]; truncated: boolean; dropped: number };

/**
 * `parse.miss` events across every run, grouped by the run's capability
 * (from `run.json`) and the field named on the event's `detail.field`
 * (the contract Task 16/17 record against, per the task file), counted and
 * sorted by count descending. A run whose `run.json` cannot be attributed —
 * missing or corrupt — still contributes its drift under an `(unknown)`
 * capability bucket rather than being dropped outright, and an event logged
 * without a `detail.field` groups under an `(unknown)` field for the same
 * reason: a silent-loss path here would undercount exactly the drift this
 * query exists to surface.
 */
export function queryDrift(runsDir: string, o: { sinceMs?: number; now?: number } = {}): QueryDriftResult {
  const now = o.now ?? Date.now();
  const counts = new Map<string, DriftGroup>();

  for (const runId of listRunIds(runsDir)) {
    const paths = runPaths(runsDir, runId);
    const { value: meta } = readJsonSafe<RunMeta>(paths.meta);
    const capability = meta?.capability ?? UNKNOWN;

    for (const e of readEvents(paths.events)) {
      if (e.event !== "parse.miss") continue;
      if (o.sinceMs !== undefined) {
        const at = Date.parse(e.ts);
        if (!Number.isFinite(at) || now - at > o.sinceMs) continue;
      }
      const field =
        typeof e.detail?.field === "string" && e.detail.field !== "" ? (e.detail.field as string) : UNKNOWN;
      // JSON-encoded pair, not a delimited string: a capability name is a
      // closed dot-separated set (D81's naming rule) so this never collides
      // in practice, but a field name comes from LinkedIn's own response
      // shape and is not similarly constrained.
      const key = JSON.stringify([capability, field]);
      const existing = counts.get(key);
      if (existing) existing.count += 1;
      else counts.set(key, { capability, field, count: 1 });
    }
  }

  const groups = [...counts.values()].sort(
    (a, b) => b.count - a.count || a.capability.localeCompare(b.capability) || a.field.localeCompare(b.field),
  );
  const capped = capHead(groups, DRIFT_GROUP_LIMIT);
  return { groups: capped.items, truncated: capped.truncated, dropped: capped.dropped };
}
