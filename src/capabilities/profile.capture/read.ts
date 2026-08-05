import { chance, defaultRng, randFloat, randInt } from "../../core/input/random.js";
import type { Rng } from "../../core/input/random.js";
import type { WheelResult } from "../../core/input/cursor.js";
import {
  DWELL_MS_MAX,
  DWELL_MS_MIN,
  FALLBACK_VIEWPORT,
  POINTER_FRACTION_MAX,
  POINTER_FRACTION_MIN,
  SCROLL_BACK_PROBABILITY,
  SCROLL_FRACTION_MAX,
  SCROLL_FRACTION_MIN,
  SCROLL_PASSES_MAX,
  SCROLL_PASSES_MIN,
  SCROLL_PAUSE_MS_MAX,
  SCROLL_PAUSE_MS_MIN,
} from "./constants.js";

/** The slice of `WorkerTab` this needs. Structural, so the pacing is provable
 *  offline — a scroll plan that only works against a live page is untestable. */
export type ReadTab = {
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
};

/** The slice of `HumanCursor` this needs. */
export type ReadCursor = {
  wheel(x: number, y: number, deltaY: number, opts?: { maxNotches?: number }): Promise<WheelResult>;
  pause(min?: number, max?: number): Promise<number>;
};

export type Viewport = { width: number; height: number; scrollHeight: number };

export type ReadResult = {
  passes: number;
  notches: number;
  /** Absolute pixels dispatched, summed over every pass. */
  scrolled: number;
  /** Total time paused between and after the passes. */
  pausedMs: number;
  viewport: Viewport | null;
};

/**
 * One round trip, three numbers. Reading the viewport is a navigation-support
 * DOM read (D1) — it decides where to dispatch a wheel event, not what any field
 * contains.
 */
export const VIEWPORT_EXPRESSION = `(() => {
  try {
    return {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      scrollHeight: (document.documentElement && document.documentElement.scrollHeight) || 0,
    };
  } catch (e) { return null; }
})()`;

function isViewport(v: unknown): v is Viewport {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["width"] === "number" && o["width"] > 0 &&
    typeof o["height"] === "number" && o["height"] > 0 &&
    typeof o["scrollHeight"] === "number"
  );
}

/**
 * Reads the page the way a person would: several wheel passes down, pauses
 * between them, occasionally back up, then a dwell before leaving.
 *
 * Two things this buys, and they are the reason it is not a `sleep`. LinkedIn
 * lazy-loads the sections a profile parser actually wants — experience,
 * education, skills fetch on intersection — so a page that is never scrolled
 * never issues the requests the tap exists to capture. And a profile view with
 * no scroll and no dwell is a fingerprint (§8, "Pacing").
 *
 * It never throws. A viewport that cannot be measured falls back to a default
 * and still scrolls: the page load is already spent, and abandoning the capture
 * because a measurement failed spends it for nothing.
 */
export async function readLikeAHuman(o: {
  tab: ReadTab;
  cursor: ReadCursor;
  /** Explicit pass count. Omitted: a randomized 3–6. `0` scrolls not at all. */
  passes?: number;
  rng?: Rng;
  onPass?: (pass: { index: number; deltaY: number; result: WheelResult }) => void;
}): Promise<ReadResult> {
  const rng = o.rng ?? defaultRng;

  let viewport: Viewport | null = null;
  try {
    const probe = await o.tab.evaluate<unknown>(VIEWPORT_EXPRESSION);
    if (isViewport(probe)) viewport = probe;
  } catch {
    viewport = null;
  }

  const width = viewport?.width ?? FALLBACK_VIEWPORT.width;
  const height = viewport?.height ?? FALLBACK_VIEWPORT.height;
  const passes = o.passes ?? randInt(rng, SCROLL_PASSES_MIN, SCROLL_PASSES_MAX);

  // Never wheel further than the document actually is: past the bottom the
  // events land on nothing, which is both useless and a shape no reader makes.
  const scrollable = viewport ? Math.max(0, viewport.scrollHeight - height) : Infinity;

  let notches = 0;
  let scrolled = 0;
  let pausedMs = 0;
  let travelled = 0;
  let done = 0;

  for (let i = 0; i < passes; i++) {
    const x = Math.round(width * randFloat(rng, POINTER_FRACTION_MIN, POINTER_FRACTION_MAX));
    const y = Math.round(height * randFloat(rng, POINTER_FRACTION_MIN, POINTER_FRACTION_MAX));
    const magnitude = Math.round(height * randFloat(rng, SCROLL_FRACTION_MIN, SCROLL_FRACTION_MAX));

    // A pass back up is only possible once there is something above us.
    const back = travelled > 0 && chance(rng, SCROLL_BACK_PROBABILITY);
    let deltaY = back ? -Math.min(magnitude, travelled) : magnitude;
    if (!back) {
      const remaining = scrollable - travelled;
      if (remaining <= 0) break; // already at the bottom; more wheel is noise
      deltaY = Math.min(magnitude, remaining);
    }
    if (deltaY === 0) break;

    const result = await o.cursor.wheel(x, y, deltaY);
    notches += result.notches;
    scrolled += Math.abs(result.scrolled);
    travelled = Math.max(0, travelled + result.scrolled);
    done++;
    o.onPass?.({ index: i, deltaY, result });

    pausedMs += await o.cursor.pause(SCROLL_PAUSE_MS_MIN, SCROLL_PAUSE_MS_MAX);
  }

  // The dwell happens whether or not anything scrolled — a one-screen profile
  // still gets looked at.
  pausedMs += await o.cursor.pause(DWELL_MS_MIN, DWELL_MS_MAX);

  return { passes: done, notches, scrolled, pausedMs, viewport };
}
