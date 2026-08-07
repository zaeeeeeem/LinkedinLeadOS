import { chance, defaultRng, randFloat, randInt } from "../../core/input/random.js";
import type { Rng } from "../../core/input/random.js";
import type { WheelResult } from "../../core/input/cursor.js";
import {
  DWELL_MS_MAX,
  DWELL_MS_MIN,
  FALLBACK_VIEWPORT,
  LAYOUT_POLL_MS,
  LAYOUT_STABLE_READS,
  LAYOUT_TIMEOUT_MS,
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

export type Viewport = {
  width: number;
  height: number;
  /** Height of whatever this page actually scrolls — an inner element on
   *  LinkedIn, the document on an ordinary page. */
  scrollHeight: number;
  /** True when the scrollable thing is an inner element, not the document. */
  innerScroller: boolean;
  /** Visible height of that scroller. */
  scrollerHeight: number;
  /** `document.documentElement.scrollHeight`, kept for diagnosis — on LinkedIn
   *  it is a constant equal to the viewport and means nothing (D115). */
  documentScrollHeight: number;
};

export type LayoutResult = {
  viewport: Viewport | null;
  /** True once the document is taller than the viewport and has stopped growing. */
  settled: boolean;
  polls: number;
  waitedMs: number;
};

export type ReadResult = {
  passes: number;
  notches: number;
  /** Absolute pixels dispatched, summed over every pass. */
  scrolled: number;
  /** Total time paused between and after the passes. */
  pausedMs: number;
  viewport: Viewport | null;
  layout: LayoutResult;
};

/**
 * One round trip: the viewport, and the height of whatever this page actually
 * scrolls. A navigation-support DOM read (D1) — it decides where to dispatch a
 * wheel event and how far, never what any field contains.
 *
 * It does **not** trust `document.documentElement.scrollHeight`. Measured on a
 * real LinkedIn profile (2026-08-08, probe run `01KZHAHJ7504QSV57YC5RBZEV3`):
 * the document sat at `scrollHeight === clientHeight === 798` for 32 seconds
 * with `body { overflow: hidden }`, while the page was fully rendered — 875KB of
 * DOM, 23 sections, 31KB of text — inside `main#workspace`, which carried
 * `overflow-y: scroll`, `scrollHeight 7348`, `clientHeight 746`. LinkedIn scrolls
 * an inner element, so the document height is a constant that says nothing about
 * whether the page has content. See D115.
 *
 * So it picks the tallest genuinely-scrollable element on the page and falls
 * back to the document when there is none — a page that scrolls normally is
 * still measured correctly.
 */
/**
 * Which element on this page actually scrolls, as a JavaScript function
 * expression other page-scripts embed.
 *
 * Extracted so `VIEWPORT_EXPRESSION` and any other surface's probe ask the
 * question the same way. D115 is a measurement of *one* page; the rule that
 * found it — the tallest element with a real `overflow-y` and a viewport's worth
 * of height — is what carries to a surface nobody has measured yet, and two
 * copies of that rule would be two answers the day one of them was tuned.
 *
 * `null` when the document itself is the scroller.
 */
export const SCROLLER_SELECTION_JS = `(function () {
  var best = null;
  var els = document.querySelectorAll('*');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.clientHeight < 200) continue;
    if (el.scrollHeight <= el.clientHeight + 50) continue;
    var oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    if (best === null || el.scrollHeight > best.scrollHeight) best = el;
  }
  return best;
})`;

export const VIEWPORT_EXPRESSION = `(() => {
  try {
    var best = ${SCROLLER_SELECTION_JS}();
    var docH = (document.documentElement && document.documentElement.scrollHeight) || 0;
    return {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      scrollHeight: best ? best.scrollHeight : docH,
      /** True when an inner element scrolls, not the document. */
      innerScroller: !!best,
      scrollerHeight: best ? best.clientHeight : (window.innerHeight || 0),
      documentScrollHeight: docH,
    };
  } catch (e) { return null; }
})()`;

function isViewport(v: unknown): v is Viewport {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["width"] === "number" && o["width"] > 0 &&
    typeof o["height"] === "number" && o["height"] > 0 &&
    typeof o["scrollHeight"] === "number" &&
    typeof o["innerScroller"] === "boolean"
  );
}

/**
 * Waits for the page to lay out, then reports its measurements.
 *
 * `WorkerTab.navigate` resolves on `document.readyState === "complete"`. On a
 * single-page app that fires while the document is still an empty shell, and the
 * first live capture proved it: the profile measured `scrollHeight === innerHeight`,
 * so nothing scrolled, so no lazy section fetched, and the run archived the
 * profile's urn and none of its content — with an ok receipt and no warning.
 *
 * Settled means two things at once: the document is taller than the viewport (it
 * has content), and its height has stopped changing. Either alone is satisfiable
 * by an empty shell. It never throws — a page that cannot be measured returns
 * `settled: false` and the caller decides, because the page load is already spent.
 */
export async function waitForLayout(
  tab: ReadTab,
  o: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<LayoutResult> {
  const timeoutMs = o.timeoutMs ?? LAYOUT_TIMEOUT_MS;
  // A short window still gets several polls: a caller who asks for one cannot be
  // handed a single measurement, which is the pre-fix behaviour by another name.
  const pollMs = o.pollMs ?? Math.max(10, Math.min(LAYOUT_POLL_MS, Math.floor(timeoutMs / 5)));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  let viewport: Viewport | null = null;
  let stable = 0;
  let polls = 0;

  for (;;) {
    let measured: Viewport | null = null;
    try {
      const probe = await tab.evaluate<unknown>(VIEWPORT_EXPRESSION);
      if (isViewport(probe)) measured = probe;
    } catch {
      // The execution context is torn down and rebuilt during navigation, so a
      // failed read here means "not yet", never "broken".
      measured = null;
    }
    polls++;

    if (measured !== null) {
      const grew = viewport === null || measured.scrollHeight !== viewport.scrollHeight;
      stable = grew ? 0 : stable + 1;
      viewport = measured;
      if (measured.scrollHeight > measured.height && stable >= LAYOUT_STABLE_READS) {
        return { viewport, settled: true, polls, waitedMs: Date.now() - startedAt };
      }
    }

    if (Date.now() + pollMs > deadline) {
      return { viewport, settled: false, polls, waitedMs: Date.now() - startedAt };
    }
    await sleep(pollMs);
  }
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
  /** A layout already waited for. Omitted: this waits for one itself. */
  layout?: LayoutResult;
  layoutTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onPass?: (pass: { index: number; deltaY: number; result: WheelResult }) => void;
}): Promise<ReadResult> {
  const rng = o.rng ?? defaultRng;

  const layout =
    o.layout ??
    (await waitForLayout(o.tab, {
      ...(o.layoutTimeoutMs === undefined ? {} : { timeoutMs: o.layoutTimeoutMs }),
      ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
    }));
  const viewport = layout.viewport;

  const width = viewport?.width ?? FALLBACK_VIEWPORT.width;
  const height = viewport?.height ?? FALLBACK_VIEWPORT.height;
  const passes = o.passes ?? randInt(rng, SCROLL_PASSES_MIN, SCROLL_PASSES_MAX);

  // Never wheel further than the document actually is: past the bottom the
  // events land on nothing, which is both useless and a shape no reader makes.
  const visible = viewport ? viewport.scrollerHeight : height;
  const scrollable = viewport ? Math.max(0, viewport.scrollHeight - visible) : Infinity;

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

  return { passes: done, notches, scrolled, pausedMs, viewport, layout };
}
