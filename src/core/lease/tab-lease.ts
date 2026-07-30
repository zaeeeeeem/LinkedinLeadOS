import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { defaultLeasePath, LEASE_RETRY_AFTER_MS, LEASE_SETTLE_MS } from "./constants.js";

/** What the lockfile holds. Enough to answer "who has the tab, and are they alive?". */
export type LeaseRecord = {
  run_id: string;
  pid: number;
  host: string;
  capability: string;
  /** ISO. Survives re-entry — a resumed run keeps its original acquisition time. */
  acquired_at: string;
  /** ISO. Set when an existing holder retakes its own lease. */
  renewed_at?: string;
};

export type LeaseState =
  | { state: "free" }
  /** A holder on this host whose pid is alive. Never preempted. */
  | { state: "held"; holder: LeaseRecord }
  /** A holder on this host whose pid is gone. Reclaimable. */
  | { state: "stale"; holder: LeaseRecord }
  /** Unreadable or structurally wrong. Reclaimable — it protects nobody. */
  | { state: "corrupt"; reason: string }
  /**
   * Written on a different machine. `process.kill(pid, 0)` would be asking this
   * host about a foreign pid, which answers a different question entirely, so the
   * lease is treated as live and never reclaimed.
   */
  | { state: "foreign"; holder: LeaseRecord };

function held(message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code: "TAB_LEASE_HELD",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message,
    evidence,
    retryAfterMs: LEASE_RETRY_AFTER_MS,
  });
}

/**
 * The lease path cannot be written at all — a read-only directory, a bad mount, a
 * permissions mistake. Retrying that forever is the D13 failure mode, so it halts.
 */
function unwritable(path: string, cause: NodeJS.ErrnoException): CapabilityError {
  return new CapabilityError({
    code: "TAB_LEASE_UNWRITABLE",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `tab lease path is not writable: ${path} (${cause.code})`,
    evidence: cause.message,
  });
}

const UNWRITABLE = new Set(["EACCES", "EPERM", "EROFS", "ENOTDIR", "ENOSPC"]);

function isMissing(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** Alive if signalling it is permitted or refused; only ESRCH means the pid is gone. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(text: string): LeaseRecord | { bad: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { bad: "lease file is not JSON" };
  }
  if (typeof raw !== "object" || raw === null) return { bad: "lease file is not an object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.run_id !== "string" || r.run_id === "") return { bad: "lease file has no run_id" };
  if (typeof r.pid !== "number") return { bad: "lease file has no pid" };
  if (typeof r.host !== "string") return { bad: "lease file has no host" };
  if (typeof r.capability !== "string") return { bad: "lease file has no capability" };
  if (typeof r.acquired_at !== "string") return { bad: "lease file has no acquired_at" };
  return {
    run_id: r.run_id,
    pid: r.pid,
    host: r.host,
    capability: r.capability,
    acquired_at: r.acquired_at,
    ...(typeof r.renewed_at === "string" ? { renewed_at: r.renewed_at } : {}),
  };
}

/** Reads the lease without changing anything. Safe to call from a health check. */
export async function inspectLease(path: string = defaultLeasePath()): Promise<LeaseState> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return { state: "free" };
    throw e;
  }
  const parsed = parseRecord(text);
  if ("bad" in parsed) return { state: "corrupt", reason: parsed.bad };
  if (parsed.host !== hostname()) return { state: "foreign", holder: parsed };
  return pidAlive(parsed.pid) ? { state: "held", holder: parsed } : { state: "stale", holder: parsed };
}

const serialize = (r: LeaseRecord) => JSON.stringify(r) + "\n";

const settle = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * Replaces whatever is at `path` atomically. `rename` rather than unlink-then-create
 * so the lock is never briefly absent — an absent lock would let an unrelated fresh
 * acquirer slip in through the exclusive-create path and hold it alongside us.
 */
async function replaceWith(path: string, rec: LeaseRecord): Promise<void> {
  const tmp = join(dirname(path), `.tab.lock.${process.pid}.${randomUUID()}`);
  await writeFile(tmp, serialize(rec), "utf8");
  try {
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** True when the file on disk is still exactly the record we wrote. */
async function confirmHolder(path: string, rec: LeaseRecord): Promise<boolean> {
  const state = await inspectLease(path);
  if (state.state !== "held") return false;
  return (
    state.holder.run_id === rec.run_id &&
    state.holder.pid === rec.pid &&
    state.holder.host === rec.host &&
    state.holder.acquired_at === rec.acquired_at
  );
}

/**
 * Takes the worker tab for one run (§8, D10). Exactly one run drives the tab: two
 * concurrent runs on one tab is both a correctness bug and a detection signal.
 *
 * Re-entrant for the same run id, so a resumed run retakes its own lease. Reclaims
 * a lease whose holder is dead or whose file is corrupt. Never preempts a live
 * holder — that case raises a transient `TAB_LEASE_HELD` so the caller backs off.
 */
export async function acquireLease(
  o: { runId: string; capability: string; path?: string },
  attempt = 0,
): Promise<LeaseRecord> {
  const path = o.path ?? defaultLeasePath();
  const now = new Date().toISOString();
  const mine: LeaseRecord = {
    run_id: o.runId,
    pid: process.pid,
    host: hostname(),
    capability: o.capability,
    acquired_at: now,
  };

  try {
    await mkdir(dirname(path), { recursive: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code && UNWRITABLE.has(err.code)) throw unwritable(path, err);
    throw e;
  }

  // Fast path: nothing there. Exclusive create is the only atomic "claim if free".
  try {
    const fh = await open(path, "wx");
    try {
      await fh.writeFile(serialize(mine), "utf8");
    } finally {
      await fh.close();
    }
    return mine;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code && UNWRITABLE.has(err.code)) throw unwritable(path, err);
    if (err.code !== "EEXIST") throw e;
  }

  const state = await inspectLease(path);

  if (state.state === "free") {
    // It vanished between the create attempt and the read. Someone released it;
    // retry through the same door, bounded, so a lease being taken and dropped in
    // a tight loop cannot spin here forever.
    if (attempt >= 2) throw held("tab lease kept changing hands while acquiring it");
    return acquireLease(o, attempt + 1);
  }

  if (state.state === "held" && state.holder.run_id !== o.runId) {
    throw held(
      `tab lease held by run ${state.holder.run_id} (pid ${state.holder.pid}, ${state.holder.capability})`,
      JSON.stringify(state.holder),
    );
  }

  if (state.state === "foreign") {
    throw held(
      `tab lease held by run ${state.holder.run_id} on another host (${state.holder.host})`,
      JSON.stringify(state.holder),
    );
  }

  // Re-entry keeps the original acquisition time; the pid may have changed if the
  // run is being resumed by a new process.
  const record: LeaseRecord =
    state.state === "held"
      ? { ...mine, acquired_at: state.holder.acquired_at, renewed_at: now }
      : mine;

  try {
    await replaceWith(path, record);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code && UNWRITABLE.has(err.code)) throw unwritable(path, err);
    throw e;
  }

  // Two processes can judge the same lease reclaimable at the same moment and both
  // replace it. Waiting, then reading back, is what makes exactly one of them the
  // holder: the losers see someone else's record and refuse.
  await settle(LEASE_SETTLE_MS + Math.floor(Math.random() * LEASE_SETTLE_MS));
  if (!(await confirmHolder(path, record))) {
    throw held(`tab lease was taken by another run while reclaiming it`);
  }
  return record;
}

/**
 * Gives the tab back. Only the actual holder can release: a stale process must
 * never free the lease of whoever legitimately took it over.
 * Returns whether this run held it.
 */
export async function releaseLease(o: { runId: string; path?: string }): Promise<boolean> {
  const path = o.path ?? defaultLeasePath();
  const state = await inspectLease(path);
  if (state.state === "free" || state.state === "corrupt") return false;
  if (state.holder.run_id !== o.runId) return false;
  try {
    await unlink(path);
  } catch (e) {
    if (isMissing(e)) return false;
    throw e;
  }
  return true;
}
