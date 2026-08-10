import { describe, expect, it } from "vitest";
import {
  VIEWPORT_EXPRESSION,
  readLikeAHuman,
  scrollerSelectionJs,
  viewportExpression,
} from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab, Viewport } from "../src/capabilities/profile.capture/read.js";

type Dispatched = { x: number; y: number; deltaY: number };

function fakeCursor(): ReadCursor & { moves: Dispatched[] } {
  const moves: Dispatched[] = [];
  return {
    moves,
    async wheel(x, y, deltaY) {
      moves.push({ x, y, deltaY });
      return { requested: deltaY, scrolled: deltaY, notches: 1 };
    },
    async pause() { return 0; },
  };
}

function fakeTab(viewport: unknown): ReadTab & { expressions: string[] } {
  const expressions: string[] = [];
  return {
    expressions,
    async evaluate<T>(expression: string): Promise<T> {
      expressions.push(expression);
      return viewport as T;
    },
  };
}

/**
 * A messaging-shaped page: the conversation rail on the left is taller than
 * the message pane on the right, which is what made "tallest wins" pick the
 * wrong box on the 2026-08-10 live run.
 */
function messagingViewport(o: { matched?: string | null } = {}): Viewport {
  return {
    width: 2000,
    height: 1100,
    scrollHeight: 1796,
    innerScroller: true,
    scrollerHeight: 626,
    documentScrollHeight: 1100,
    scroller: {
      tag: "div",
      id: null,
      role: null,
      componentkey: null,
      scrollHeight: 1796,
      clientHeight: 626,
      rect: { x: 620, y: 260, width: 680, height: 520 },
      matchedSelector: o.matched === undefined ? ".msg-s-message-list-container" : o.matched,
    },
  };
}

const noSleep = async () => {};

describe("scroller preference (D298)", () => {
  it("embeds the preferred selectors ahead of the tallest-element rule", () => {
    const js = scrollerSelectionJs([".msg-s-message-list-container"]);
    expect(js).toContain(".msg-s-message-list-container");
    // The fallback must still be there: a page where the selector is absent is
    // measured exactly as it was before.
    expect(js).toContain("els[i].scrollHeight > best.scrollHeight");
    // The preference pass runs before the fallback scan.
    expect(js.indexOf("prefer[p]")).toBeLessThan(js.indexOf("els[i].scrollHeight > best.scrollHeight"));
  });

  it("is byte-identical to the old expression when nothing is preferred", () => {
    expect(viewportExpression()).toBe(VIEWPORT_EXPRESSION);
    expect(viewportExpression([])).toBe(VIEWPORT_EXPRESSION);
  });

  it("asks the page the preferred question, not the default one", async () => {
    const tab = fakeTab(messagingViewport());
    await readLikeAHuman({
      tab,
      cursor: fakeCursor(),
      passes: 1,
      preferScroller: [".msg-s-message-list-container"],
      rng: () => 0.5,
      sleep: noSleep,
    });
    expect(tab.expressions.every((e) => e.includes(".msg-s-message-list-container"))).toBe(true);
    expect(tab.expressions).not.toContain(VIEWPORT_EXPRESSION);
  });
});

describe("wheel placement", () => {
  it("aims inside the chosen scroller, not at a viewport fraction", async () => {
    const viewport = messagingViewport();
    const cursor = fakeCursor();
    await readLikeAHuman({
      tab: fakeTab(viewport),
      cursor,
      passes: 3,
      preferScroller: [".msg-s-message-list-container"],
      rng: () => 0.5,
      sleep: noSleep,
    });

    const rect = viewport.scroller!.rect!;
    expect(cursor.moves.length).toBeGreaterThan(0);
    for (const move of cursor.moves) {
      expect(move.x).toBeGreaterThanOrEqual(rect.x);
      expect(move.x).toBeLessThanOrEqual(rect.x + rect.width);
      expect(move.y).toBeGreaterThanOrEqual(rect.y);
      expect(move.y).toBeLessThanOrEqual(rect.y + rect.height);
    }
  });

  it("puts the pointer on the pane where the old placement missed it", async () => {
    // At the bottom of the pointer range the old rule put x at 0.3 x 2000 =
    // 600px, which is left of the message pane and therefore on the
    // conversation rail. This is the live 2026-08-10 failure in one number.
    const viewport = messagingViewport();
    const rect = viewport.scroller!.rect!;
    const oldStyleX = Math.round(viewport.width * 0.3);
    expect(oldStyleX).toBeLessThan(rect.x);

    const cursor = fakeCursor();
    await readLikeAHuman({
      tab: fakeTab(viewport),
      cursor,
      passes: 1,
      preferScroller: [".msg-s-message-list-container"],
      rng: () => 0,
      sleep: noSleep,
    });
    expect(cursor.moves[0]!.x).toBeGreaterThanOrEqual(rect.x);
  });

  it("falls back to the viewport fraction when the scroller has no rect", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({
      tab: fakeTab({
        width: 1440,
        height: 900,
        scrollHeight: 9000,
        innerScroller: false,
        scrollerHeight: 900,
        documentScrollHeight: 9000,
      }),
      cursor,
      passes: 2,
      rng: () => 0.5,
      sleep: noSleep,
    });
    for (const move of cursor.moves) {
      expect(move.x).toBe(Math.round(1440 * 0.5));
      expect(move.y).toBe(Math.round(900 * 0.5));
    }
  });

  it("ignores a rect too small to aim at", async () => {
    const cursor = fakeCursor();
    await readLikeAHuman({
      tab: fakeTab({
        width: 1440,
        height: 900,
        scrollHeight: 9000,
        innerScroller: true,
        scrollerHeight: 900,
        documentScrollHeight: 900,
        scroller: {
          tag: "div", id: null, role: null, componentkey: null,
          scrollHeight: 9000, clientHeight: 900,
          rect: { x: 0, y: 0, width: 10, height: 10 },
          matchedSelector: null,
        },
      }),
      cursor,
      passes: 1,
      rng: () => 0.5,
      sleep: noSleep,
    });
    expect(cursor.moves[0]!.x).toBe(Math.round(1440 * 0.5));
  });
});
