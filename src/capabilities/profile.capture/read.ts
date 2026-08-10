import { chance, defaultRng, randFloat, randInt } from "../../core/input/random.js";
import type { Rng } from "../../core/input/random.js";
import type { WheelResult } from "../../core/input/cursor.js";
import {
  BOTTOM_STABLE_READS,
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
  SCROLL_PASSES_CEILING,
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

/**
 * Enough of an element to say *which* element it was, without reading anything
 * a class name would give away. Class names on this page are content-hashed and
 * churn on every deploy (D128's reasoning), so they are deliberately not here.
 */
export type ScrollerDescriptor = {
  tag: string;
  id: string | null;
  role: string | null;
  /** LinkedIn's SDUI component key, when the element carries one. */
  componentkey: string | null;
  scrollHeight: number;
  clientHeight: number;
};

/**
 * How many scroller candidates are described. A page has a handful; a bound
 * exists because this rides on every receipt and an unbounded list from a page
 * we do not control is not a thing to ship. `scrollerCandidates` reports the
 * true total, so a truncated list is visible rather than silently short.
 */
export const MAX_SCROLLER_CANDIDATES = 8;

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
  /**
   * Which element was measured. Optional because a page that has no inner
   * scroller has none to describe, and because a caller (or a test double) from
   * before this existed still satisfies `Viewport`.
   *
   * It exists because "the scroller is `main#workspace`" is a fact about the
   * profile page and an assumption about every other one (M4 CONTEXT rule 3).
   * A height alone cannot tell an operator which container it came from, so a
   * new surface could report a settled layout while scrolling the wrong box.
   */
  scroller?: ScrollerDescriptor | null;
  /** Every genuinely-scrollable element found, tallest first, capped at
   *  `MAX_SCROLLER_CANDIDATES`. */
  scrollers?: ScrollerDescriptor[];
  /** How many candidates there were in total, cap or no cap. */
  scrollerCandidates?: number;
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
  /**
   * Absolute pixels dispatched, summed over every pass — **distance travelled,
   * not distance covered.** A back-pass adds to it. Use it to describe effort;
   * never to answer "did we reach the bottom", which is `travelled`.
   */
  scrolled: number;
  /**
   * Where the scroller ended up, in pixels from the top. This is the number
   * that says how far down the page actually got: `scrolled` counts a pass down
   * and the pass back up as 1200px of progress on a 900px page.
   */
  travelled: number;
  /**
   * How far there was left to go, **as last measured** — the page is
   * re-measured between passes because a lazy feed grows as it renders. `null`
   * when the page could not be measured at all.
   */
  scrollable: number | null;
  /** Total time paused between and after the passes. */
  pausedMs: number;
  /**
   * Whether the read ended because the page was finished rather than because the
   * pass budget was.
   *
   * `null` when the caller asked for a fixed number of passes — a fixed read makes
   * no claim about the bottom, and a `false` there would read as a failure when it
   * is the caller's own instruction. Only a bottom-seeking read (`untilBottom`)
   * answers this, and `false` there means the ceiling was hit with page left.
   */
  reachedBottom: boolean | null;
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
    var MAX = ${MAX_SCROLLER_CANDIDATES};
    var attr = function (el, name) {
      try { return el.getAttribute ? el.getAttribute(name) : null; } catch (e) { return null; }
    };
    var describe = function (el) {
      return {
        tag: (el.tagName || '').toLowerCase(),
        id: attr(el, 'id') || null,
        role: attr(el, 'role') || null,
        componentkey: attr(el, 'componentkey') || null,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      };
    };
    var best = ${SCROLLER_SELECTION_JS}();
    var found = [];
    var els = document.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.clientHeight < 200) continue;
      if (el.scrollHeight <= el.clientHeight + 50) continue;
      var oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
      found.push(el);
    }
    found.sort(function (a, b) { return b.scrollHeight - a.scrollHeight; });
    var described = [];
    for (var j = 0; j < found.length && j < MAX; j++) described.push(describe(found[j]));
    var docH = (document.documentElement && document.documentElement.scrollHeight) || 0;
    return {
      width: window.innerWidth || 0,
      height: window.innerHeight || 0,
      scrollHeight: best ? best.scrollHeight : docH,
      /** True when an inner element scrolls, not the document. */
      innerScroller: !!best,
      scrollerHeight: best ? best.clientHeight : (window.innerHeight || 0),
      documentScrollHeight: docH,
      /** Which element was measured, and what else could have been. */
      scroller: best ? describe(best) : null,
      scrollers: described,
      scrollerCandidates: found.length,
    };
  } catch (e) { return null; }
})()`;

/**
 * How much of the page is still an unfilled placeholder.
 *
 * LinkedIn defers everything below the Activity card into numbered parts —
 * `<div id="profileCardsBelowActivityPart3tankots">` — each carrying an
 * `onComponentAppear` trigger at `visibilityRatio: 0` whose action is an
 * `AsyncComponentRequest` for its own content. Read from the initial document of
 * run `01KZMMFNSMFJ8CKHV9R9JJZ1GY`; the parts hold Experience, Education, Skills
 * and the rest (D320).
 *
 * A part that is never scrolled into view never fetches, and stays an empty div.
 * That is a render-confirmation read, which D1 permits everywhere: it counts
 * containers and asks whether they are empty. It never reads a field out of one —
 * the content is read offline from the archived snapshot, as D123 requires.
 *
 * Only the outer element carries an `id`; the inner mirrors carry the
 * `componentkey` alone, so selecting on `id` counts each part once.
 */
export const DEFERRED_SECTIONS_EXPRESSION = `(() => {
  try {
    var nodes = document.querySelectorAll('[id^="profileCardsBelowActivity"]');
    var hydrated = 0;
    for (var i = 0; i < nodes.length; i++) {
      var text = (nodes[i].textContent || '').trim();
      if (text.length > 0) hydrated++;
    }
    return { total: nodes.length, hydrated: hydrated };
  } catch (e) { return null; }
})()`;

/** Consecutive unreadable measurements before the deferred wait stops waiting. */
export const UNREADABLE_READS_GIVE_UP = 3;

export type DeferredSections = {
  /** Deferred containers on the page. `0` means this page defers nothing. */
  total: number;
  /**
   * How many have content. Never expected to equal `total`: a part whose section
   * the person has nothing in stays legitimately empty — the live 2026-08-10 read
   * finished at 6 of 7. `0` with a non-zero `total` is the failure this measures.
   */
  hydrated: number;
};

function isDeferredSections(v: unknown): v is DeferredSections {
  if (v === null || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o["total"] === "number" && typeof o["hydrated"] === "number";
}

/** One measurement. `null` when the page could not be read, which during a
 *  navigation means "not yet" rather than "broken". */
export async function measureDeferredSections(tab: ReadTab): Promise<DeferredSections | null> {
  try {
    const probe = await tab.evaluate<unknown>(DEFERRED_SECTIONS_EXPRESSION);
    return isDeferredSections(probe) ? probe : null;
  } catch {
    return null;
  }
}

/**
 * Waits for the deferred parts the read brought into view to actually arrive.
 *
 * The request is issued by the page on intersection and answered over the
 * network, so the last one is still in flight when the last scroll ends. Passive
 * and bounded: it polls a count, requests nothing, and spends nothing but time.
 * Returns the last measurement it managed, `null` if it never managed one.
 */
export async function waitForDeferredSections(
  tab: ReadTab,
  o: { timeoutMs: number; pollMs?: number; sleep?: (ms: number) => Promise<void> },
): Promise<DeferredSections | null> {
  const pollMs = o.pollMs ?? Math.max(10, Math.min(LAYOUT_POLL_MS, Math.floor(o.timeoutMs / 5)));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + o.timeoutMs;
  let last: DeferredSections | null = null;
  let stable = 0;
  let unreadable = 0;

  for (;;) {
    const measured = await measureDeferredSections(tab);
    if (measured === null) {
      // A page that will not answer this at all is not going to start: waiting
      // out the full window buys nothing, and the snapshot gate downstream is
      // what reports an unreadable page anyway.
      if (++unreadable >= UNREADABLE_READS_GIVE_UP) return last;
    } else {
      unreadable = 0;
      // A page that defers nothing is done before it starts.
      if (measured.total === 0) return measured;
      stable = last !== null && measured.hydrated === last.hydrated ? stable + 1 : 0;
      last = measured;
      // Something arrived and the count has stopped moving. `total` is never the
      // bar: a part with no section behind it stays empty however long we wait.
      if (measured.hydrated > 0 && stable >= LAYOUT_STABLE_READS) return measured;
    }
    if (Date.now() + pollMs > deadline) return last;
    await sleep(pollMs);
  }
}

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
/**
 * One viewport measurement. `null` when the page cannot be read — during a
 * navigation the execution context is torn down and rebuilt, and that means
 * "not yet", never "broken".
 */
export async function measureViewport(tab: ReadTab): Promise<Viewport | null> {
  try {
    const probe = await tab.evaluate<unknown>(VIEWPORT_EXPRESSION);
    return isViewport(probe) ? probe : null;
  } catch {
    return null;
  }
}

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
    const measured = await measureViewport(tab);
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
  /**
   * Read to the bottom of the page instead of for a fixed number of passes,
   * bounded by `maxPasses`.
   *
   * Opt-in, and deliberately not the default: it is right for a page that ends
   * (a profile, a job) and wrong for one that does not (a feed), where it would
   * mean "scroll until the ceiling" every time. Ignored when `passes` is given —
   * an explicit count is an instruction, not a hint.
   */
  untilBottom?: boolean;
  /** The ceiling on a bottom-seeking read. Omitted: `SCROLL_PASSES_CEILING`. */
  maxPasses?: number;
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
  let viewport = layout.viewport;

  const width = viewport?.width ?? FALLBACK_VIEWPORT.width;
  const height = viewport?.height ?? FALLBACK_VIEWPORT.height;
  // A bottom-seeking read still randomizes everything a watcher could see — the
  // wheel magnitudes, the pauses, the back-passes, where the pointer sits. What
  // it stops randomizing is when to give up on a page it has not finished, which
  // is not a human tell: people read to the end of a profile.
  const seeking = o.passes === undefined && o.untilBottom === true;
  const ceiling = o.maxPasses ?? SCROLL_PASSES_CEILING;
  const passes = o.passes ?? (seeking ? ceiling : randInt(rng, SCROLL_PASSES_MIN, SCROLL_PASSES_MAX));

  /**
   * How far there is left to go, from the *latest* measurement.
   *
   * Measured per pass rather than once, because a lazily-rendered page grows as
   * it is read: an activity feed measures one screenful before anything has
   * rendered, and a budget taken from that measurement stops the reader at the
   * height the page had before it had any content. On a profile — finite, and
   * mostly rendered by the time layout settles — this made no difference, which
   * is why it survived until a feed surface needed it.
   *
   * `Infinity` when the page cannot be measured at all: the fallback is to keep
   * scrolling, exactly as before, rather than to stop.
   */
  const extentOf = (v: Viewport | null): number =>
    v === null ? Infinity : Math.max(0, v.scrollHeight - v.scrollerHeight);

  let scrollable = extentOf(viewport);

  let notches = 0;
  let scrolled = 0;
  let pausedMs = 0;
  let travelled = 0;
  let done = 0;
  /** Consecutive measurements agreeing there is nothing left to scroll. */
  let atBottom = 0;
  let reachedBottom: boolean | null = seeking ? false : null;

  for (let i = 0; i < passes; i++) {
    const x = Math.round(width * randFloat(rng, POINTER_FRACTION_MIN, POINTER_FRACTION_MAX));
    const y = Math.round(height * randFloat(rng, POINTER_FRACTION_MIN, POINTER_FRACTION_MAX));
    const magnitude = Math.round(height * randFloat(rng, SCROLL_FRACTION_MIN, SCROLL_FRACTION_MAX));

    // A pass back up is only possible once there is something above us.
    const back = travelled > 0 && chance(rng, SCROLL_BACK_PROBABILITY);
    let deltaY = back ? -Math.min(magnitude, travelled) : magnitude;
    if (!back) {
      const remaining = scrollable - travelled;
      if (remaining <= 0) {
        // Already at the bottom; more wheel is noise.
        if (!seeking) break;
        // A bottom-seeking read does not take the first such measurement as the
        // end: the deferred section fetched by the pass that reached the bottom
        // lands *after* it, and the page grows again (D320). Pause, re-measure,
        // and only believe two in a row.
        atBottom++;
        pausedMs += await o.cursor.pause(SCROLL_PAUSE_MS_MIN, SCROLL_PAUSE_MS_MAX);
        const grown = await measureViewport(o.tab);
        if (grown !== null) {
          viewport = grown;
          scrollable = extentOf(grown);
        }
        if (scrollable - travelled <= 0 && atBottom >= BOTTOM_STABLE_READS) {
          reachedBottom = true;
          break;
        }
        continue;
      }
      atBottom = 0;
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

    // After the pause, so whatever the last pass triggered has had its chance
    // to render. A failed read leaves the previous measurement standing rather
    // than collapsing the budget to zero mid-read.
    const remeasured = await measureViewport(o.tab);
    if (remeasured !== null) {
      viewport = remeasured;
      scrollable = extentOf(remeasured);
    }
  }

  // A page shorter than the viewport was read the moment it was opened. Without
  // this, a one-screen profile reports `reachedBottom: false` and earns a warning
  // for being small.
  if (seeking && reachedBottom === false && scrollable - travelled <= 0) reachedBottom = true;

  // The dwell happens whether or not anything scrolled — a one-screen profile
  // still gets looked at.
  pausedMs += await o.cursor.pause(DWELL_MS_MIN, DWELL_MS_MAX);

  return {
    passes: done,
    notches,
    scrolled,
    travelled,
    scrollable: Number.isFinite(scrollable) ? scrollable : null,
    pausedMs,
    reachedBottom,
    viewport,
    layout,
  };
}
