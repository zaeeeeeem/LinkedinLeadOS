import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The closed set of event names (spec §5). Free-form names are refused at runtime as
 * well as in the type system: the log query capabilities (`log:why`, `log:drift`)
 * group by this field, and one typo'd name is a silently missing row in every answer
 * they give afterwards.
 */
export const EVENT_NAMES = [
  "cdp.send", "cdp.event", "nav.start", "nav.done", "render.wait",
  "capture.hit", "capture.miss", "parse.ok", "parse.miss", "store.write",
  "budget.spend", "challenge.detected", "checkpoint.save", "checkpoint.resume",
  "error",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const EVENT_NAME_SET: ReadonlySet<string> = new Set<string>(EVENT_NAMES);

export function isEventName(name: string): name is EventName {
  return EVENT_NAME_SET.has(name);
}

export const EVENT_LEVELS = ["debug", "info", "warn", "error"] as const;
export type EventLevel = (typeof EVENT_LEVELS)[number];

/** Everything a caller may attach to an event. `level` defaults to `info`. */
export type EventFields = {
  level?: EventLevel;
  phase?: string;
  item_ref?: string;
  duration_ms?: number;
  detail?: Record<string, unknown>;
};

/** One NDJSON line. Field order here is the field order on disk. */
export type LoggedEvent = {
  ts: string;
  run_id: string;
  seq: number;
  level: EventLevel;
  event: EventName;
  phase?: string;
  item_ref?: string;
  duration_ms?: number;
  detail?: Record<string, unknown>;
};

/**
 * Append-only NDJSON writer over a single held file descriptor.
 *
 * Writes are synchronous on purpose. The log is the forensic record of a run that may
 * die at any moment — a buffered async writer loses exactly the last few events, which
 * are the ones explaining why the run died.
 */
export class EventLogger {
  private readonly fd: number;
  private nextSeq: number;
  private closed = false;

  private constructor(
    readonly filePath: string,
    readonly runId: string,
    fd: number,
    startSeq: number,
  ) {
    this.fd = fd;
    this.nextSeq = startSeq;
  }

  /**
   * Opens (creating parents) for append. On an existing file the sequence continues
   * past the highest one already recorded, so a resumed run never re-uses a seq.
   */
  static open(filePath: string, runId: string): EventLogger {
    mkdirSync(dirname(filePath), { recursive: true });
    const startSeq = existsSync(filePath) ? lastSeq(filePath) + 1 : 1;
    const fd = openSync(filePath, "a");
    // A crash can leave a half-written final line with no newline; appending straight
    // after it would fuse two records into one unparseable line.
    if (startSeq > 1 && !endsWithNewline(filePath)) writeSync(fd, "\n");
    return new EventLogger(filePath, runId, fd, startSeq);
  }

  /** The seq the next `log()` call will use. */
  get seq(): number {
    return this.nextSeq;
  }

  log(event: EventName, fields: EventFields = {}): LoggedEvent {
    if (this.closed) throw new Error(`EventLogger for run ${this.runId} is closed`);
    if (!isEventName(event)) throw new Error(`unknown event name: ${event}`);

    const line: LoggedEvent = {
      ts: new Date().toISOString(),
      run_id: this.runId,
      seq: this.nextSeq++,
      level: fields.level ?? "info",
      event,
    };
    if (fields.phase !== undefined) line.phase = fields.phase;
    if (fields.item_ref !== undefined) line.item_ref = fields.item_ref;
    if (fields.duration_ms !== undefined) line.duration_ms = fields.duration_ms;
    if (fields.detail !== undefined) line.detail = fields.detail;

    writeSync(this.fd, JSON.stringify(line) + "\n");
    return line;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}

/** Reads every complete event line. Truncated trailing lines are skipped, not fatal. */
export function readEvents(filePath: string): LoggedEvent[] {
  if (!existsSync(filePath)) return [];
  const out: LoggedEvent[] = [];
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LoggedEvent);
    } catch {
      // a partial line from a killed process — the rest of the log still stands
    }
  }
  return out;
}

function lastSeq(filePath: string): number {
  let max = 0;
  for (const e of readEvents(filePath)) {
    if (typeof e.seq === "number" && e.seq > max) max = e.seq;
  }
  return max;
}

function endsWithNewline(filePath: string): boolean {
  const buf = readFileSync(filePath);
  return buf.length === 0 || buf[buf.length - 1] === 0x0a;
}
