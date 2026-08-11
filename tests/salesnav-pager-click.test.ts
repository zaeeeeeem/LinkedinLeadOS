import { describe, expect, it } from "vitest";
import {
  clickPagerControl, clickTrustedControl, controlRefusal, interpretControl, MAX_REVEAL_ATTEMPTS,
  PAGER_CONTROL_NAMES, pagerControlExpression, pagingFromCaptures, pagingOffsetOf,
  trustedControlExpression, trustedControlRefusal,
  type ControlLocation, type PagerDirection, type TrustedControlSpec,
} from "../src/capabilities/salesnav.probe/pager.js";
import { CapabilityError } from "../src/core/run/receipt.js";

/**
 * The one click this toolkit performs (D400). Every test here is a clause of
 * that grant: resolved-or-refused, disabled means stop, trusted click only, and
 * arrival read from the body rather than from the button.
 */

function location(over: Partial<ControlLocation> = {}): ControlLocation {
  return {
    matches: 1,
    name: "Next",
    tag: "button",
    disabled: false,
    x: 600,
    y: 400,
    width: 40,
    height: 40,
    inView: true,
    obscured: false,
    viewportWidth: 1280,
    viewportHeight: 800,
    scrollerX: 640,
    scrollerY: 400,
    ...over,
  };
}

const savedSearchesControl: TrustedControlSpec = {
  selector: "button[data-x--link--saved-searches]",
  accessibleName: /^saved searches$/i,
  label: "saved searches",
  codePrefix: "SAVED_SEARCHES_CONTROL",
  decision: "D408",
};

describe("trusted control generalization — the D408 control stays exact", () => {
  it("carries the measured selector and anchored accessible name into one read", () => {
    const js = trustedControlExpression(savedSearchesControl);
    expect(js).toContain("button[data-x--link--saved-searches]");
    expect(js).toContain("^saved searches$");
    expect(js).toContain("elementFromPoint");
    expect(js).not.toContain(".click()");
    expect(js).not.toContain("scrollIntoView");
  });

  it("uses its own refusal family and never falls through to another button", () => {
    expect(trustedControlRefusal(location({ matches: 0 }), savedSearchesControl)?.code)
      .toBe("SAVED_SEARCHES_CONTROL_NOT_FOUND");
    expect(trustedControlRefusal(location({ matches: 2 }), savedSearchesControl)?.code)
      .toBe("SAVED_SEARCHES_CONTROL_AMBIGUOUS");
  });

  it("clicks exactly once only after the generic resolver returns one enabled hit", async () => {
    const cursor = cursorOf();
    const report = await clickTrustedControl({
      tab: tabOf({ name: "Saved searches" }), cursor, spec: savedSearchesControl,
    });
    expect(cursor.clicks).toEqual([{ x: 600, y: 400 }]);
    expect(report).toMatchObject({ kind: "saved searches", control: "Saved searches", revealPasses: 0 });
  });

  it("clicks nothing for every resolved-or-refused failure", async () => {
    for (const bad of [{ matches: 0 }, { matches: 2 }, { disabled: true }, { width: 0 }]) {
      const cursor = cursorOf();
      await expect(clickTrustedControl({ tab: tabOf(bad), cursor, spec: savedSearchesControl }))
        .rejects.toBeInstanceOf(CapabilityError);
      expect(cursor.clicks).toEqual([]);
    }
  });
});

describe("PAGER_CONTROL_NAMES — anchored, because a loose match is an unapproved click", () => {
  const matches = (d: PagerDirection, name: string): boolean => PAGER_CONTROL_NAMES[d].test(name);

  it("matches the control's own names", () => {
    expect(matches("next", "Next")).toBe(true);
    expect(matches("next", "next page")).toBe(true);
    expect(matches("prev", "Previous")).toBe(true);
  });

  // "next" as a substring also matches "View next lead" — a lead panel, which
  // is not granted and is not a pagination control.
  it("does not match a phrase that merely contains the word", () => {
    expect(matches("next", "View next lead")).toBe(false);
    expect(matches("next", "Next steps")).toBe(false);
    expect(matches("prev", "Preview")).toBe(false);
  });
});

describe("pagerControlExpression", () => {
  it("is one round trip and carries the pager selectors and the margin", () => {
    const js = pagerControlExpression("next");
    expect(js).toContain("artdeco-pagination");
    // The hit test, not a margin: the first live run refused a control that was
    // plainly visible at the bottom of a scrolled-to-the-end list.
    expect(js).toContain("elementFromPoint");
    // Never a synthetic DOM click, in the page or out of it.
    expect(js).not.toContain(".click()");
    expect(js).not.toContain("scrollIntoView");
  });

  it("asks for the direction it was given", () => {
    expect(pagerControlExpression("prev")).toContain("previous");
  });
});

describe("interpretControl — bounds enforced on the way in", () => {
  it("returns null for anything that is not an object", () => {
    expect(interpretControl(null)).toBeNull();
    expect(interpretControl("Next")).toBeNull();
  });

  it("clamps the control's name and tag", () => {
    const long = interpretControl({ matches: 1, name: "n".repeat(500), tag: "b".repeat(90) })!;
    expect(long.name!.length).toBeLessThanOrEqual(120);
    expect(long.tag!.length).toBeLessThanOrEqual(32);
  });

  it("coerces nonsense coordinates to zero rather than trusting them", () => {
    const bad = interpretControl({ matches: 1, x: "600", y: Number.NaN, width: Infinity })!;
    expect(bad.x).toBe(0);
    expect(bad.y).toBe(0);
    expect(bad.width).toBe(0);
  });

  it("treats every boolean as false unless the page said exactly true", () => {
    const v = interpretControl({ matches: 1, disabled: "true", inView: 1, obscured: "yes" })!;
    expect(v.disabled).toBe(false);
    expect(v.inView).toBe(false);
    expect(v.obscured).toBe(false);
  });
});

describe("controlRefusal — resolved or refused, never guessed", () => {
  const code = (l: ControlLocation | null): string | null => controlRefusal(l, "next")?.code ?? null;

  it("passes a single enabled, rendered control", () => {
    expect(code(location())).toBeNull();
  });

  it("refuses an unreadable page", () => {
    expect(code(null)).toBe("PAGER_UNREADABLE");
  });

  it("refuses when nothing matched — it does not fall back to another element", () => {
    expect(code(location({ matches: 0 }))).toBe("PAGER_CONTROL_NOT_FOUND");
  });

  // The clause that matters most: two candidates is a refusal, not a pick.
  it("refuses when more than one control matched", () => {
    expect(code(location({ matches: 2 }))).toBe("PAGER_CONTROL_AMBIGUOUS");
  });

  it("refuses a disabled control, because the page it would reach does not exist", () => {
    expect(code(location({ disabled: true }))).toBe("PAGER_CONTROL_DISABLED");
  });

  it("refuses a control with no box on screen", () => {
    expect(code(location({ width: 0 }))).toBe("PAGER_CONTROL_NOT_RENDERED");
  });

  it("every refusal halts and notifies rather than retrying", () => {
    const e = controlRefusal(location({ matches: 0 }), "next")!;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("HALT_AND_NOTIFY");
  });
});

/** A tab that answers with a scripted sequence of locations. */
function tabOf(...answers: Array<Partial<ControlLocation> | null>) {
  let i = 0;
  return {
    calls: () => i,
    evaluate: async <T,>(): Promise<T> => {
      const answer = answers[Math.min(i, answers.length - 1)];
      i++;
      return (answer === null ? null : location(answer)) as T;
    },
  };
}

function cursorOf() {
  const clicks: Array<{ x: number; y: number }> = [];
  const wheels: Array<{ x: number; y: number; deltaY: number }> = [];
  return {
    clicks,
    wheels,
    click: async (x: number, y: number) => { clicks.push({ x, y }); return { x, y }; },
    wheel: async (x: number, y: number, deltaY: number) => { wheels.push({ x, y, deltaY }); },
    pause: async () => 0,
  };
}

describe("clickPagerControl", () => {
  it("clicks the control's centre when it is already in view", async () => {
    const cursor = cursorOf();
    const report = await clickPagerControl({ tab: tabOf({}), cursor, direction: "next" });
    expect(cursor.clicks).toEqual([{ x: 600, y: 400 }]);
    expect(cursor.wheels).toEqual([]);
    expect(report.control).toBe("Next");
    expect(report.revealPasses).toBe(0);
  });

  // Wheel, never `scrollIntoView` (§8) — and aimed inside the box that actually
  // scrolls, because a wheel outside it scrolls the wrong content (D298).
  it("wheels the control into view, aiming inside the scroller", async () => {
    const cursor = cursorOf();
    const tab = tabOf({ inView: false, y: 1400 }, { inView: true, y: 400 });
    const report = await clickPagerControl({ tab, cursor, direction: "next" });
    expect(cursor.wheels).toHaveLength(1);
    expect(cursor.wheels[0]!.x).toBe(640);
    expect(cursor.wheels[0]!.deltaY).toBe(1000);
    expect(report.revealPasses).toBe(1);
    expect(cursor.clicks).toHaveLength(1);
  });

  // A click at coordinates the pointer cannot reach is a click on whatever is
  // there instead — which is exactly what the grant forbids.
  it("refuses rather than clicking a control it could not bring into view", async () => {
    const cursor = cursorOf();
    const tab = tabOf({ inView: false, y: 1400 });
    await expect(clickPagerControl({ tab, cursor, direction: "next" }))
      .rejects.toMatchObject({ code: "PAGER_CONTROL_OFFSCREEN" });
    expect(cursor.clicks).toEqual([]);
    expect(cursor.wheels.length).toBeLessThanOrEqual(MAX_REVEAL_ATTEMPTS);
  });

  it("clicks nothing when the control is ambiguous, disabled or absent", async () => {
    for (const bad of [{ matches: 2 }, { disabled: true }, { matches: 0 }]) {
      const cursor = cursorOf();
      await expect(clickPagerControl({ tab: tabOf(bad), cursor, direction: "next" })).rejects.toThrow();
      expect(cursor.clicks).toEqual([]);
    }
  });

  // The defect the first live run found. The pager lives at the bottom of
  // `div#search-results-container`, which the page read has already scrolled to
  // the end of, so the control rests near the viewport's bottom edge and
  // nothing can move it. A margin rule refuses there — on the page's normal
  // resting state — and the hit test does not.
  it("clicks a control resting at the bottom edge that no scroll can move", async () => {
    const cursor = cursorOf();
    // Two passes that change nothing: the scroller is already at its end.
    const tab = tabOf({ inView: true, y: 780, viewportHeight: 800 });
    const report = await clickPagerControl({ tab, cursor, direction: "next" });
    expect(cursor.clicks).toEqual([{ x: 600, y: 780 }]);
    expect(report.revealPasses).toBe(0);
  });

  it("gives up wheeling once a pass stops moving the control", async () => {
    const cursor = cursorOf();
    // Off-screen and immovable: every read returns the same y.
    const tab = tabOf({ inView: false, y: 1400 });
    await expect(clickPagerControl({ tab, cursor, direction: "next" }))
      .rejects.toMatchObject({ code: "PAGER_CONTROL_OFFSCREEN" });
    // One pass, not three: the second read showed no progress.
    expect(cursor.wheels).toHaveLength(1);
  });

  // On screen and unreachable is a different failure from off screen, because
  // scrolling does not fix it — and clicking anyway would press the overlay.
  it("refuses a control whose own pixel belongs to an overlay", async () => {
    const cursor = cursorOf();
    const tab = tabOf({ inView: false, obscured: true });
    await expect(clickPagerControl({ tab, cursor, direction: "next" }))
      .rejects.toMatchObject({ code: "PAGER_CONTROL_OBSCURED" });
    expect(cursor.clicks).toEqual([]);
    expect(cursor.wheels).toEqual([]);
  });

  // A control that becomes ambiguous while being revealed must not be clicked
  // on the strength of the first reading.
  it("re-checks the refusal after every reveal pass", async () => {
    const cursor = cursorOf();
    const tab = tabOf({ inView: false, y: 1400 }, { matches: 3, inView: true });
    await expect(clickPagerControl({ tab, cursor, direction: "next" }))
      .rejects.toMatchObject({ code: "PAGER_CONTROL_AMBIGUOUS" });
    expect(cursor.clicks).toEqual([]);
  });
});

describe("pagingOffsetOf — the arrival check reads two integers and nothing else", () => {
  it("reads start and count out of a paging block", () => {
    expect(pagingOffsetOf('{"paging":{"start":25,"count":25,"total":2500},"elements":[]}'))
      .toEqual({ start: 25, count: 25 });
  });

  it("returns null when there is no paging block, or it is incomplete", () => {
    expect(pagingOffsetOf('{"elements":[]}')).toBeNull();
    expect(pagingOffsetOf('{"paging":{"count":25}}')).toBeNull();
    expect(pagingOffsetOf("not json at all")).toBeNull();
  });
});

describe("pagingFromCaptures — the search endpoint by name, not by size", () => {
  const body = (start: number, count = 25): string => `{"paging":{"start":${start},"count":${count}}}`;

  it("reads the named search body", () => {
    const captures = [
      { body: body(0), bytes: 2_000, patterns: ["sales-api-any"] },
      { body: body(25), bytes: 150_000, patterns: ["salesapi-lead-search"] },
    ];
    expect(pagingFromCaptures(captures, "document-leads2")).toEqual({ start: 25, count: 25, from: "search-body" });
  });

  // The live defect, pinned. On /sales/search/company the largest body is
  // salesApiSearchFilterLayout (81 KB) and it carries a paging block of its own;
  // the account search is 53 KB. Size-first read `count 10` for a page of 25.
  it("does not let a larger non-search body win", () => {
    const captures = [
      { body: body(0, 10), bytes: 81_620, patterns: ["sales-api-any", "linkedin-data"] },
      { body: body(0, 25), bytes: 53_689, patterns: ["salesapi-account-search", "sales-api-any"] },
    ];
    expect(pagingFromCaptures(captures, "document-accounts"))
      .toEqual({ start: 0, count: 25, from: "search-body" });
  });

  // A fallback that presented itself as the search's own offset would be a
  // coincidence wearing evidence's clothes.
  it("falls back to the largest body and says the evidence is indirect", () => {
    const captures = [{ body: body(0, 20), bytes: 8_813, patterns: ["sales-api-any"] }];
    expect(pagingFromCaptures(captures, "document-leads2"))
      .toEqual({ start: 0, count: 20, from: "largest-body" });
  });

  // A server-rendered document must not be able to answer "which page arrived".
  it("ignores the surface's own document response", () => {
    const captures = [{ body: body(0), bytes: 900_000, patterns: ["document-leads2", "linkedin-data"] }];
    expect(pagingFromCaptures(captures, "document-leads2")).toBeNull();
  });

  it("returns null when nothing carried a paging block", () => {
    expect(pagingFromCaptures([{ body: "{}", bytes: 10, patterns: [] }], "document-leads2")).toBeNull();
  });
});
