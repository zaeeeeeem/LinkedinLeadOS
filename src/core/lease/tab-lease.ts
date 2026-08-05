import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  defaultLeasePath,
  LEASE_RETRY_AFTER_MS,
  LEASE_SCRATCH_PREFIX,
  LEASE_SCRATCH_TTL_MS,
} from "./constants.js";

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

/** Rethrows, turning a "this path will never be writable" errno into the fatal class. */
function rethrow(path: string, e: unknown): never {
  const err = e as NodeJS.ErrnoException;
  if (err.code && UNWRITABLE.has(err.code)) throw unwritable(path, err);
  throw e;
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

function classify(text: string): Exclude<LeaseState, { state: "free" }> {
  const parsed = parseRecord(text);
  if ("bad" in parsed) return { state: "corrupt", reason: parsed.bad };
  if (parsed.host !== hostname()) return { state: "foreign", holder: parsed };
  return pidAlive(parsed.pid) ? { state: "held", holder: parsed } : { state: "stale", holder: parsed };
}

/**
 * Reads the lease and keeps the exact bytes alongside the verdict. The bytes are
 * what makes reclaim provable: they are the evidence that the file being taken
 * away is still the one that was judged reclaimable.
 */
async function readLease(path: string): Promise<{ state: LeaseState; text: string | undefined }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if (isMissing(e)) return { state: { state: "free" }, text: undefined };
    throw e;
  }
  return { state: classify(text), text };
}

/** Reads the lease without changing anything. Safe to call from a health check. */
export async function inspectLease(path: string = defaultLeasePath()): Promise<LeaseState> {
  return (await readLease(path)).state;
}

const serialize = (r: LeaseRecord) => JSON.stringify(r) + "\n";

const scratchPath = (path: string, kind: string) =>
  join(dirname(path), `${LEASE_SCRATCH_PREFIX}${kind}.${process.pid}.${randomUUID()}`);

/**
 * Removes temp and quarantine files a crashed acquire left behind. Nothing else
 * ever cleans them, and an untouched one is garbage by definition — the sequences
 * that create them finish in milliseconds.
 */
async function sweepScratch(path: string): Promise<void> {
  const dir = dirname(path);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - LEASE_SCRATCH_TTL_MS;
  await Promise.all(
    names
      .filter((n) => n.startsWith(LEASE_SCRATCH_PREFIX))
      .map(async (n) => {
        const p = join(dir, n);
        try {
          if ((await stat(p)).mtimeMs < cutoff) await unlink(p);
        } catch {
          /* raced with its owner, or already gone */
        }
      }),
  );
}

/** Claims an absent lock exclusively. Returns false when someone else got there first. */
async function claim(path: string, rec: LeaseRecord): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    rethrow(path, e);
  }
  try {
    await fh.writeFile(serialize(rec), "utf8");
  } finally {
    await fh.close();
  }
  return true;
}

/**
 * Takes a reclaimable lease away and claims the space it occupied. `observed` is
 * the exact file content that was judged reclaimable.
 *
 * Exported for the tests: the race this closes is two callers that both read the
 * same stale record before either writes, which cannot be staged by starting
 * processes at different times — by then the first one's record is already on
 * disk and the second is refused before it ever reaches here.
 *
 * The removal is a `rename` to a unique quarantine name, which is atomic: of
 * several processes that judged the same lease reclaimable, exactly one moves the
 * original file. A loser either finds nothing to rename, or quarantines a record
 * that is not the one it judged — in which case it puts the file back untouched
 * and refuses, because that record belongs to whoever won.
 *
 * That is what makes single-holder a property of the filesystem rather than of
 * timing. An earlier version replaced the lock with `rename` and read it back after
 * a settle delay; the delay bounded nothing, since a racer's write can land after
 * an earlier racer's read-back has already returned, leaving both believing they
 * hold the lease.
 */
export async function reclaimObserved(path: string, observed: string, mine: LeaseRecord): Promise<LeaseRecord> {
  const quarantine = scratchPath(path, "quarantine");
  try {
    await rename(path, quarantine);
  } catch (e) {
    if (isMissing(e)) throw held("tab lease was reclaimed by another run first");
    rethrow(path, e);
  }

  let taken: string | undefined;
  try {
    taken = await readFile(quarantine, "utf8");
  } catch {
    taken = undefined;
  }

  if (taken !== observed) {
    // Someone replaced the lock between the read that judged it and this rename.
    // The record now in hand is a live holder's, so restore it and stand down.
    await rename(quarantine, path).catch(() => {});
    throw held("tab lease changed hands while it was being reclaimed");
  }

  await unlink(quarantine).catch(() => {});
  if (!(await claim(path, mine))) {
    throw held("tab lease was taken by another run while it was being reclaimed");
  }
  return mine;
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
    rethrow(path, e);
  }
  if (attempt === 0) await sweepScratch(path);

  // Fast path: nothing there. Exclusive create is the only atomic "claim if free".
  if (await claim(path, mine)) return mine;

  const { state, text } = await readLease(path);

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

  // Re-entry. The holder is this run, so no other run can be competing for the
  // file: replacing it in place is safe, and keeps the original acquisition time
  // while picking up the current pid for a run resumed by a new process.
  if (state.state === "held") {
    const renewed: LeaseRecord = { ...mine, acquired_at: state.holder.acquired_at, renewed_at: now };
    const tmp = scratchPath(path, "renew");
    try {
      await writeFile(tmp, serialize(renewed), "utf8");
      await rename(tmp, path);
    } catch (e) {
      await unlink(tmp).catch(() => {});
      rethrow(path, e);
    }
    return renewed;
  }

  // Stale or corrupt: reclaimable, and `text` is the evidence of what was judged.
  return reclaimObserved(path, text!, mine);
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

/**
 * Drops the lease whoever holds it — the operator's escape hatch from D16.
 *
 * D16 refuses any age-based staleness rule, so a crashed run whose pid gets
 * recycled by an unrelated process leaves a lease that reads as live forever and
 * wedges the tab. That was accepted deliberately, on the condition that the way
 * out is an explicit operator action rather than a timer. This is that action:
 * it never runs on its own, only behind `--force-release`, and it returns the
 * record it removed so the caller can put the holder it just evicted on the
 * receipt. Taking a lease away without saying whose it was is how one run
 * silently ends up driving another run's tab.
 */
export async function forceReleaseLease(
  path: string = defaultLeasePath(),
): Promise<{ released: boolean; state: LeaseState; priorHolder: LeaseRecord | null }> {
  const state = await inspectLease(path);
  if (state.state === "free") return { released: false, state, priorHolder: null };
  const priorHolder = "holder" in state ? state.holder : null;
  try {
    await unlink(path);
  } catch (e) {
    if (isMissing(e)) return { released: false, state: { state: "free" }, priorHolder: null };
    rethrow(path, e);
  }
  return { released: true, state, priorHolder };
}
