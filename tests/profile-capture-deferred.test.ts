import { describe, expect, it } from "vitest";
import {
  DEFERRED_SECTIONS_EXPRESSION,
  readLikeAHuman,
  waitForDeferredSections,
} from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab } from "../src/capabilities/profile.capture/read.js";
import {
  SCROLL_PASSES_CEILING,
  SCROLL_PASSES_MAX,
} from "../src/capabilities/profile.capture/constants.js";

/**
 * D320: a profile is read to its end, not for a fixed number of passes.
 *
 * The live failure this pins — run `01KZMMFNSMFJ8CKHV9R9JJZ1GY`, 2026-08-10 — was
 * silent and clean: exit 0, a person row stored, and no employment anywhere in it,
 * because the page laid out at 2145px, grew to 7348px as it was read, and the
 * randomized 3-6 passes stopped at 3366px with every deferred card below the
 * Activity section still an empty div.
 */

type Dispatched = { x: number; y: number; deltaY: number };

function fakeCursor(): ReadCursor & { moves: Dispatched[] } {
  const moves: Dispatched[] = [];
  return {
    moves,
    async wheel(x, y, deltaY) {
      moves.push({ x, y, deltaY });
      return {
        requested: deltaY,
        scrolled: deltaY,
        notches: Math.max(1, Math.round(Math.abs(deltaY) / 80)),
      };
    },
    async pause() {
      return 0;
    },
  };
}

const HEIGHT = 900;

function viewport(scrollHeight: number) {
  return {
    width: 1440,
    height: HEIGHT,
    scrollHeight,
    innerScroller: true,
    scrollerHeight: HEIGHT,
    documentScrollHeight: HEIGHT,
  };
}

/**
 * A page that grows as it is read, which is the whole difficulty: a budget taken
 * from the first measurement is a budget for a page that no longer exists.
 * `finalHeight` is where the growth stops.
 */
function growingTab(o: { start: number; growthPerRead: number; finalHeight: number }): ReadTab {
  let height = o.start;
  return {
    async evaluate<T>(): Promise<T> {
      const answer = viewport(height);
      height = Math.min(o.finalHeight, height + o.growthPerRead);
      return answer as T;
    },
  };
}

const settledAt = (scrollHeight: number) => ({
  viewport: viewport(scrollHeight),
  settled: true,
  polls: 1,
  waitedMs: 0,
});

/** Deterministic, so a pass count is a fact rather than a coin toss. */
const rng = () => 0.5;

describe("readLikeAHuman, reading to the bottom", () => {
  it("keeps going past the fixed-pass default until a growing page ends", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: growingTab({ start: 2145, growthPerRead: 900, finalHeight: 7348 }),
      cursor,
      untilBottom: true,
      rng,
      layout: settledAt(2145),
      sleep: async () => {},
    });

    expect(result.reachedBottom).toBe(true);
    // The bug, stated as a test: the default budget cannot cover this page.
    expect(result.passes).toBeGreaterThan(SCROLL_PASSES_MAX);
    expect(result.travelled).toBeGreaterThanOrEqual(7348 - HEIGHT);
  });

  it("stops at the ceiling on a page that never ends, and says so", async () => {
    const result = await readLikeAHuman({
      tab: growingTab({ start: 2145, growthPerRead: 4000, finalHeight: Number.MAX_SAFE_INTEGER }),
      cursor: fakeCursor(),
      untilBottom: true,
      rng,
      layout: settledAt(2145),
      sleep: async () => {},
    });

    // Bounded. A reader that cannot finish reports a partial read rather than
    // scrolling a feed forever.
    expect(result.passes).toBe(SCROLL_PASSES_CEILING);
    expect(result.reachedBottom).toBe(false);
  });

  it("honours an explicit pass count over untilBottom, and claims nothing about the bottom", async () => {
    const result = await readLikeAHuman({
      tab: growingTab({ start: 2145, growthPerRead: 900, finalHeight: 7348 }),
      cursor: fakeCursor(),
      untilBottom: true,
      passes: 2,
      rng,
      layout: settledAt(2145),
      sleep: async () => {},
    });

    expect(result.passes).toBe(2);
    expect(result.reachedBottom).toBeNull();
  });

  it("leaves a caller that did not ask for it on the old fixed-pass behaviour", async () => {
    const result = await readLikeAHuman({
      tab: growingTab({ start: 2145, growthPerRead: 900, finalHeight: 7348 }),
      cursor: fakeCursor(),
      rng,
      layout: settledAt(2145),
      sleep: async () => {},
    });

    // A feed surface must not inherit "scroll to the bottom" by accident.
    expect(result.reachedBottom).toBeNull();
    expect(result.passes).toBeLessThanOrEqual(SCROLL_PASSES_MAX);
  });

  it("calls a page shorter than the viewport read, not unfinished", async () => {
    const result = await readLikeAHuman({
      tab: growingTab({ start: 400, growthPerRead: 0, finalHeight: 400 }),
      cursor: fakeCursor(),
      untilBottom: true,
      rng,
      layout: settledAt(400),
      sleep: async () => {},
    });

    expect(result.reachedBottom).toBe(true);
    expect(result.passes).toBe(0);
  });
});

/** Answers a scripted series of deferred-section counts, one per poll. */
function countingTab(sequence: unknown[]): ReadTab {
  let i = 0;
  return {
    async evaluate<T>(): Promise<T> {
      return (sequence[Math.min(i++, sequence.length - 1)] ?? null) as T;
    },
  };
}

describe("waitForDeferredSections", () => {
  it("returns as soon as a page defers nothing", async () => {
    const result = await waitForDeferredSections(countingTab([{ total: 0, hydrated: 0 }]), {
      timeoutMs: 1_000,
      sleep: async () => {},
    });
    expect(result).toEqual({ total: 0, hydrated: 0 });
  });

  it("waits for the count to stop moving rather than for the first arrival", async () => {
    const result = await waitForDeferredSections(
      countingTab([
        { total: 7, hydrated: 0 },
        { total: 7, hydrated: 2 },
        { total: 7, hydrated: 5 },
        { total: 7, hydrated: 6 },
        { total: 7, hydrated: 6 },
        { total: 7, hydrated: 6 },
      ]),
      { timeoutMs: 1_000, pollMs: 1, sleep: async () => {} },
    );

    // 6 of 7, not 7 of 7: a part whose section the person has nothing in stays
    // empty however long anyone waits, which is why `total` is never the bar.
    expect(result).toEqual({ total: 7, hydrated: 6 });
  });

  it("gives up with the last measurement when nothing ever arrives", async () => {
    const result = await waitForDeferredSections(countingTab([{ total: 7, hydrated: 0 }]), {
      timeoutMs: 20,
      pollMs: 5,
      sleep: async () => {},
    });
    // The caller turns this into DEFERRED_SECTIONS_EMPTY rather than an ok receipt.
    expect(result).toEqual({ total: 7, hydrated: 0 });
  });

  it("survives a page that cannot be read at all", async () => {
    const result = await waitForDeferredSections(countingTab([null]), {
      timeoutMs: 20,
      pollMs: 5,
      sleep: async () => {},
    });
    expect(result).toBeNull();
  });
});

/** The page-script itself, run against a document stub — the selector and the
 *  emptiness rule are the two things that decide whether the measurement means
 *  anything, and neither is exercised by any other test. */
function evaluateProbe(nodes: { text: string }[]): unknown {
  const document = {
    querySelectorAll(selector: string) {
      // Pinned deliberately: only the outer container carries an `id`, so
      // selecting on `componentkey` instead would count every part twice.
      if (selector !== '[id^="profileCardsBelowActivity"]') return [];
      return nodes.map((n) => ({ textContent: n.text }));
    },
  };
  return new Function("document", `return ${DEFERRED_SECTIONS_EXPRESSION}`)(document);
}

describe("DEFERRED_SECTIONS_EXPRESSION", () => {
  it("counts a whitespace-only container as unfilled", () => {
    expect(evaluateProbe([{ text: "  \n " }, { text: "" }])).toEqual({ total: 2, hydrated: 0 });
  });

  it("counts the ones that arrived", () => {
    expect(
      evaluateProbe([{ text: "Experience" }, { text: "Education" }, { text: "" }]),
    ).toEqual({ total: 3, hydrated: 2 });
  });

  it("reports zero on a page with no deferred containers", () => {
    expect(evaluateProbe([])).toEqual({ total: 0, hydrated: 0 });
  });
});
