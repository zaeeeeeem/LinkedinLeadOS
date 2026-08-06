import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  MAX_ID_CHARS, MAX_NAMESPACES, MAX_PREFIX_CHARS, MAX_SCRIPT_GLOBALS, MAX_TAG_CHARS,
  MAX_URL_CHARS, PAYLOAD_GLOBALS, emptySurface, interpretSurface, surfaceExpression,
} from "../src/capabilities/company.probe/surface.js";

/**
 * Runs the page script the way Chrome does, against a real parsed document.
 *
 * cheerio gives a spec-compliant parse (D125), so the selectors under test are
 * evaluated against markup rather than against a hand-written stub that agrees
 * with them by construction. Only the handful of DOM methods the expression
 * actually calls are shimmed, and `getComputedStyle` answers from a map keyed by
 * element id — which is what lets the scroller rule be exercised at all.
 */
function evaluateAgainst(o: {
  html: string;
  /** id → { overflowY, clientHeight, scrollHeight } */
  boxes?: Record<string, { overflowY: string; clientHeight: number; scrollHeight: number }>;
  documentScrollHeight?: number;
  href?: string;
  globals?: string[];
  segment?: string;
}): unknown {
  const $ = cheerio.load(o.html);
  const boxes = o.boxes ?? {};
  const box = (el: { attribs?: Record<string, string> }) => {
    const id = el.attribs?.["id"] ?? "";
    return boxes[id] ?? { overflowY: "visible", clientHeight: 0, scrollHeight: 0 };
  };
  const wrap = (el: { tagName: string; attribs?: Record<string, string> }) => ({
    tagName: el.tagName.toUpperCase(),
    get id() {
      return el.attribs?.["id"] ?? "";
    },
    get clientHeight() {
      return box(el).clientHeight;
    },
    get scrollHeight() {
      return box(el).scrollHeight;
    },
    getAttribute: (name: string) => el.attribs?.[name] ?? null,
    hasAttribute: (name: string) => el.attribs?.[name] !== undefined,
    get textContent() {
      return $(el as never).text();
    },
    __raw: el,
  });
  const document = {
    location: { href: o.href ?? "https://www.linkedin.com/company/acme/" },
    documentElement: { scrollHeight: o.documentScrollHeight ?? 800 },
    querySelectorAll: (selector: string) =>
      $(selector)
        .toArray()
        .map((n) => wrap(n as never)),
  };
  const getComputedStyle = (el: { __raw: { attribs?: Record<string, string> } }) => ({
    overflowY: box(el.__raw).overflowY,
  });
  const window: Record<string, unknown> = { innerHeight: 800 };
  for (const g of o.globals ?? []) window[g] = {};
  return new Function(
    "document", "getComputedStyle", "window",
    `return (${surfaceExpression(o.segment ?? "acme")});`,
  )(document, getComputedStyle, window);
}

const TABS =
  '<a href="/company/acme/">Home</a>' +
  '<a href="/company/acme/about/">About</a>' +
  '<a href="/company/acme/posts/?feedView=all">Posts</a>' +
  '<a href="/company/acme/people/">People</a>' +
  '<a href="/company/acme/people/">People again</a>';

describe("surfaceExpression, executed as real javascript", () => {
  it("names the real scroller instead of assuming the document (D115)", () => {
    const measured = evaluateAgainst({
      html:
        '<html><body><main id="workspace"><p id="clamped">x</p></main></body></html>',
      boxes: {
        // The LinkedIn shape: the document is pinned at one viewport and an
        // inner element holds the content.
        workspace: { overflowY: "scroll", clientHeight: 746, scrollHeight: 7348 },
        // A clamped paragraph, which is taller than it is tall and is not a
        // scroller. It must not win.
        clamped: { overflowY: "hidden", clientHeight: 210, scrollHeight: 1260 },
      },
      documentScrollHeight: 798,
    }) as Record<string, Record<string, unknown>>;

    expect(measured["scroller"]).toMatchObject({
      tag: "main", id: "workspace", isDocument: false, scrollHeight: 7348, clientHeight: 746,
    });
  });

  it("reports the document as the scroller when nothing inner scrolls", () => {
    const measured = evaluateAgainst({
      html: "<html><body><div>plain page</div></body></html>",
      documentScrollHeight: 5200,
    }) as Record<string, Record<string, unknown>>;
    expect(measured["scroller"]).toMatchObject({
      tag: null, id: null, isDocument: true, scrollHeight: 5200, clientHeight: 800,
    });
  });

  it("finds the page's own tab links, counts them, and never confuses main with a sub-page", () => {
    const measured = evaluateAgainst({ html: `<html><body><nav>${TABS}</nav></body></html>` }) as {
      tabs: Array<{ sub: string; linked: boolean; tag: string | null; links: number }>;
    };
    const bySub = Object.fromEntries(measured.tabs.map((t) => [t.sub, t]));
    expect(bySub["main"]).toMatchObject({ linked: true, tag: "a", links: 1 });
    expect(bySub["about"]).toMatchObject({ linked: true, tag: "a", links: 1 });
    // The query string is cut before matching — LinkedIn appends its own.
    expect(bySub["posts"]).toMatchObject({ linked: true, links: 1 });
    expect(bySub["people"]).toMatchObject({ linked: true, links: 2 });
    // Not linked at all is the SPA answer this exists to detect.
    expect(bySub["jobs"]).toMatchObject({ linked: false, tag: null, links: 0 });
  });

  it("does not count a sub-page link as a link to the company root", () => {
    const measured = evaluateAgainst({
      html: '<html><body><a href="/company/acme/jobs/">Jobs</a></body></html>',
    }) as { tabs: Array<{ sub: string; links: number }> };
    expect(measured.tabs.find((t) => t.sub === "main")?.links).toBe(0);
    expect(measured.tabs.find((t) => t.sub === "jobs")?.links).toBe(1);
  });

  it("inventories embedded json by script type and measures how much there is", () => {
    const measured = evaluateAgainst({
      html:
        '<html><head>' +
        '<script type="application/ld+json">{"@type":"Organization"}</script>' +
        '<script type="application/json">{"a":1}</script>' +
        '<script>var notStructuredData = 1;</script>' +
        "</head><body></body></html>",
      globals: ["__como_rehydration__"],
    }) as { embedded: Record<string, unknown> };

    expect(measured.embedded["ldJson"]).toBe(1);
    expect(measured.embedded["applicationJson"]).toBe(1);
    expect(measured.embedded["ldJsonChars"]).toBe('{"@type":"Organization"}'.length);
    // A bare <script> is JavaScript, not structured data, and is not counted.
    expect(measured.embedded["applicationJsonChars"]).toBe('{"a":1}'.length);
    expect(measured.embedded["globals"]).toEqual(["__como_rehydration__"]);
  });

  // The measurement that mattered and was missing: LinkedIn uses neither script
  // type. It streams its server-rendered Voyager JSON into
  // `<code id="bpr-guid-N">` islands, so the first company probe reported
  // "embedded json: 0" on documents carrying eleven thousand labeled leaves,
  // and the sweep then called nine fields DOM-only. See D184.
  it("counts LinkedIn's bpr-guid code islands, which is where its embedded json actually is", () => {
    const measured = evaluateAgainst({
      html:
        "<html><body>" +
        '<code style="display: none" id="bpr-guid-586526">{"included":[1]}</code>' +
        '<code id="bpr-guid-586527">{"a":1}</code>' +
        "</body></html>",
    }) as { embedded: Record<string, unknown> };

    expect(measured.embedded["bprIslands"]).toBe(2);
    expect(measured.embedded["bprIslandChars"]).toBe('{"included":[1]}'.length + '{"a":1}'.length);
  });

  it("does not count a rendered <code> block as a data island", () => {
    const measured = evaluateAgainst({
      html: '<html><body><code id="snippet-1">{"a":1}</code><code>{"b":2}</code></body></html>',
    }) as { embedded: Record<string, unknown> };
    expect(measured.embedded["bprIslands"]).toBe(0);
  });

  it("reduces every componentkey to its dotted namespace, so no id reaches the receipt", () => {
    const measured = evaluateAgainst({
      html:
        "<html><body>" +
        '<section componentkey="com.linkedin.sdui.organization.card.refACoAAsecret123Topcard"></section>' +
        '<section componentkey="com.linkedin.sdui.organization.card.refACoAAsecret123About"></section>' +
        '<div componentkey="ConnectButton-urn:li:member:99"></div>' +
        "</body></html>",
    }) as { namespaces: Array<{ prefix: string; n: number }>; componentKeys: number };

    expect(measured.componentKeys).toBe(3);
    const prefixes = measured.namespaces.map((n) => n.prefix);
    expect(prefixes).toContain("com.linkedin.sdui.organization.card");
    // Everything after the last dot — which is where any id sits — is cut off.
    expect(JSON.stringify(measured.namespaces)).not.toContain("ACoAAsecret123");
    // A key with no dotted namespace is bucketed rather than reported verbatim,
    // because that is where a raw urn would otherwise land on the receipt.
    expect(prefixes).toContain("(no dotted namespace)");
    expect(JSON.stringify(measured.namespaces)).not.toContain("urn:li:member:99");
  });

  it("returns null rather than throwing when the page will not answer", () => {
    const boom = new Function(
      "document", "getComputedStyle", "window",
      `return (${surfaceExpression("acme")});`,
    );
    expect(boom(null, () => ({}), {})).toBeNull();
  });
});

describe("interpretSurface", () => {
  const raw = () => ({
    url: "https://www.linkedin.com/company/acme/",
    scroller: { tag: "main", id: "workspace", hasComponentKey: false, scrollHeight: 7348, clientHeight: 746, isDocument: false },
    tabs: [{ sub: "about", linked: true, tag: "a", links: 1 }],
    embedded: {
      ldJson: 1, ldJsonChars: 10, applicationJson: 0, applicationJsonChars: 0,
      bprIslands: 18, bprIslandChars: 402_113, globals: ["__NEXT_DATA__"],
    },
    namespaces: [{ prefix: "com.linkedin.sdui.organization.card", n: 12 }],
    componentKeys: 12,
    render: { sections: 8, articles: 3, listItems: 40, anchors: 120 },
  });

  it("passes a well-formed report through unchanged", () => {
    expect(interpretSurface(raw())).toEqual(raw());
  });

  it("returns null for anything that is not an object", () => {
    for (const bad of [null, undefined, "", 3, true]) expect(interpretSurface(bad)).toBeNull();
  });

  it("survives a report with every field missing", () => {
    const out = interpretSurface({});
    expect(out).not.toBeNull();
    expect(out).toEqual(emptySurface());
  });

  it("drops a sub-page name this build does not know", () => {
    const r = { ...raw(), tabs: [{ sub: "insights", linked: true, tag: "a", links: 1 }] };
    expect(interpretSurface(r)?.tabs).toEqual([]);
  });

  it("drops a global the build never asked about, so no unreviewed string reaches the receipt", () => {
    const r = { ...raw(), embedded: { ...raw().embedded, globals: ["__NEXT_DATA__", "leakedSecretName"] } };
    expect(interpretSurface(r)?.embedded.globals).toEqual(["__NEXT_DATA__"]);
  });

  it("refuses to call a named element the document", () => {
    // A page claiming both is contradicting itself, and the tag is the half with
    // evidence behind it.
    const r = { ...raw(), scroller: { ...raw().scroller, isDocument: true } };
    expect(interpretSurface(r)?.scroller.isDocument).toBe(false);
  });

  it("bounds the namespace list, and the bound is exceeded here rather than assumed roomy", () => {
    const many = Array.from({ length: MAX_NAMESPACES + 40 }, (_, i) => ({ prefix: `ns.${i}`, n: 1 }));
    expect(interpretSurface({ ...raw(), namespaces: many })?.namespaces).toHaveLength(MAX_NAMESPACES);
  });

  it("bounds the globals list even when every name is one it asked about", () => {
    const many = Array.from({ length: MAX_SCRIPT_GLOBALS + 5 }, () => PAYLOAD_GLOBALS[0]!);
    expect(
      interpretSurface({ ...raw(), embedded: { ...raw().embedded, globals: many } })?.embedded.globals.length,
    ).toBeLessThanOrEqual(MAX_SCRIPT_GLOBALS);
  });

  it("bounds every page-controlled string, because the page decides what these hold", () => {
    const huge = "x".repeat(10_000);
    const out = interpretSurface({
      ...raw(),
      url: `https://www.linkedin.com/company/${huge}`,
      scroller: { ...raw().scroller, tag: huge, id: huge },
      namespaces: [{ prefix: huge, n: 1 }],
      tabs: [{ sub: "about", linked: true, tag: huge, links: 1 }],
    })!;
    expect(out.url.length).toBeLessThanOrEqual(MAX_URL_CHARS + 1);
    expect(out.scroller.tag!.length).toBeLessThanOrEqual(MAX_TAG_CHARS + 1);
    expect(out.scroller.id!.length).toBeLessThanOrEqual(MAX_ID_CHARS + 1);
    expect(out.namespaces[0]!.prefix.length).toBeLessThanOrEqual(MAX_PREFIX_CHARS + 1);
    expect(out.tabs[0]!.tag!.length).toBeLessThanOrEqual(MAX_TAG_CHARS + 1);
    // The whole report is bounded, not just each field of it.
    expect(JSON.stringify(out).length).toBeLessThan(4_000);
  });

  it("keeps one row per sub-page however many the page answers with", () => {
    const flood = Array.from({ length: 50_000 }, () => ({ sub: "about", linked: true, tag: "a", links: 1 }));
    const out = interpretSurface({ ...raw(), tabs: flood })!;
    expect(out.tabs).toHaveLength(1);
    expect(out.tabs[0]!.sub).toBe("about");
  });

  it("coerces a non-finite count to zero rather than letting NaN reach a receipt", () => {
    const r = { ...raw(), componentKeys: Number.NaN, render: { sections: "many" } };
    const out = interpretSurface(r);
    expect(out?.componentKeys).toBe(0);
    expect(out?.render.sections).toBe(0);
  });
});
