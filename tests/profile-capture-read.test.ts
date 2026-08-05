import { describe, expect, it } from "vitest";
import { VIEWPORT_EXPRESSION, readLikeAHuman } from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab } from "../src/capabilities/profile.capture/read.js";
import {
  DWELL_MS_MAX,
  FALLBACK_VIEWPORT,
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

function fakeTab(viewport: unknown): ReadTab & { expressions: string[] } {
  const expressions: string[] = [];
  return {
    expressions,
    async evaluate<T>(expression: string): Promise<T> {
      expressions.push(expression);
      if (viewport instanceof Error) throw viewport;
      return viewport as T;
    },
  };
}

const VIEWPORT = { width: 1440, height: 900, scrollHeight: 9000 };

describe("readLikeAHuman", () => {
  it("measures the page with one round trip before scrolling", async () => {
    const tab = fakeTab(VIEWPORT);
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab, cursor, passes: 2, rng: () => 0.5 });

    expect(tab.expressions).toEqual([VIEWPORT_EXPRESSION]);
    expect(result.viewport).toEqual(VIEWPORT);
  });

  it("scrolls in several passes rather than one jump", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 4, rng: () => 0.5 });

    expect(result.passes).toBe(4);
    expect(cursor.moves).toHaveLength(4);
    // Each pass is on the order of one viewport, never the whole document.
    for (const move of cursor.moves) {
      expect(Math.abs(move.deltaY)).toBeLessThanOrEqual(VIEWPORT.height * 1.15 + 1);
    }
  });

  it("pauses between every pass and dwells at the end", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5 });
    // Three inter-pass pauses plus the closing dwell.
    expect(cursor.pauses).toHaveLength(4);
    expect(cursor.pauses.at(-1)!).toBeLessThanOrEqual(DWELL_MS_MAX);
  });

  it("dwells even when nothing is scrolled", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 0, rng: () => 0.5 });
    expect(result.passes).toBe(0);
    expect(cursor.moves).toEqual([]);
    expect(cursor.pauses).toHaveLength(1);
    expect(result.pausedMs).toBeGreaterThan(0);
  });

  it("stops at the bottom instead of wheeling into nothing", async () => {
    // A page barely taller than the viewport: one short pass and then done, no
    // matter how many passes were asked for.
    const cursor = fakeCursor();
    const short = { width: 1440, height: 900, scrollHeight: 1100 };
    const result = await readLikeAHuman({ tab: fakeTab(short), cursor, passes: 6, rng: () => 0.5 });

    expect(result.passes).toBe(1);
    expect(result.scrolled).toBe(200); // scrollHeight - height, exactly
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
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 5, rng });

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
      const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, rng: () => r });
      expect(result.passes).toBeGreaterThanOrEqual(SCROLL_PASSES_MIN);
      expect(result.passes).toBeLessThanOrEqual(SCROLL_PASSES_MAX);
    }
  });

  it("puts the pointer inside the viewport, not at the origin", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5 });
    for (const move of cursor.moves) {
      expect(move.x).toBeGreaterThan(0);
      expect(move.x).toBeLessThan(VIEWPORT.width);
      expect(move.y).toBeGreaterThan(0);
      expect(move.y).toBeLessThan(VIEWPORT.height);
    }
  });

  it("reports notches and pixels from what the cursor actually dispatched", async () => {
    const cursor = fakeCursor();
    const result = await readLikeAHuman({ tab: fakeTab(VIEWPORT), cursor, passes: 3, rng: () => 0.5 });
    const expected = cursor.moves.reduce((sum, m) => sum + Math.abs(m.deltaY), 0);
    expect(result.scrolled).toBe(expected);
    expect(result.notches).toBeGreaterThan(0);
  });
});
