import { SCROLLER_SELECTION_JS } from "../profile.capture/read.js";
import { COMPANY_SUBPAGES, type CompanySubPage } from "./url.js";

/**
 * What one company sub-page *is*, structurally — measured, never assumed.
 *
 * This is the half of the probe that answers questions the archived bodies
 * cannot: which element scrolls this surface (D115 says do not assume
 * `main#workspace`), whether LinkedIn's own tab links are real navigations or
 * SPA routes, whether the document carries embedded structured JSON (D117's
 * readable source), and whether the server-driven-UI `componentkey` namespace
 * D127 found on profiles exists here at all.
 *
 * **Nothing it returns is captured LinkedIn data.** Counts, tag names, element
 * ids and dotted namespace prefixes only — every one of which is a fact about
 * the page's construction rather than about the company. The values themselves
 * are in the archived DOM snapshot, where the offline sweep reads them. Receipts
 * go to stdout (§4.1, D3), so this distinction is the difference between a
 * probe and a leak.
 */

/** Bounds on what comes back over CDP. A field map is a development aid and
 *  must never be the thing that runs a machine out of memory. */
export const MAX_NAMESPACES = 24;
export const MAX_SCRIPT_GLOBALS = 12;
/** A `componentkey` namespace is a dotted java-ish package name. Anything
 *  longer than this is not one, and is a page putting a string on a receipt. */
export const MAX_PREFIX_CHARS = 200;
/** `location.href` after a redirect. LinkedIn's own urls are far shorter; a
 *  data: or blob: url is not something to print in full. */
export const MAX_URL_CHARS = 500;
/** An html tag name; the longest in the spec is `blockquote`. */
export const MAX_TAG_CHARS = 32;
/** An element id. */
export const MAX_ID_CHARS = 120;

/** Globals a server-rendered LinkedIn page has been seen to park its payload
 *  on. `__como_rehydration__` is the RSC flight stream D121 measured on the
 *  profile page; the rest are looked for because absence is as informative as
 *  presence. Presence/absence only — the value is never read here. */
export const PAYLOAD_GLOBALS = [
  "__como_rehydration__",
  "__APOLLO_STATE__",
  "__NEXT_DATA__",
  "__INITIAL_STATE__",
  "artdecoIcons",
] as const;

export type ScrollerReport = {
  /** `null` when the document itself is the scroller. */
  tag: string | null;
  id: string | null;
  /** True when the element carries a `componentkey` — i.e. it is part of the
   *  server-driven UI rather than a plain layout div. */
  hasComponentKey: boolean;
  scrollHeight: number;
  clientHeight: number;
  /** True when nothing inner scrolled and the document is what moves. */
  isDocument: boolean;
};

export type TabReport = {
  sub: CompanySubPage;
  /** True when the page itself links to this sub-page with a real `href`. An
   *  `href` means a cold load is the page's own navigation, not an invention. */
  linked: boolean;
  tag: string | null;
  /** How many links to this sub-page the page carries. */
  links: number;
};

export type EmbeddedReport = {
  ldJson: number;
  ldJsonChars: number;
  applicationJson: number;
  applicationJsonChars: number;
  /** Which of `PAYLOAD_GLOBALS` are defined on `window`. Names only. */
  globals: string[];
};

export type SurfaceReport = {
  /** `location.href` at the moment of the read, so a redirect is measured
   *  rather than assumed away. Built from the operator's own input. */
  url: string;
  scroller: ScrollerReport;
  tabs: TabReport[];
  embedded: EmbeddedReport;
  /** Distinct dotted `componentkey` namespaces, with counts. A key of the form
   *  `com.linkedin.sdui.profile.card.ref<ID><Card>` reduces to
   *  `com.linkedin.sdui.profile.card` — everything after the last dot, which is
   *  where any id would sit, is cut off. */
  namespaces: Array<{ prefix: string; n: number }>;
  componentKeys: number;
  /** Render evidence. A shell and a rendered page differ here by an order of
   *  magnitude, and it is what says whether the snapshot is worth parsing. */
  render: { sections: number; articles: number; listItems: number; anchors: number };
};

const EMPTY: SurfaceReport = {
  url: "",
  scroller: { tag: null, id: null, hasComponentKey: false, scrollHeight: 0, clientHeight: 0, isDocument: true },
  tabs: [],
  embedded: { ldJson: 0, ldJsonChars: 0, applicationJson: 0, applicationJsonChars: 0, globals: [] },
  namespaces: [],
  componentKeys: 0,
  render: { sections: 0, articles: 0, listItems: 0, anchors: 0 },
};

/**
 * The single `Runtime.evaluate` that measures one sub-page.
 *
 * One round trip on purpose, for `SNAPSHOT_EXPRESSION`'s reason: measurements
 * taken in two calls describe two different instants, and the report would then
 * be about a page other than the one archived beside it.
 *
 * It never throws — a page that cannot be read returns `null` and the caller
 * records a miss. By the time this runs the page load is already spent.
 */
export function surfaceExpression(companySegment: string): string {
  return `(() => {
  try {
    var SUBS = ${JSON.stringify(COMPANY_SUBPAGES)};
    var GLOBALS = ${JSON.stringify(PAYLOAD_GLOBALS)};
    var BASE = ${JSON.stringify(`/company/${companySegment}/`)};

    var scroller = ${SCROLLER_SELECTION_JS}();

    var keyed = document.querySelectorAll('[componentkey]');
    var counts = {};
    for (var i = 0; i < keyed.length; i++) {
      var key = keyed[i].getAttribute('componentkey') || '';
      var cut = key.lastIndexOf('.');
      var prefix = cut > 0 ? key.slice(0, cut) : '(no dotted namespace)';
      counts[prefix] = (counts[prefix] || 0) + 1;
    }
    var namespaces = [];
    for (var p in counts) { if (Object.prototype.hasOwnProperty.call(counts, p)) namespaces.push({ prefix: p, n: counts[p] }); }
    namespaces.sort(function (a, b) { return b.n - a.n; });

    var tabs = [];
    for (var s = 0; s < SUBS.length; s++) {
      var sub = SUBS[s];
      var want = sub === 'main' ? BASE : BASE + sub + '/';
      var links = document.querySelectorAll('a[href]');
      var found = null;
      var n = 0;
      for (var j = 0; j < links.length; j++) {
        var href = links[j].getAttribute('href') || '';
        var path = href.split('?')[0].split('#')[0];
        if (path.indexOf(want) === -1) continue;
        if (sub === 'main' && path.replace(/\\/+$/, '') !== BASE.replace(/\\/+$/, '')) continue;
        n++;
        if (found === null) found = links[j];
      }
      tabs.push({ sub: sub, linked: n > 0, tag: found ? found.tagName.toLowerCase() : null, links: n });
    }

    var ldJson = document.querySelectorAll('script[type="application/ld+json"]');
    var appJson = document.querySelectorAll('script[type="application/json"]');
    var chars = function (list) {
      var total = 0;
      for (var k = 0; k < list.length; k++) total += (list[k].textContent || '').length;
      return total;
    };
    var globals = [];
    for (var g = 0; g < GLOBALS.length; g++) {
      try { if (typeof window[GLOBALS[g]] !== 'undefined') globals.push(GLOBALS[g]); } catch (e2) { /* cross-origin */ }
    }

    return {
      url: (document.location && document.location.href) || '',
      scroller: {
        tag: scroller ? scroller.tagName.toLowerCase() : null,
        id: scroller && scroller.id ? scroller.id : null,
        hasComponentKey: scroller ? scroller.hasAttribute('componentkey') : false,
        scrollHeight: scroller ? scroller.scrollHeight : ((document.documentElement && document.documentElement.scrollHeight) || 0),
        clientHeight: scroller ? scroller.clientHeight : (window.innerHeight || 0),
        isDocument: !scroller,
      },
      tabs: tabs,
      embedded: {
        ldJson: ldJson.length,
        ldJsonChars: chars(ldJson),
        applicationJson: appJson.length,
        applicationJsonChars: chars(appJson),
        globals: globals,
      },
      namespaces: namespaces,
      componentKeys: keyed.length,
      render: {
        sections: document.querySelectorAll('section').length,
        articles: document.querySelectorAll('article').length,
        listItems: document.querySelectorAll('li').length,
        anchors: document.querySelectorAll('a[href]').length,
      },
    };
  } catch (e) { return null; }
})()`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Every page-controlled string is clamped on the way in. The page decides what
 *  this returns and the receipt goes to stdout; "the browser would not do that"
 *  is not a bound (§4.1, D3). */
function clamp(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * Validates and normalizes whatever came back from the page.
 *
 * Pure and total, so every branch of "the page answered oddly" is provable
 * without a browser — and so the bounds below are enforced *here*, on the way
 * in, rather than trusted to a page we do not control.
 */
export function interpretSurface(raw: unknown): SurfaceReport | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const scroller = (o["scroller"] ?? {}) as Record<string, unknown>;
  const embedded = (o["embedded"] ?? {}) as Record<string, unknown>;
  const render = (o["render"] ?? {}) as Record<string, unknown>;

  const namespaces = Array.isArray(o["namespaces"])
    ? (o["namespaces"] as unknown[])
        .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
        .map((n) => ({ prefix: clamp(String(n["prefix"] ?? ""), MAX_PREFIX_CHARS) ?? "", n: num(n["n"]) }))
        .filter((n) => n.prefix !== "")
        .slice(0, MAX_NAMESPACES)
    : [];

  // One row per sub-page at most, and the *first* row for each wins. The page
  // is asked for exactly five and could answer with fifty thousand all named
  // `about`; filtering to known names bounds the vocabulary but not the length,
  // and length is what reaches stdout.
  const seenSubs = new Set<string>();
  const tabs = Array.isArray(o["tabs"])
    ? (o["tabs"] as unknown[])
        .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
        .flatMap((t): TabReport[] => {
          const sub = String(t["sub"] ?? "");
          if (!(COMPANY_SUBPAGES as readonly string[]).includes(sub)) return [];
          if (seenSubs.has(sub)) return [];
          seenSubs.add(sub);
          return [{
            sub: sub as CompanySubPage,
            linked: t["linked"] === true,
            tag: clamp(str(t["tag"]), MAX_TAG_CHARS),
            links: num(t["links"]),
          }];
        })
    : [];

  const globals = Array.isArray(embedded["globals"])
    ? (embedded["globals"] as unknown[])
        .filter((g): g is string => typeof g === "string")
        // Only names this build asked about may come back. A page that answered
        // with something else is answering a question nobody posed, and letting
        // it through would put an unreviewed string on the receipt.
        .filter((g) => (PAYLOAD_GLOBALS as readonly string[]).includes(g))
        .slice(0, MAX_SCRIPT_GLOBALS)
    : [];

  return {
    url: clamp(typeof o["url"] === "string" ? o["url"] : "", MAX_URL_CHARS) ?? "",
    scroller: {
      tag: clamp(str(scroller["tag"]), MAX_TAG_CHARS),
      id: clamp(str(scroller["id"]), MAX_ID_CHARS),
      hasComponentKey: scroller["hasComponentKey"] === true,
      scrollHeight: num(scroller["scrollHeight"]),
      clientHeight: num(scroller["clientHeight"]),
      // Derived, not taken from the page. `isDocument` and a named element are
      // contradictory in both directions, and the tag is the half with evidence
      // behind it: an element was found, or it was not. A report that arrives
      // with neither — the page answered with nothing — reads as "the document",
      // which is what a page with no inner scroller is.
      isDocument: str(scroller["tag"]) === null,
    },
    tabs,
    embedded: {
      ldJson: num(embedded["ldJson"]),
      ldJsonChars: num(embedded["ldJsonChars"]),
      applicationJson: num(embedded["applicationJson"]),
      applicationJsonChars: num(embedded["applicationJsonChars"]),
      globals,
    },
    namespaces,
    componentKeys: num(o["componentKeys"]),
    render: {
      sections: num(render["sections"]),
      articles: num(render["articles"]),
      listItems: num(render["listItems"]),
      anchors: num(render["anchors"]),
    },
  };
}

/** The report a sub-page that could not be measured gets, so downstream code
 *  never has to branch on `null` to print a receipt. */
export function emptySurface(): SurfaceReport {
  return structuredClone(EMPTY);
}
