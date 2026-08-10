import { describe, expect, it } from "vitest";
import {
  MAX_SCROLLER_CANDIDATES, VIEWPORT_EXPRESSION, readLikeAHuman, waitForLayout,
} from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab } from "../src/capabilities/profile.capture/read.js";
import {
  DWELL_MS_MAX,
  FALLBACK_VIEWPORT,
  LAYOUT_STABLE_READS,
  SCROLL_PASSES_MAX,
  SCROLL_PASSES_MIN,
} from "../src/capabilities/profile.capture/constants.js";
import type { HumanCursor } from "../src/core/input/cursor.js";
import type { WorkerTab } from "../src/core/session/tab.js";

/** Compile-time: the real tab and the real cursor satisfy what this module asks
 *  for. Task 15 is the first place `WorkerTab` and `HumanCursor` are consumed
 *  together outside the runner, which is exactly where a mismatch would hide
 *  until the live run. Verified to fail when either member is renamed. */
const _tabComposes: ReadTab = null as unknown as WorkerTab;
const _cursorComposes: ReadCursor = null as unknown as HumanCursor;
void [_tabComposes, _cursorComposes];

type Dispatched = { x: number; y: number; deltaY: number };

function fakeCursor(): ReadCursor & { moves: Dispatched[]; pauses: number[] } {
  const moves: Dispatched[] = [];
  const pauses: number[] = [];
  return {
    moves,
    pauses,
    async wheel(x, y, deltaY) {
      moves.push({ x, y, deltaY });
      // Matches the real cursor: notches sum exactly to the request.
      return { requested: deltaY, scrolled: deltaY, notches: Math.max(1, Math.round(Math.abs(deltaY) / 80)) };
    },
    async pause(min = 0, max = 0) {
      const ms = Math.round((min + max) / 2);
      pauses.push(ms);
      return ms;
    },
  };
}

/** Answers a fixed viewport, or walks a scripted sequence of them — one per
 *  poll — so a page that lays out late can be staged exactly. */
function fakeTab(viewport: unknown, sequence?: unknown[]): ReadTab & { expressions: string[] } {
  const expressions: string[] = [];
  let i = 0;
  return {
    expressions,
    async evaluate<T>(expression: string): Promise<T> {
      expressions.push(expression);
      const answer = sequence ? (sequence[Math.min(i++, sequence.length - 1)] ?? viewport) : viewport;
      if (answer instanceof Error) throw answer;
      return answer as T;
    },
  };
}

/** Layout already settled, for the tests that are about scrolling, not waiting. */
const SETTLED = (v: ReturnType<typeof vp> | null) => ({
  viewport: v, settled: v !== null, polls: 1, waitedMs: 0,
});

const noSleep = async () => {};

/** An ordinary page: the document scrolls. */
function vp(scrollHeight: number, o: { innerScroller?: boolean; scrollerHeight?: number } = {}) {
  const height = 900;
  return {
    width: 1440,
    height,
    scrollHeight,
    innerScroller: o.innerScroller ?? false,
    scrollerHeight: o.scrollerHeight ?? height,
    documentScrollHeight: o.innerScroller ? height : scrollHeight,
  };
}

const VIEWPORT = vp(9000);

describe("readLikeAHuman", () => {
  it("measures the page with the viewport read and nothing else", async () => {
    const tab = fakeTab(VIEWPORT);
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab, cursor, passes: 2, rng: () => 0.5, sleep: noSleep });

    // Every DOM read this module makes is the one navigation-support probe (D1).
    expect(new Set(tab.expressions)).toEqual(new Set([VIEWPORT_EXPRESSION]));
    expect(result.viewport).toEqual(VIEWPORT);
    expect(result.layout.settled).toBe(true);
  });

  it("scrolls in several passes rather than one jump", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 4, rng: () => 0.5, layout: SETTLED(VIEWPORT) });

    expect(result.passes).toBe(4);
    expect(cursor.moves).toHaveLength(4);
    // Each pass is on the order of one viewport, never the whole document.
    for (const move of cursor.moves) {
      expect(Math.abs(move.deltaY)).toBeLessThanOrEqual(VIEWPORT.height * 1.15 + 1);
    }
  });

  it("pauses between every pass and dwells at the end", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5, layout: SETTLED(VIEWPORT) });
    // Three inter-pass pauses plus the closing dwell.
    expect(cursor.pauses).toHaveLength(4);
    expect(cursor.pauses.at(-1)!).toBeLessThanOrEqual(DWELL_MS_MAX);
  });

  it("dwells even when nothing is scrolled", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 0, rng: () => 0.5, layout: SETTLED(VIEWPORT) });
    expect(result.passes).toBe(0);
    expect(cursor.moves).toEqual([]);
    expect(cursor.pauses).toHaveLength(1);
    expect(result.pausedMs).toBeGreaterThan(0);
  });

  it("stops at the bottom instead of wheeling into nothing", async () => {
    // A page barely taller than the viewport: one short pass and then done, no
    // matter how many passes were asked for.
    const cursor = fakeCursor();
    const short = vp(1100);
    const result = await readLikeAHuman({ tab: fakeTab(short), cursor, passes: 6, rng: () => 0.5, layout: SETTLED(short) });

    expect(result.passes).toBe(1);
    expect(result.scrolled).toBe(200); // scrollHeight - visible height, exactly
  });

  it("never scrolls back further than it has come", async () => {
    const cursor = fakeCursor();
    // rng low enough to trigger the back-scroll branch on every eligible pass.
    let calls = 0;
    const rng = () => {
      calls++;
      // `chance(p)` is rng() < p — 0.01 always takes the back branch.
      return calls % 4 === 3 ? 0.01 : 0.5;
    };
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 5, rng, layout: SETTLED(VIEWPORT) });

    let position = 0;
    for (const move of cursor.moves) {
      position += move.deltaY;
      expect(position).toBeGreaterThanOrEqual(0);
    }
  });

  it("falls back to a default viewport rather than abandoning a spent page load", async () => {
    for (const broken of [new Error("execution context destroyed"), null, { width: 0, height: 0 }]) {
      const cursor = fakeCursor();
      const result = await readLikeAHuman({
        tab: fakeTab(broken), cursor, passes: 2, rng: () => 0.5,
        layoutTimeoutMs: 5, sleep: noSleep,
      });
      expect(result.viewport).toBeNull();
      expect(cursor.moves).toHaveLength(2);
      // The fallback viewport is what sized the pass.
      expect(Math.abs(cursor.moves[0]!.deltaY)).toBeLessThanOrEqual(FALLBACK_VIEWPORT.height * 1.15 + 1);
    }
  });

  it("chooses its own pass count inside the band when none is given", async () => {
    for (const r of [0, 0.5, 0.999]) {
      const cursor = fakeCursor();
      const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, rng: () => r, layout: SETTLED(VIEWPORT) });
      expect(result.passes).toBeGreaterThanOrEqual(SCROLL_PASSES_MIN);
      expect(result.passes).toBeLessThanOrEqual(SCROLL_PASSES_MAX);
    }
  });

  it("puts the pointer inside the viewport, not at the origin", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5, layout: SETTLED(VIEWPORT) });
    for (const move of cursor.moves) {
      expect(move.x).toBeGreaterThan(0);
      expect(move.x).toBeLessThan(VIEWPORT.width);
      expect(move.y).toBeGreaterThan(0);
      expect(move.y).toBeLessThan(VIEWPORT.height);
    }
  });

  it("reports notches and pixels from what the cursor actually dispatched", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5, layout: SETTLED(VIEWPORT) });
    const expected = cursor.moves.reduce((sum, m) => sum + Math.abs(m.deltaY), 0);
    expect(result.scrolled).toBe(expected);
    expect(result.notches).toBeGreaterThan(0);
  });
});

describe("waitForLayout — the regression from the first live capture", () => {
  it("waits past an empty shell that measures exactly one viewport tall", async () => {
    // Verbatim from run 01KZH9VVPKB5JEVEBW7G2JJ6F3: LinkedIn answered
    // readyState complete with scrollHeight === innerHeight === 798, so the old
    // single-measurement read scrolled nothing and the capture came back holding
    // the profile's urn and none of its content.
    const shell = { width: 1333, height: 798, scrollHeight: 798, innerScroller: false, scrollerHeight: 798, documentScrollHeight: 798 };
    const laidOut = { width: 1333, height: 798, scrollHeight: 6400, innerScroller: true, scrollerHeight: 746, documentScrollHeight: 798 };
    const tab = fakeTab(laidOut, [shell, shell, laidOut, laidOut, laidOut]);

    const layout = await waitForLayout(tab, { pollMs: 0, sleep: noSleep });

    expect(layout.settled).toBe(true);
    expect(layout.viewport).toEqual(laidOut);
    expect(layout.polls).toBeGreaterThan(2);
  });

  it("does not settle while the document is still growing", async () => {
    const at = (h: number) => ({
      width: 1000, height: 800, scrollHeight: h,
      innerScroller: true, scrollerHeight: 760, documentScrollHeight: 800,
    });
    const growing = [at(1200), at(2400), at(3600), at(3600), at(3600)];
    const layout = await waitForLayout(fakeTab(growing.at(-1), growing), { pollMs: 0, sleep: noSleep });
    expect(layout.settled).toBe(true);
    expect(layout.viewport!.scrollHeight).toBe(3600);
    // Tall from the very first read, but not settled until it stopped moving.
    expect(layout.polls).toBeGreaterThanOrEqual(3 + LAYOUT_STABLE_READS - 1);
  });

  it("reports not-settled rather than hanging when the page never grows", async () => {
    const shell = vp(900);
    const layout = await waitForLayout(fakeTab(shell), { timeoutMs: 5, pollMs: 1, sleep: noSleep });
    expect(layout.settled).toBe(false);
    expect(layout.viewport).toEqual(shell);
  });

  it("reports not-settled rather than throwing when the page cannot be read", async () => {
    const layout = await waitForLayout(fakeTab(new Error("context destroyed")), {
      timeoutMs: 5, pollMs: 1, sleep: noSleep,
    });
    expect(layout.settled).toBe(false);
    expect(layout.viewport).toBeNull();
  });

  it("is what readLikeAHuman uses when no layout is handed to it", async () => {
    const shell = vp(900);
    const laidOut = vp(6400, { innerScroller: true, scrollerHeight: 860 });
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: fakeTab(laidOut, [shell, laidOut, laidOut, laidOut]),
      cursor,
      passes: 3,
      rng: () => 0.5,
      sleep: noSleep,
    });

    expect(result.layout.settled).toBe(true);
    // The whole point: it scrolls, where the pre-fix version scrolled nothing.
    expect(result.passes).toBe(3);
    expect(cursor.moves.length).toBeGreaterThan(0);
  });

  it("still dwells, and says so, when the page never laid out", async () => {
    const shell = vp(900);
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: fakeTab(shell), cursor, passes: 4, rng: () => 0.5,
      layoutTimeoutMs: 5, sleep: noSleep,
    });

    expect(result.layout.settled).toBe(false);
    expect(result.passes).toBe(0);
    // The fact is on the result, which is what the receipt's warning reads.
    expect(cursor.pauses).toHaveLength(1);
  });
});

describe("readLikeAHuman — how far it got, versus how far it travelled", () => {
  /** A page that renders as it is read: each measurement is taller than the
   *  last. This is what an activity feed does, and what a profile page does not
   *  — which is why measuring the extent once survived until now. */
  function growingTab(heights: number[]): ReadTab & { expressions: string[] } {
    return fakeTab(vp(heights.at(-1)!), heights.map((h) => vp(h)));
  }

  it("the growing page settles at its first height, which is what makes the test bite", async () => {
    // Pinning the premise: if layout settled at 30,000 instead, measuring once
    // and measuring per pass would agree and the test above would prove nothing.
    const layout = await waitForLayout(growingTab([3_000, 3_000, 3_000, 12_000, 30_000]), {
      sleep: noSleep,
    });
    expect(layout.settled).toBe(true);
    expect(layout.viewport!.scrollHeight).toBe(3_000);
  });

  it("re-measures between passes, so a lazily-rendered feed is not capped at its first height", async () => {
    // Three reads at 3,000 so the layout *settles* there — that is the number
    // the old code took its budget from — and only then do the cards render.
    // Measured once, the budget is 2,100px and the reader stops dead there,
    // having never issued whatever request the rest of the feed would trigger.
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: growingTab([3_000, 3_000, 3_000, 12_000, 21_000, 30_000, 30_000]),
      cursor,
      passes: 4,
      rng: () => 0.99, // never a back-pass; the largest magnitude, ~1,030px
      sleep: noSleep,
    });

    expect(result.passes).toBe(4);
    expect(result.travelled).toBeGreaterThan(3_000 - 900);
    // And the extent it reports is the last one measured, not the settled one.
    expect(result.scrollable).toBe(30_000 - 900);
  });

  it("still stops at the bottom of a page that is not growing", async () => {
    const cursor = fakeCursor();
    const short = vp(1_400);
    const result = await readLikeAHuman({
      tab: fakeTab(short), cursor, passes: 6, rng: () => 0.99, sleep: noSleep,
    });
    // 1400 - 900 = 500px of travel available, and no more wheel after that.
    expect(result.travelled).toBe(500);
    expect(result.passes).toBeLessThan(6);
    expect(result.scrollable).toBe(500);
  });

  it("counts a back-pass as travel and not as progress", async () => {
    // The distinction the exhaustion check turns on. `rng` at 0.0 makes
    // `chance(0.25)` true, so every pass after the first goes back up.
    const cursor = fakeCursor();
    const tall = vp(50_000);
    const result = await readLikeAHuman({
      tab: fakeTab(tall), cursor, passes: 3, rng: () => 0, sleep: noSleep,
    });

    // Down, then up, then up-to-zero: travel keeps accumulating, position does not.
    expect(result.scrolled).toBeGreaterThan(result.travelled);
    expect(result.travelled).toBeGreaterThanOrEqual(0);
    // The whole bug: read as progress, this page looks further along than it is.
    expect(result.travelled).toBeLessThan(result.scrolled);
  });

  it("reports no extent at all when the page cannot be measured", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: fakeTab(null), cursor, passes: 2, rng: () => 0.5, sleep: noSleep, layout: SETTLED(null),
    });
    // Never Infinity on a receipt: the fallback is to keep scrolling, and to
    // say the extent is unknown rather than to invent one.
    expect(result.scrollable).toBeNull();
    expect(result.passes).toBe(2);
  });

  it("keeps the last good measurement when a re-measure fails mid-read", async () => {
    // A failed read means "not yet", never "the page is now zero tall" — which
    // would collapse the budget and end the read.
    const cursor = fakeCursor();
    const tab = fakeTab(vp(20_000), [vp(20_000), vp(20_000), null, vp(20_000), vp(20_000)]);
    const result = await readLikeAHuman({
      tab, cursor, passes: 3, rng: () => 0.99, sleep: noSleep,
    });
    expect(result.passes).toBe(3);
    expect(result.scrollable).toBe(20_000 - 900);
  });
});

describe("VIEWPORT_EXPRESSION, executed as real javascript", () => {
  /** Runs the expression the way Chrome does, against a stub page. The
   *  expression is a string, so nothing else in this repo type-checks it. */
  function evaluateAgainst(page: {
    innerWidth: number;
    innerHeight: number;
    documentScrollHeight: number;
    elements: Array<{
      clientHeight: number;
      scrollHeight: number;
      overflowY: string;
      /** Optional, so every assertion written before the descriptors existed
       *  still exercises the expression against an element that has none —
       *  which is also what a stripped-down DOM node looks like. */
      tagName?: string;
      attrs?: Record<string, string>;
    }>;
  }): unknown {
    const withAttrs = page.elements.map((el) => ({
      ...el,
      getAttribute: (name: string) => el.attrs?.[name] ?? null,
    }));
    const document = {
      documentElement: { scrollHeight: page.documentScrollHeight },
      querySelectorAll: () => withAttrs,
    };
    const getComputedStyle = (el: { overflowY: string }) => ({ overflowY: el.overflowY });
    const window = { innerWidth: page.innerWidth, innerHeight: page.innerHeight };
    return new Function(
      "document", "getComputedStyle", "window",
      `return (${VIEWPORT_EXPRESSION});`,
    )(document, getComputedStyle, window);
  }

  it("measures the inner scroller on a real LinkedIn profile, not the document", () => {
    // The exact numbers from probe run 01KZHAHJ7504QSV57YC5RBZEV3: the document
    // is pinned at one viewport with body{overflow:hidden} while main#workspace
    // holds 7348px of content. Measuring the document said "nothing to scroll"
    // on a page that was fully rendered.
    const measured = evaluateAgainst({
      innerWidth: 1333,
      innerHeight: 798,
      documentScrollHeight: 798,
      elements: [
        { clientHeight: 746, scrollHeight: 7348, overflowY: "scroll" }, // main#workspace
        { clientHeight: 210, scrollHeight: 1260, overflowY: "hidden" }, // a clamped <p>
        { clientHeight: 245, scrollHeight: 770, overflowY: "hidden" },
      ],
    }) as Record<string, unknown>;

    expect(measured["scrollHeight"]).toBe(7348);
    expect(measured["scrollerHeight"]).toBe(746);
    expect(measured["innerScroller"]).toBe(true);
    // The old measurement, kept only so a receipt can show why it was wrong.
    expect(measured["documentScrollHeight"]).toBe(798);
  });

  it("ignores overflow:hidden elements — clamped text is not a scroller", () => {
    const measured = evaluateAgainst({
      innerWidth: 1333, innerHeight: 798, documentScrollHeight: 798,
      elements: [{ clientHeight: 210, scrollHeight: 1260, overflowY: "hidden" }],
    }) as Record<string, unknown>;
    expect(measured["innerScroller"]).toBe(false);
    expect(measured["scrollHeight"]).toBe(798);
  });

  it("falls back to the document on an ordinary page that scrolls normally", () => {
    const measured = evaluateAgainst({
      innerWidth: 1280, innerHeight: 800, documentScrollHeight: 5200, elements: [],
    }) as Record<string, unknown>;
    expect(measured["innerScroller"]).toBe(false);
    expect(measured["scrollHeight"]).toBe(5200);
    expect(measured["scrollerHeight"]).toBe(800);
  });

  it("settles and scrolls on the LinkedIn shape, where the document measurement did not", async () => {
    const linkedin = {
      width: 1333, height: 798, scrollHeight: 7348,
      innerScroller: true, scrollerHeight: 746, documentScrollHeight: 798,
    };
    const cursor = fakeCursor();
    const result = await readLikeAHuman({
      tab: fakeTab(linkedin), cursor, passes: 4, rng: () => 0.5, sleep: noSleep,
    });

    expect(result.layout.settled).toBe(true);
    expect(result.passes).toBe(4);
    expect(result.scrolled).toBeGreaterThan(0);
    // Never further than the scroller actually has: 7348 - 746.
    expect(result.scrolled).toBeLessThanOrEqual(7348 - 746);
  });

  it("says which element it measured, not only how tall it was", () => {
    // A height alone cannot tell an operator which container it came from, so a
    // new surface could report a settled layout while scrolling the wrong box
    // (M4 CONTEXT rule 3). The descriptor is what makes the scroller a
    // measurement rather than an assumption.
    const measured = evaluateAgainst({
      innerWidth: 1333, innerHeight: 798, documentScrollHeight: 798,
      elements: [
        {
          clientHeight: 746, scrollHeight: 7348, overflowY: "scroll",
          tagName: "MAIN", attrs: { id: "workspace" },
        },
      ],
    }) as Record<string, unknown>;

    expect(measured["scroller"]).toEqual({
      tag: "main", id: "workspace", role: null, componentkey: null,
      scrollHeight: 7348, clientHeight: 746,
      // This double has no `getBoundingClientRect`, so the rect is honestly
      // absent rather than invented; `matchedSelector` is null because nothing
      // was preferred and the tallest-element rule chose it (D298).
      rect: null, matchedSelector: null,
    });
    expect(measured["scrollerCandidates"]).toBe(1);
  });

  it("describes an element that carries no attributes at all", () => {
    const measured = evaluateAgainst({
      innerWidth: 1333, innerHeight: 798, documentScrollHeight: 798,
      elements: [{ clientHeight: 746, scrollHeight: 7348, overflowY: "scroll" }],
    }) as Record<string, unknown>;
    expect(measured["scroller"]).toMatchObject({ tag: "", id: null, role: null });
  });

  it("describes every candidate, tallest first, so a second scroller is visible", () => {
    // The activity feed may be its own scroll container nested inside the
    // page's. Reporting only the tallest would hide that there were two.
    const measured = evaluateAgainst({
      innerWidth: 1333, innerHeight: 798, documentScrollHeight: 798,
      elements: [
        { clientHeight: 700, scrollHeight: 3000, overflowY: "auto", tagName: "DIV", attrs: { role: "feed" } },
        { clientHeight: 746, scrollHeight: 7348, overflowY: "scroll", tagName: "MAIN", attrs: { id: "workspace" } },
      ],
    }) as Record<string, unknown>;

    const scrollers = measured["scrollers"] as Array<Record<string, unknown>>;
    expect(scrollers.map((s) => s["scrollHeight"])).toEqual([7348, 3000]);
    expect(scrollers[1]!["role"]).toBe("feed");
    expect(measured["scroller"]).toMatchObject({ id: "workspace" });
  });

  it("bounds the candidate list and still reports the true total", () => {
    // Exceeded rather than assumed roomy: this rides on every receipt and the
    // page is not ours.
    const over = MAX_SCROLLER_CANDIDATES + 6;
    const measured = evaluateAgainst({
      innerWidth: 1333, innerHeight: 798, documentScrollHeight: 798,
      elements: Array.from({ length: over }, (_, i) => ({
        clientHeight: 300, scrollHeight: 1000 + i, overflowY: "auto", tagName: "DIV",
      })),
    }) as Record<string, unknown>;

    expect((measured["scrollers"] as unknown[]).length).toBe(MAX_SCROLLER_CANDIDATES);
    expect(measured["scrollerCandidates"]).toBe(over);
  });

  it("reports no scroller at all on a page that has none", () => {
    const measured = evaluateAgainst({
      innerWidth: 1280, innerHeight: 800, documentScrollHeight: 5200, elements: [],
    }) as Record<string, unknown>;
    expect(measured["scroller"]).toBeNull();
    expect(measured["scrollers"]).toEqual([]);
    expect(measured["scrollerCandidates"]).toBe(0);
  });
});
