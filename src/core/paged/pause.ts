import { existsSync } from "node:fs";
import { join } from "node:path";
import { PAUSE_FILE_NAME } from "./constants.js";
import type { StopReason } from "./types.js";

/**
 * Asked at every page boundary, before the next page is paid for. Returning a
 * reason stops the run cleanly with the checkpoint intact; returning `null`
 * lets it continue.
 */
export type StopRequest = () => StopReason | null | Promise<StopReason | null>;

/**
 * A run pauses when a `PAUSE` file appears in its run directory.
 *
 * A file rather than a signal, because the process that wants to stop a run is
 * usually not the one that started it: an agent supervising a long paged run
 * has the run id and the runs directory, and touching a file needs neither a
 * pid nor a port. It is polled at page boundaries only — mid-page pausing would
 * mean abandoning a page that has already been paid for.
 */
export function pauseFileStop(runDir: string): StopRequest {
  const path = join(runDir, PAUSE_FILE_NAME);
  return () => (existsSync(path) ? "paused" : null);
}

export type SignalPause = {
  /** The stop source to hand the loop. */
  stop: StopRequest;
  /** Whether a signal has been seen. */
  requested(): boolean;
  /** Removes the handlers. Must run on every exit path, or a long-lived
   *  process keeps a listener per run. */
  dispose(): void;
};

const DEFAULT_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];

/**
 * Ctrl-C stops at the next page boundary instead of killing the process
 * mid-page.
 *
 * The reference worker had no signal handling at all: a deploy or an OOM left
 * its run row reading "running" forever, and the page in flight was simply
 * lost. Here the default handler is *replaced*, so the first signal turns into
 * a clean stop that finishes the page it already paid for and checkpoints it.
 *
 * A second signal restores the default behaviour and re-raises — an operator
 * who means "stop now" must not have to find the pid. That path can leave a
 * page paid for and unproved, which is exactly the wasted-spend direction the
 * contract accepts and reports.
 */
export function installSignalPause(o: {
  signals?: NodeJS.Signals[];
  process?: Pick<NodeJS.Process, "on" | "off" | "kill" | "pid">;
  onSignal?: (signal: NodeJS.Signals, first: boolean) => void;
} = {}): SignalPause {
  const proc = o.process ?? process;
  const signals = o.signals ?? DEFAULT_SIGNALS;
  let seen = false;
  let disposed = false;

  const handlers = signals.map((signal) => {
    const handler = () => {
      const first = !seen;
      seen = true;
      o.onSignal?.(signal, first);
      if (first) return;
      // Second signal: stop being polite. Removing the handlers first is what
      // makes the re-raise terminate rather than loop back into this function.
      dispose();
      proc.kill(proc.pid, signal);
    };
    proc.on(signal, handler);
    return { signal, handler };
  });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const { signal, handler } of handlers) proc.off(signal, handler);
  }

  return {
    stop: () => (seen ? "paused" : null),
    requested: () => seen,
    dispose,
  };
}

/** First source to return a reason wins. Sources are asked in order, so a
 *  cheap in-memory check can precede a filesystem one. */
export function anyStop(...sources: (StopRequest | null | undefined)[]): StopRequest {
  const live = sources.filter((s): s is StopRequest => typeof s === "function");
  return async () => {
    for (const source of live) {
      const reason = await source();
      if (reason) return reason;
    }
    return null;
  };
}
