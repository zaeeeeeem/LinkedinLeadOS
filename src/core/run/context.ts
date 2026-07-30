import {
  existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ulid } from "ulid";
import { CapabilityError, EXIT } from "./receipt.js";
import type { Artifacts, Receipt } from "./receipt.js";
import { defaultRunsDir, receiptPath } from "./paths.js";
import { EventLogger } from "./events.js";
import type { EventFields, EventName, LoggedEvent } from "./events.js";

export type RunArgs = Record<string, unknown>;

/**
 * Persisted alongside the run. `resumed_at` accumulates one entry per resume so the
 * archive shows every session that touched this run, not just the last one.
 */
export type RunMeta = {
  run_id: string;
  capability: string;
  args: RunArgs;
  created_at: string;
  resumed_at: string[];
};

/**
 * Structural on purpose. Task 4's CDP tab handle satisfies this without context.ts
 * importing anything from Task 4 — the run context stays ignorant of CDP entirely.
 */
export type Screenshotter = { screenshot(filePath: string): Promise<void> };

type CheckpointFile = { saved_at: string; state: unknown };

export type RunContextPaths = {
  dir: string;
  meta: string;
  summary: string;
  events: string;
  raw: string;
  shots: string;
  checkpoint: string;
};

export type OpenOptions = {
  capability?: string;
  args?: RunArgs;
  runId?: string;
  runsDir?: string;
};

/**
 * Owns one run's identity, directory tree, event log, checkpoints, and artifact
 * paths. Every capability invocation opens exactly one of these and calls `finish()`
 * once at the end.
 */
export class RunContext {
  readonly runId: string;
  readonly capability: string;
  readonly args: RunArgs;
  readonly resumed: boolean;
  readonly dir: string;
  readonly paths: RunContextPaths;

  private readonly logger: EventLogger;
  private readonly openedAt: number;
  private finished = false;

  private constructor(o: {
    runId: string; capability: string; args: RunArgs; resumed: boolean;
    dir: string; paths: RunContextPaths; logger: EventLogger;
  }) {
    this.runId = o.runId;
    this.capability = o.capability;
    this.args = o.args;
    this.resumed = o.resumed;
    this.dir = o.dir;
    this.paths = o.paths;
    this.logger = o.logger;
    this.openedAt = Date.now();
  }

  static open(opts: OpenOptions): RunContext {
    const runsDir = resolve(opts.runsDir ?? defaultRunsDir());

    if (opts.runId) return RunContext.resume(runsDir, opts.runId, opts.capability, opts.args);
    return RunContext.create(runsDir, opts.capability, opts.args ?? {});
  }

  private static create(runsDir: string, capability: string | undefined, args: RunArgs): RunContext {
    if (!capability) {
      // Only a resume may omit the capability (it adopts the stored one). A fresh
      // run has nothing to adopt from.
      throw new CapabilityError({
        code: "RUN_CAPABILITY_REQUIRED", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
        retryable: false, message: "capability is required when opening a new run",
      });
    }

    const runId = ulid();
    const dir = join(runsDir, runId);
    const paths = buildPaths(dir);

    mkdirSync(paths.raw, { recursive: true });
    mkdirSync(paths.shots, { recursive: true });

    const meta: RunMeta = {
      run_id: runId, capability, args, created_at: new Date().toISOString(), resumed_at: [],
    };
    writeFileSync(paths.meta, JSON.stringify(meta, null, 2) + "\n");

    const logger = EventLogger.open(paths.events, runId);
    return new RunContext({ runId, capability, args, resumed: false, dir, paths, logger });
  }

  private static resume(
    runsDir: string, runId: string, capability: string | undefined, args: RunArgs | undefined,
  ): RunContext {
    const dir = join(runsDir, runId);
    const paths = buildPaths(dir);

    if (!existsSync(paths.meta)) {
      // Never silently create on an unknown run id — that would mask a typo'd id as
      // a fresh run and quietly drop whatever the caller thought it was resuming.
      throw new CapabilityError({
        code: "RUN_NOT_FOUND", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
        retryable: false, message: `no run found with id ${runId}`,
      });
    }

    const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as RunMeta;

    if (capability && capability !== meta.capability) {
      // Appending one capability's events into another capability's run corrupts the
      // archive: the event log and raw/ dir would mix two unrelated invocations under
      // one run_id, and log:why / log:drift would attribute one capability's failures
      // to the other.
      throw new CapabilityError({
        code: "RUN_CAPABILITY_MISMATCH", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
        retryable: false,
        message: `run ${runId} was opened for ${meta.capability}, not ${capability}`,
      });
    }

    const resumedAt = new Date().toISOString();
    meta.resumed_at = [...meta.resumed_at, resumedAt];
    writeAtomic(paths.meta, JSON.stringify(meta, null, 2) + "\n");

    const logger = EventLogger.open(paths.events, runId);
    const hadCheckpoint = existsSync(paths.checkpoint);
    logger.log("checkpoint.resume", {
      detail: { prior_checkpoint_found: hadCheckpoint },
    });

    const finalArgs = args ?? meta.args;
    return new RunContext({
      runId, capability: meta.capability, args: finalArgs, resumed: true, dir, paths, logger,
    });
  }

  log(event: EventName, fields?: EventFields): LoggedEvent {
    return this.logger.log(event, fields);
  }

  /** Atomic tmp+rename write. Latest write wins — no history of prior checkpoints. */
  checkpoint(state: unknown): void {
    const payload: CheckpointFile = { saved_at: new Date().toISOString(), state };
    writeAtomic(this.paths.checkpoint, JSON.stringify(payload, null, 2) + "\n");
    this.logger.log("checkpoint.save");
  }

  lastCheckpoint<T = unknown>(): T | null {
    if (!existsSync(this.paths.checkpoint)) return null;
    const payload = JSON.parse(readFileSync(this.paths.checkpoint, "utf8")) as CheckpointFile;
    return payload.state as T;
  }

  /**
   * Writes into shots/ as `NNN-<sanitized-name>.png`. The counter seeds from the
   * existing file count so a resumed run never overwrites a prior run's screenshot.
   */
  async screenshot(tab: Screenshotter, name: string): Promise<string> {
    const existing = existsSync(this.paths.shots) ? readdirSync(this.paths.shots) : [];
    const seq = existing.length + 1;
    const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, "-");
    const fileName = `${String(seq).padStart(3, "0")}-${safeName}.png`;
    const filePath = join(this.paths.shots, fileName);
    await tab.screenshot(filePath);
    return filePath;
  }

  /** Milliseconds since this context opened. Per-invocation, not cumulative across resumes. */
  elapsedMs(): number {
    return Date.now() - this.openedAt;
  }

  artifacts(): Artifacts {
    return {
      events: receiptPath(this.paths.events),
      raw: receiptPath(this.paths.raw) + "/",
    };
  }

  /**
   * Persists the receipt as summary.json and closes the logger. Never prints and
   * never exits — `emitReceipt` in receipt.ts owns stdout and the process exit.
   * Safe to call more than once; only the first call has any effect.
   */
  finish(receipt: Receipt): void {
    if (this.finished) return;
    this.finished = true;
    writeFileSync(this.paths.summary, JSON.stringify(receipt, null, 2) + "\n");
    this.logger.close();
  }
}

function buildPaths(dir: string): RunContextPaths {
  return {
    dir,
    meta: join(dir, "run.json"),
    summary: join(dir, "summary.json"),
    events: join(dir, "events.ndjson"),
    raw: join(dir, "raw"),
    shots: join(dir, "shots"),
    checkpoint: join(dir, "checkpoint.json"),
  };
}

/** tmp-file-in-same-dir + rename so a reader never observes a half-written file. */
function writeAtomic(filePath: string, contents: string): void {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, contents);
  renameSync(tmp, filePath);
}
