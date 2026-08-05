import { appendFile, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  DAY_MS,
  DEFAULT_BUDGET_LIMITS,
  HOUR_MS,
  LEDGER_LOCK_POLL_MS,
  LEDGER_LOCK_STALE_MS,
  LEDGER_LOCK_TIMEOUT_MS,
  SPEND_KINDS,
  type BudgetLimits,
  type SpendKind,
  defaultBudgetPath,
} from "./constants.js";

/** One NDJSON line. `n` lets a single spend cover more than one unit (rare;
 *  defaults to 1). `ref` is required for `profile_open` — it is what makes the
 *  same profile opened twice in a day count once (§8). */
export type SpendRecord = {
  ts: string;
  run_id: string;
  capability: string;
  kind: SpendKind;
  n: number;
  ref?: string;
};

export type UsageSnapshot = {
  pageLoadsLastHour: number;
  pageLoadsToday: number;
  searchPagesToday: number;
  distinctProfilesToday: number;
};

export type LedgerInput = {
  path?: string;
  now?: Date;
  limits?: Partial<BudgetLimits>;
};

export type CheckInput = LedgerInput & {
  kind: SpendKind;
  n?: number;
  ref?: string;
};

export type SpendInput = CheckInput & {
  runId: string;
  capability: string;
};

// EEXIST is included for mkdir: recursively creating a directory whose path
// collides with an existing plain file raises EEXIST on some platforms and
// ENOTDIR on others for the same underlying condition — "this can never be a
// directory" — not the lock contention EEXIST means inside `withLedgerLock`.
const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOSPC", "EEXIST"]);

function unwritable(path: string, cause: NodeJS.ErrnoException): CapabilityError {
  return new CapabilityError({
    code: "BUDGET_LEDGER_UNWRITABLE",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `budget ledger path is not writable: ${path} (${cause.code})`,
    evidence: cause.message,
  });
}

function rethrowUnwritable(path: string, e: unknown): never {
  const err = e as NodeJS.ErrnoException;
  if (err.code && UNWRITABLE.has(err.code)) throw unwritable(path, err);
  throw e;
}

/**
 * A ledger line that cannot be trusted. The fail-closed rule (task 11): a
 * corrupt line is never skipped toward a lower count, because skipping it is
 * exactly the bug that lets a spend through past a limit. Every read of the
 * ledger throws the instant one is found, before any count is computed from
 * the lines around it.
 */
function corrupt(path: string, lineNo: number, raw: string, reason: string): CapabilityError {
  return new CapabilityError({
    code: "BUDGET_LEDGER_CORRUPT",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `budget ledger ${path} line ${lineNo} is corrupt (${reason}) — refusing to spend ` +
      `rather than count around it`,
    evidence: raw.slice(0, 500),
  });
}

function exceeded(kind: SpendKind, window: string, limit: number, current: number, n: number): CapabilityError {
  return new CapabilityError({
    code: "BUDGET_EXCEEDED",
    exit: EXIT.BUDGET,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `budget exceeded: ${kind} per ${window} limit is ${limit}, already at ${current}, this would add ${n}`,
    evidence: JSON.stringify({ kind, window, limit, current, requested: n }),
  });
}

function profileRefRequired(): CapabilityError {
  return new CapabilityError({
    code: "BUDGET_PROFILE_REF_REQUIRED",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "profile_open spend requires a ref, so the same profile opened twice counts once",
  });
}

function busy(path: string): CapabilityError {
  return new CapabilityError({
    code: "BUDGET_LEDGER_BUSY",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: `budget ledger ${path} is locked by another spend and did not free up in time`,
    retryAfterMs: LEDGER_LOCK_POLL_MS * 4,
  });
}

function parseLine(path: string, lineNo: number, raw: string): SpendRecord {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw corrupt(path, lineNo, raw, "not valid JSON");
  }
  if (typeof obj !== "object" || obj === null) throw corrupt(path, lineNo, raw, "not an object");
  const r = obj as Record<string, unknown>;
  if (typeof r.ts !== "string" || Number.isNaN(Date.parse(r.ts))) throw corrupt(path, lineNo, raw, "bad ts");
  if (typeof r.run_id !== "string" || r.run_id === "") throw corrupt(path, lineNo, raw, "bad run_id");
  if (typeof r.capability !== "string" || r.capability === "") throw corrupt(path, lineNo, raw, "bad capability");
  if (typeof r.kind !== "string" || !(SPEND_KINDS as readonly string[]).includes(r.kind)) {
    throw corrupt(path, lineNo, raw, "bad kind");
  }
  if (typeof r.n !== "number" || !Number.isFinite(r.n) || r.n <= 0) throw corrupt(path, lineNo, raw, "bad n");
  if (r.ref !== undefined && (typeof r.ref !== "string" || r.ref === "")) {
    throw corrupt(path, lineNo, raw, "bad ref");
  }
  return {
    ts: r.ts,
    run_id: r.run_id,
    capability: r.capability,
    kind: r.kind as SpendKind,
    n: r.n,
    ...(typeof r.ref === "string" ? { ref: r.ref } : {}),
  };
}

async function readAll(path: string): Promise<SpendRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    rethrowUnwritable(path, e);
  }
  const lines = text.split("\n");
  const out: SpendRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // Only a genuinely empty line is skipped — the trailing one every
    // NDJSON file ends with. Anything else that fails to parse is corrupt.
    if (line === "") continue;
    out.push(parseLine(path, i + 1, line));
  }
  return out;
}

function withinWindow(ts: string, nowMs: number, windowMs: number): boolean {
  return nowMs - Date.parse(ts) < windowMs;
}

function sumKind(entries: SpendRecord[], kind: SpendKind, nowMs: number, windowMs: number): number {
  let total = 0;
  for (const e of entries) {
    if (e.kind === kind && withinWindow(e.ts, nowMs, windowMs)) total += e.n;
  }
  return total;
}

function distinctRefs(entries: SpendRecord[], kind: SpendKind, nowMs: number, windowMs: number): Set<string> {
  const refs = new Set<string>();
  for (const e of entries) {
    if (e.kind === kind && e.ref !== undefined && withinWindow(e.ts, nowMs, windowMs)) refs.add(e.ref);
  }
  return refs;
}

/**
 * A per-invocation limit may only ever lower a default, never raise or
 * bypass it (§8) — an override above the default, zero, negative, or
 * non-finite is ignored rather than trusted, so a caller's arithmetic bug
 * cannot widen the one thing that must not widen.
 */
function resolveLimits(overrides?: Partial<BudgetLimits>): BudgetLimits {
  const out = { ...DEFAULT_BUDGET_LIMITS };
  if (!overrides) return out;
  for (const key of Object.keys(DEFAULT_BUDGET_LIMITS) as (keyof BudgetLimits)[]) {
    const v = overrides[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < out[key]) out[key] = v;
  }
  return out;
}

/** Throws if `n` more of `kind` would cross a limit; otherwise returns quietly. */
function evaluate(
  entries: SpendRecord[],
  kind: SpendKind,
  n: number,
  ref: string | undefined,
  nowMs: number,
  limits: BudgetLimits,
): void {
  if (kind === "page_load") {
    const hour = sumKind(entries, kind, nowMs, HOUR_MS);
    if (hour + n > limits.pageLoadsPerHour) throw exceeded(kind, "hour", limits.pageLoadsPerHour, hour, n);
    const day = sumKind(entries, kind, nowMs, DAY_MS);
    if (day + n > limits.pageLoadsPerDay) throw exceeded(kind, "day", limits.pageLoadsPerDay, day, n);
    return;
  }
  if (kind === "search_page") {
    const day = sumKind(entries, kind, nowMs, DAY_MS);
    if (day + n > limits.searchPagesPerDay) throw exceeded(kind, "day", limits.searchPagesPerDay, day, n);
    return;
  }
  // profile_open: reopening an already-counted ref is always free, so it
  // never trips the distinct-count limit no matter how full the day already is.
  if (!ref) throw profileRefRequired();
  const distinct = distinctRefs(entries, kind, nowMs, DAY_MS);
  if (distinct.has(ref)) return;
  if (distinct.size + 1 > limits.distinctProfilesPerDay) {
    throw exceeded(kind, "day", limits.distinctProfilesPerDay, distinct.size, 1);
  }
}

const lockPath = (path: string) => `${path}.lock`;

/**
 * Serializes read-evaluate-append across processes so two racing spends that
 * would together cross a limit cannot both observe "under limit" and both
 * commit. A stale lock (its holder crashed mid-cycle) is stolen after
 * `LEDGER_LOCK_STALE_MS`; a live one is waited out up to `LEDGER_LOCK_TIMEOUT_MS`
 * before refusing with a retryable `BUDGET_LEDGER_BUSY` — refusing to spend
 * beats guessing the lock will never come.
 */
async function withLedgerLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPath(path);
  const token = `${process.pid}.${randomUUID()}`;
  const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS;

  for (;;) {
    let fh;
    try {
      fh = await open(lock, "wx");
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") rethrowUnwritable(path, e);
      const age = await stat(lock)
        .then((s) => Date.now() - s.mtimeMs)
        .catch(() => Infinity);
      if (age > LEDGER_LOCK_STALE_MS) {
        await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) throw busy(path);
      await new Promise((r) => setTimeout(r, LEDGER_LOCK_POLL_MS));
      continue;
    }
    try {
      await fh.writeFile(token, "utf8");
    } finally {
      await fh.close();
    }
    break;
  }

  try {
    return await fn();
  } finally {
    // Only drop the lock if it is still the one this call took — a lock
    // stolen for being stale must not be released out from under its new
    // holder by the call that lost it.
    const held = await readFile(lock, "utf8").catch(() => undefined);
    if (held === token) await unlink(lock).catch(() => {});
  }
}

/**
 * Preflight peek: would `n` more of `kind` cross a limit right now? Read-only
 * — makes no ledger entry. Capabilities call this before doing any work;
 * `spend` is the one that actually happened.
 */
export async function check(o: CheckInput): Promise<void> {
  const path = o.path ?? defaultBudgetPath();
  const n = o.n ?? 1;
  const nowMs = (o.now ?? new Date()).getTime();
  const limits = resolveLimits(o.limits);
  if (o.kind === "profile_open" && !o.ref) throw profileRefRequired();
  const entries = await readAll(path);
  evaluate(entries, o.kind, n, o.ref, nowMs, limits);
}

/**
 * Records a real spend, but only after re-confirming it would not cross a
 * limit — the same evaluation `check` runs, so a caller that skipped the
 * preflight check (or whose situation changed between the two calls) still
 * cannot spend past a limit. The evaluate-then-append pair runs under
 * `withLedgerLock` so two concurrent spends cannot both pass evaluation
 * and both commit.
 */
export async function spend(o: SpendInput): Promise<SpendRecord> {
  const path = o.path ?? defaultBudgetPath();
  const n = o.n ?? 1;
  const nowDate = o.now ?? new Date();
  const nowMs = nowDate.getTime();
  const limits = resolveLimits(o.limits);
  if (o.kind === "profile_open" && !o.ref) throw profileRefRequired();

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    rethrowUnwritable(path, e);
  }

  return withLedgerLock(path, async () => {
    const entries = await readAll(path);
    evaluate(entries, o.kind, n, o.ref, nowMs, limits);

    const record: SpendRecord = {
      ts: nowDate.toISOString(),
      run_id: o.runId,
      capability: o.capability,
      kind: o.kind,
      n,
      ...(o.ref !== undefined ? { ref: o.ref } : {}),
    };
    try {
      await appendFile(path, JSON.stringify(record) + "\n", "utf8");
    } catch (e) {
      rethrowUnwritable(path, e);
    }
    return record;
  });
}

/** Current windowed counts, for receipts and operator inspection. Read-only. */
export async function usage(o: LedgerInput = {}): Promise<UsageSnapshot> {
  const path = o.path ?? defaultBudgetPath();
  const nowMs = (o.now ?? new Date()).getTime();
  const entries = await readAll(path);
  return {
    pageLoadsLastHour: sumKind(entries, "page_load", nowMs, HOUR_MS),
    pageLoadsToday: sumKind(entries, "page_load", nowMs, DAY_MS),
    searchPagesToday: sumKind(entries, "search_page", nowMs, DAY_MS),
    distinctProfilesToday: distinctRefs(entries, "profile_open", nowMs, DAY_MS).size,
  };
}

/**
 * A ledger bound to one path and one set of (already-lowered-only) limits, so
 * a capability opens it once during preflight and calls `check`/`spend`/
 * `usage` without repeating either. Thin sugar over the free functions above,
 * which stay exported directly for callers (and tests) that want a one-off
 * call against an explicit path.
 */
export class BudgetLedger {
  private constructor(
    readonly path: string,
    private readonly limits: Partial<BudgetLimits> | undefined,
  ) {}

  /** Ensures the ledger's directory exists and binds a path + limit overrides. */
  static open(o: { path?: string; limits?: Partial<BudgetLimits> } = {}): BudgetLedger {
    const path = o.path ?? defaultBudgetPath();
    mkdirSync(dirname(path), { recursive: true });
    return new BudgetLedger(path, o.limits);
  }

  check(o: { kind: SpendKind; n?: number; ref?: string; now?: Date }): Promise<void> {
    return check({ ...o, path: this.path, limits: this.limits });
  }

  spend(o: { runId: string; capability: string; kind: SpendKind; n?: number; ref?: string; now?: Date }): Promise<SpendRecord> {
    return spend({ ...o, path: this.path, limits: this.limits });
  }

  usage(now?: Date): Promise<UsageSnapshot> {
    return usage({ path: this.path, now });
  }
}
