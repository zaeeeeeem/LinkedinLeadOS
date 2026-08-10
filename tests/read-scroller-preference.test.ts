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

/**
 * A DOM double that honours the selector, unlike the one in
 * profile-capture-read.test.ts — the whole point here is *which* element a
 * selector picks, so a `querySelectorAll` that ignores its argument would
 * assert nothing.
 */
function evaluatePreference(
  prefer: readonly string[],
  elements: Array<{
    tagName: string;
    classes: string[];
    id?: string;
    clientHeight: number;
    scrollHeight: number;
    overflowY: string;
  }>,
): { id: string | null; matchedSelector: string | null } | null {
  const nodes = elements.map((el) => ({
    ...el,
    getAttribute: (name: string) => (name === "id" ? el.id ?? null : null),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: el.clientHeight }),
  }));
  const matches = (node: typeof nodes[number], selector: string): boolean => {
    const cls = selector.match(/^\.([\w-]+)$/);
    if (cls) return node.classes.includes(cls[1]!);
    const idPrefix = selector.match(/^(\w+)\[id\^=['"]([^'"]+)['"]\]$/);
    if (idPrefix) {
      return node.tagName.toLowerCase() === idPrefix[1]!.toLowerCase()
        && (node.id ?? "").startsWith(idPrefix[2]!);
    }
    throw new Error(`unsupported selector in this double: ${selector}`);
  };
  const document = {
    documentElement: { scrollHeight: 900 },
    querySelectorAll: (selector?: string) =>
      selector === undefined || selector === "*"
        ? nodes
        : nodes.filter((node) => matches(node, selector)),
  };
  const result = new Function(
    "document", "getComputedStyle", "window",
    `return (${viewportExpression(prefer)});`,
  )(
    document,
    (el: { overflowY: string }) => ({ overflowY: el.overflowY }),
    { innerWidth: 1440, innerHeight: 900 },
  ) as { scroller: { id: string | null; matchedSelector: string | null } | null } | null;
  return result?.scroller ?? null;
}

describe("the messaging pane, as the DOM actually nests it (D298)", () => {
  // Exactly the nesting archived in run 01KZNHBF6K79YR9G5WWVRDQ247: the
  // -container wrapper carries no overflow and the -content ul is inside the
  // element that does. Getting this level wrong is what the first attempt did.
  const messagingDom = [
    {
      tagName: "UL", classes: ["msg-conversations-container__conversations-list"],
      id: undefined, clientHeight: 626, scrollHeight: 1888, overflowY: "auto",
    },
    {
      tagName: "DIV", classes: ["msg-s-message-list-container"],
      id: undefined, clientHeight: 326, scrollHeight: 326, overflowY: "visible",
    },
    {
      tagName: "DIV", classes: ["msg-s-message-list", "scrollable"],
      id: "message-list-ember3", clientHeight: 326, scrollHeight: 2062, overflowY: "auto",
    },
    {
      tagName: "UL", classes: ["msg-s-message-list-content"],
      id: undefined, clientHeight: 2062, scrollHeight: 2062, overflowY: "visible",
    },
  ];

  it("picks the element that scrolls, not the wrapper around it", () => {
    const chosen = evaluatePreference(
      [".msg-s-message-list", "div[id^='message-list-']", ".msg-s-message-list-container"],
      messagingDom,
    );
    expect(chosen?.id).toBe("message-list-ember3");
    expect(chosen?.matchedSelector).toBe(".msg-s-message-list");
  });

  it("falls back to the id prefix when the class churns", () => {
    const chosen = evaluatePreference(
      [".msg-s-message-list-container", "div[id^='message-list-']"],
      messagingDom,
    );
    // The wrapper is named first but does not scroll, so it is skipped rather
    // than selected — a named-but-unscrollable element is not a match.
    expect(chosen?.id).toBe("message-list-ember3");
    expect(chosen?.matchedSelector).toBe("div[id^='message-list-']");
  });

  it("without a preference the rail wins, which is the bug D298 exists for", () => {
    const chosen = evaluatePreference([], messagingDom);
    // The rail is 1888 and the pane 2062 here, so tallest happens to be right.
    expect(chosen?.matchedSelector).toBeNull();
    // But shorten the thread and the rail takes it — the live one-message run.
    const shortThread = messagingDom.map((el) =>
      el.id === "message-list-ember3" ? { ...el, scrollHeight: 900 } : el);
    expect(evaluatePreference([], shortThread)?.id).toBeNull();
    expect(evaluatePreference([".msg-s-message-list"], shortThread)?.id).toBe("message-list-ember3");
  });
});
