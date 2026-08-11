import { describe, expect, it } from "vitest";
import {
  emptySurface, interpretSurface, MAX_LIST_CANDIDATES, MAX_NAMESPACES, paginationVerdict,
  PAYLOAD_GLOBALS, surfaceExpression, type PagerReport,
} from "../src/capabilities/salesnav.probe/surface.js";
import { MAX_ATTRIBUTE_CHARS, MAX_PAGER_CONTROLS, MAX_ROW_ATTRIBUTES } from "../src/capabilities/salesnav.probe/constants.js";
import { isSalesNavIsh, looksLikeUpsell } from "../src/capabilities/salesnav.probe/patterns.js";

const pager = (over: Partial<PagerReport> = {}): PagerReport => ({
  present: true, testId: null, controls: [], anchors: 0, hrefsWithPageParam: 0,
  hrefPages: [], page: null, totalPages: null, urlHasPageParam: false, ...over,
});

describe("surfaceExpression", () => {
  it("is a self-contained expression that never throws out", () => {
    const js = surfaceExpression();
    expect(js.startsWith("(() => {")).toBe(true);
    expect(js).toContain("catch (e) { return null; }");
  });

  // The receipt goes to stdout and search results are third-party people
  // (M5 CONTEXT rule 6). The expression may read hrefs but must never return
  // one — it carries the operator's whole filter blob and the lead's id.
  it("never returns a raw href or any row text", () => {
    const js = surfaceExpression();
    expect(js).toContain("pagerReport.hrefsWithPageParam++");
    expect(js).not.toMatch(/hrefs\.push\(href\)/);
    expect(js).not.toContain("innerText");
    expect(js).not.toContain("textContent || ''; return");
  });

  it("asks about only the globals this build declared", () => {
    expect(surfaceExpression()).toContain(JSON.stringify(PAYLOAD_GLOBALS));
  });
});

describe("interpretSurface", () => {
  it("returns null for anything that is not an object", () => {
    for (const raw of [null, undefined, 42, "x", true]) expect(interpretSurface(raw)).toBeNull();
  });

  it("fills every field from an empty object rather than throwing", () => {
    const r = interpretSurface({})!;
    expect(r.seat).toEqual({ appShell: false, upsell: false, redirectedOffSales: false });
    expect(r.rows.lists).toEqual([]);
    expect(r.pager.present).toBe(false);
    expect(r.scroller.isDocument).toBe(true);
  });

  it("reads a healthy leads page", () => {
    const r = interpretSurface({
      url: "https://www.linkedin.com/sales/search/people?page=1",
      seat: { appShell: true, upsell: false, redirectedOffSales: false },
      scroller: { tag: "DIV", id: "search-results", scrollHeight: 9000, clientHeight: 800 },
      rows: {
        leadLinks: 25,
        accountLinks: 0,
        lists: [{ tag: "ol", id: null, testId: "results", items: 25, rows: 25 }],
        anonymizeFields: [{ name: "person-name", n: 25 }, { name: "title", n: 24 }],
        testIds: [{ name: "lead-name", n: 25 }],
      },
      pager: { present: true, anchors: 9, hrefsWithPageParam: 9, hrefPages: [2, 3, 4], page: 1, totalPages: 100 },
      componentKeys: 12,
    })!;
    expect(r.rows.leadLinks).toBe(25);
    expect(r.rows.anonymizeFields[0]).toEqual({ name: "person-name", n: 25 });
    expect(r.pager.totalPages).toBe(100);
    expect(r.pager.hrefPages).toEqual([2, 3, 4]);
    // Derived from the tag, never taken from the page.
    expect(r.scroller.isDocument).toBe(false);
    expect(r.scroller.tag).toBe("DIV");
  });

  // The page decides what comes back and the receipt goes to stdout. Every
  // bound below is enforced here rather than trusted to a page we do not own.
  describe("bounds a hostile page", () => {
    it("clamps a long attribute name", () => {
      const r = interpretSurface({ rows: { anonymizeFields: [{ name: "x".repeat(9999), n: 1 }] } })!;
      expect(r.rows.anonymizeFields[0]!.name.length).toBeLessThanOrEqual(MAX_ATTRIBUTE_CHARS + 1);
    });

    it("caps the number of row attributes", () => {
      const many = Array.from({ length: 500 }, (_, i) => ({ name: `f${i}`, n: 1 }));
      const r = interpretSurface({ rows: { anonymizeFields: many, testIds: many } })!;
      expect(r.rows.anonymizeFields.length).toBe(MAX_ROW_ATTRIBUTES);
      expect(r.rows.testIds.length).toBe(MAX_ROW_ATTRIBUTES);
    });

    it("caps list candidates, pager controls and namespaces", () => {
      const r = interpretSurface({
        rows: { lists: Array.from({ length: 99 }, () => ({ tag: "ol", items: 5, rows: 5 })) },
        pager: { present: true, controls: Array.from({ length: 99 }, (_, i) => ({ tag: `t${i}`, n: 1 })) },
        namespaces: Array.from({ length: 99 }, (_, i) => ({ prefix: `p${i}`, n: 1 })),
      })!;
      expect(r.rows.lists.length).toBe(MAX_LIST_CANDIDATES);
      expect(r.pager.controls.length).toBe(MAX_PAGER_CONTROLS);
      expect(r.namespaces.length).toBe(MAX_NAMESPACES);
    });

    it("de-duplicates and sorts the pager's page numbers, and drops nonsense", () => {
      const r = interpretSurface({
        pager: { present: true, hrefPages: [5, 2, 2, 0, -1, "3", null, 1e9, 3] },
      })!;
      expect(r.pager.hrefPages).toEqual([2, 3, 5]);
    });

    it("rejects a global name nobody asked about", () => {
      const r = interpretSurface({ embedded: { globals: ["__APOLLO_STATE__", "evil"] } })!;
      expect(r.embedded.globals).toEqual(["__APOLLO_STATE__"]);
    });

    it("drops a list row with no tag rather than emitting an empty one", () => {
      const r = interpretSurface({ rows: { lists: [{ items: 5 }, { tag: "ol", items: 5, rows: 5 }] } })!;
      expect(r.rows.lists).toHaveLength(1);
    });

    it("de-duplicates repeated attribute names", () => {
      const r = interpretSurface({
        rows: { anonymizeFields: [{ name: "title", n: 3 }, { name: "title", n: 99 }] },
      })!;
      expect(r.rows.anonymizeFields).toEqual([{ name: "title", n: 3 }]);
    });
  });
});

describe("paginationVerdict — the fork the milestone turns on", () => {
  it("is `none` when no pager rendered", () => {
    expect(paginationVerdict(pager({ present: false }))).toBe("none");
  });

  it("is `url` when a pager control carries an href with page=N", () => {
    expect(paginationVerdict(pager({ anchors: 9, hrefsWithPageParam: 9 }))).toBe("url");
  });

  // Anchors without a page parameter are not pagination hrefs — a pager whose
  // only links go elsewhere still needs a click to reach page 2.
  it("is `click-only` for a button pager, and for anchors carrying no page param", () => {
    expect(paginationVerdict(pager({ controls: [{ tag: "button", n: 9 }] }))).toBe("click-only");
    expect(paginationVerdict(pager({ anchors: 9, hrefsWithPageParam: 0 }))).toBe("click-only");
  });
});

describe("isSalesNavIsh", () => {
  it.each([
    "urn:li:fs_salesProfile:123",
    "urn:li:fs_salesCompany:9",
    "urn:li:fsd_profile:ACoAAA",
    '{"href":"/sales/lead/ACwAAA,NAME,abc"}',
  ])("recognises %s", (body) => expect(isSalesNavIsh(body)).toBe(true));

  it("does not fire on an unrelated body", () => {
    expect(isSalesNavIsh('{"tracking":{"pageKey":"d_flagship3_feed"}}')).toBe(false);
  });
});

describe("looksLikeUpsell", () => {
  it("recognises the paywall paths", () => {
    expect(looksLikeUpsell("https://www.linkedin.com/sales/gold/")).toBe(true);
    expect(looksLikeUpsell('{"cta":"/checkout/subscribe?x=1"}')).toBe(true);
  });

  it("is case-insensitive, because marketing paths are not a contract", () => {
    expect(looksLikeUpsell("/SALES/GOLD/")).toBe(true);
  });

  it("does not fire on an ordinary search body", () => {
    expect(looksLikeUpsell('{"elements":[{"entityUrn":"urn:li:fs_salesProfile:1"}]}')).toBe(false);
  });
});

describe("emptySurface", () => {
  it("returns a fresh object each time, so one caller cannot mutate another's", () => {
    const a = emptySurface();
    a.rows.leadLinks = 99;
    expect(emptySurface().rows.leadLinks).toBe(0);
  });
});
