import { SCROLLER_SELECTION_JS } from "../profile.capture/read.js";
import {
  MAX_ATTRIBUTE_CHARS, MAX_PAGER_CONTROLS, MAX_ROW_ATTRIBUTES,
} from "./constants.js";

/**
 * What one Sales Navigator surface *is*, structurally — measured, never assumed.
 *
 * This is the half of the probe that answers what the archived bodies cannot:
 * whether the account has a seat at all, which element scrolls this surface
 * (D115 says do not assume `main#workspace`, and the reference worker measured
 * this page's own document scrolling ~56px while an inner container held the
 * results), which attribute vocabulary the result rows carry, and — the
 * milestone's fork — **how the real UI reaches page 2**.
 *
 * **Nothing it returns is captured LinkedIn data.** Counts, tag names, element
 * ids, attribute *names*, page *numbers* and booleans only — every one a fact
 * about the page's construction rather than about the people on it. The values
 * are in the archived DOM snapshot, where the offline sweep reads them.
 * Receipts go to stdout (§4.1, D3) and M5 CONTEXT rule 6 puts third-party names
 * off them even in search results, so this distinction is the difference
 * between a probe and a leak.
 *
 * Pager hrefs are the sharp edge here and are treated accordingly: the probe
 * reports whether an href exists, whether it carries the `page` parameter, and
 * which page number it points at — never the href itself, which carries the
 * operator's whole filter blob.
 */

/** Bounds on what comes back over CDP. A field map is a development aid and
 *  must never be the thing that runs a machine out of memory. */
export const MAX_NAMESPACES = 24;
export const MAX_SCRIPT_GLOBALS = 12;
export const MAX_PREFIX_CHARS = 200;
export const MAX_URL_CHARS = 500;
export const MAX_TAG_CHARS = 32;
export const MAX_ID_CHARS = 120;
/** How many candidate list containers to describe. */
export const MAX_LIST_CANDIDATES = 8;

/** Globals a server-rendered LinkedIn page has been seen to park its payload
 *  on. Presence/absence only — the value is never read here. */
export const PAYLOAD_GLOBALS = [
  "__como_rehydration__",
  "__APOLLO_STATE__",
  "__NEXT_DATA__",
  "__INITIAL_STATE__",
  "artdecoIcons",
] as const;

export type ScrollerReport = {
  tag: string | null;
  id: string | null;
  hasComponentKey: boolean;
  scrollHeight: number;
  clientHeight: number;
  /** True when nothing inner scrolled and the document is what moves. */
  isDocument: boolean;
};

/** One candidate result-list container. The probe describes every list that
 *  could plausibly hold results rather than asserting one selector, because
 *  the one selector it would assert is the reference worker's and that worker
 *  is three LinkedIn builds old. */
export type ListCandidate = {
  tag: string;
  id: string | null;
  /** `data-testid`, the anchor Task 38 is required to scope on — never the
   *  per-build hashed class names (D305 discipline). */
  testId: string | null;
  /** Direct `li` children. */
  items: number;
  /** How many of those children contain a `/sales/lead/` or `/sales/company/`
   *  link — i.e. how many are actually result rows. */
  rows: number;
};

export type RowsReport = {
  /** Links to a lead permalink anywhere on the page. Container-independent
   *  evidence that results rendered. */
  leadLinks: number;
  /** Links to an account permalink. */
  accountLinks: number;
  /** The candidate lists, largest first. */
  lists: ListCandidate[];
  /** Distinct `data-anonymize` values found inside result rows, with counts.
   *  LinkedIn's own field vocabulary — attribute names, never their text. */
  anonymizeFields: Array<{ name: string; n: number }>;
  /** Distinct `data-testid` values found inside result rows, with counts. */
  testIds: Array<{ name: string; n: number }>;
};

/**
 * How this surface offers page 2 — the measurement the whole milestone forks on.
 *
 * `hrefPages` being non-empty is the good outcome: the pager's own controls are
 * anchors carrying a url, so navigating to page 2 is the page's own navigation
 * rather than an invention (M5 CONTEXT rule 4). All-buttons and no hrefs is the
 * outcome that needs an operator decision before any code clicks anything.
 */
export type PagerReport = {
  present: boolean;
  /** The container's own `data-testid`, when it has one. */
  testId: string | null;
  /** Tag names of the pager's controls, with counts — `button` vs `a`. */
  controls: Array<{ tag: string; n: number }>;
  /** How many pager controls are anchors carrying an `href`. */
  anchors: number;
  /** How many of those hrefs carry the `page` query parameter. */
  hrefsWithPageParam: number;
  /** The page *numbers* those hrefs point at, sorted. Numbers only — the hrefs
   *  themselves carry the operator's filter blob and never leave the snapshot. */
  hrefPages: number[];
  /** From `.artdeco-pagination__state--a11y` or equivalent: "Page X of Y",
   *  parsed to two numbers. The total result-page count for free, with no body. */
  page: number | null;
  totalPages: number | null;
  /** True when the current url already carries a `page` parameter — i.e. the
   *  address bar itself expresses pagination. */
  urlHasPageParam: boolean;
};

export type EmbeddedReport = {
  ldJson: number;
  ldJsonChars: number;
  applicationJson: number;
  applicationJsonChars: number;
  /** `<code id="bpr-guid-N">` — LinkedIn's Big Pipe data islands, the D117
   *  readable source. Zero here on a client-rendered app is the expected read. */
  bprIslands: number;
  bprIslandChars: number;
  globals: string[];
};

/** The seat verdict, from the page itself. Deliberately three-valued: a probe
 *  that could not tell must say so rather than defaulting to "fine". */
export type SeatReport = {
  /** True when a Sales Navigator app chrome element is present. */
  appShell: boolean;
  /** True when the page carries upsell/paywall markers. */
  upsell: boolean;
  /** True when the landed path left `/sales/` entirely. */
  redirectedOffSales: boolean;
};

export type SurfaceReport = {
  /** `location.href` at the moment of the read, so a redirect is measured
   *  rather than assumed away. */
  url: string;
  seat: SeatReport;
  scroller: ScrollerReport;
  rows: RowsReport;
  pager: PagerReport;
  embedded: EmbeddedReport;
  namespaces: Array<{ prefix: string; n: number }>;
  componentKeys: number;
  /** Render evidence. A shell and a rendered page differ here by an order of
   *  magnitude, and it is what says whether the snapshot is worth parsing. */
  render: { sections: number; articles: number; listItems: number; anchors: number };
};

const EMPTY: SurfaceReport = {
  url: "",
  seat: { appShell: false, upsell: false, redirectedOffSales: false },
  scroller: { tag: null, id: null, hasComponentKey: false, scrollHeight: 0, clientHeight: 0, isDocument: true },
  rows: { leadLinks: 0, accountLinks: 0, lists: [], anonymizeFields: [], testIds: [] },
  pager: {
    present: false, testId: null, controls: [], anchors: 0, hrefsWithPageParam: 0,
    hrefPages: [], page: null, totalPages: null, urlHasPageParam: false,
  },
  embedded: {
    ldJson: 0, ldJsonChars: 0, applicationJson: 0, applicationJsonChars: 0,
    bprIslands: 0, bprIslandChars: 0, globals: [],
  },
  namespaces: [],
  componentKeys: 0,
  render: { sections: 0, articles: 0, listItems: 0, anchors: 0 },
};

/**
 * The single `Runtime.evaluate` that measures one surface.
 *
 * One round trip on purpose, for `SNAPSHOT_EXPRESSION`'s reason: measurements
 * taken in two calls describe two different instants, and the report would then
 * be about a page other than the one archived beside it.
 *
 * It never throws — a page that cannot be read returns `null` and the caller
 * records a miss. By the time this runs the page load is already spent.
 */
export function surfaceExpression(): string {
  return `(() => {
  try {
    var GLOBALS = ${JSON.stringify(PAYLOAD_GLOBALS)};

    var scroller = ${SCROLLER_SELECTION_JS}();

    // ---- seat -------------------------------------------------------------
    // Presence of the app's own chrome, not of any particular text: a marketing
    // page and the app differ structurally, and matching on copy would break on
    // the next wording change.
    var appShell = !!(
      document.querySelector('#sales-nav-app') ||
      document.querySelector('[class*="sales-nav"]') ||
      document.querySelector('a[href^="/sales/search/"]') ||
      document.querySelector('a[href^="/sales/lists/"]')
    );
    var upsell = !!(
      document.querySelector('a[href*="/sales/gold/"]') ||
      document.querySelector('a[href*="checkout/subscribe"]') ||
      document.querySelector('[class*="upsell"]') ||
      document.querySelector('[data-test-id*="upsell"]')
    );
    var path = (document.location && document.location.pathname) || '';
    var redirectedOffSales = path.indexOf('/sales') !== 0;

    // ---- rows -------------------------------------------------------------
    var leadLinks = document.querySelectorAll('a[href*="/sales/lead/"]').length;
    var accountLinks = document.querySelectorAll('a[href*="/sales/company/"]').length;

    // Every list that could plausibly hold results, described rather than one
    // selector asserted. The reference worker's 'ol.artdeco-list' is a guess
    // three builds old; this reports whether it is still the answer.
    var lists = [];
    var containers = document.querySelectorAll('ol, ul');
    for (var c = 0; c < containers.length; c++) {
      var el = containers[c];
      var kids = [];
      for (var k = 0; k < el.children.length; k++) {
        if (el.children[k].tagName === 'LI') kids.push(el.children[k]);
      }
      if (kids.length < 3) continue;
      var rows = 0;
      for (var r = 0; r < kids.length; r++) {
        if (kids[r].querySelector('a[href*="/sales/lead/"], a[href*="/sales/company/"]')) rows++;
      }
      lists.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        testId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null,
        items: kids.length,
        rows: rows,
      });
    }
    lists.sort(function (a, b) { return (b.rows - a.rows) || (b.items - a.items); });

    // The attribute vocabulary the rows carry. Names and counts; never the text
    // inside them — that is a third party's name and it does not leave the
    // archived snapshot.
    var rowScope = [];
    var leadAnchors = document.querySelectorAll('a[href*="/sales/lead/"], a[href*="/sales/company/"]');
    for (var la = 0; la < leadAnchors.length; la++) {
      var li = leadAnchors[la].closest('li');
      if (li && rowScope.indexOf(li) === -1) rowScope.push(li);
    }
    var tally = function (nodes, attr, into) {
      for (var t = 0; t < nodes.length; t++) {
        var v = nodes[t].getAttribute(attr);
        if (!v) continue;
        into[v] = (into[v] || 0) + 1;
      }
    };
    var anonCounts = {};
    var testCounts = {};
    for (var s2 = 0; s2 < rowScope.length; s2++) {
      tally(rowScope[s2].querySelectorAll('[data-anonymize]'), 'data-anonymize', anonCounts);
      tally(rowScope[s2].querySelectorAll('[data-testid]'), 'data-testid', testCounts);
    }
    var asRows = function (counts) {
      var out = [];
      for (var p in counts) { if (Object.prototype.hasOwnProperty.call(counts, p)) out.push({ name: p, n: counts[p] }); }
      out.sort(function (a, b) { return b.n - a.n; });
      return out;
    };

    // ---- pager ------------------------------------------------------------
    var pager = document.querySelector('.artdeco-pagination')
      || document.querySelector('[data-testid*="pagination"]')
      || document.querySelector('[class*="pagination"]');
    var pagerReport = {
      present: !!pager, testId: null, controls: [], anchors: 0,
      hrefsWithPageParam: 0, hrefPages: [], page: null, totalPages: null,
      urlHasPageParam: false,
    };
    try {
      pagerReport.urlHasPageParam = new URL(document.location.href).searchParams.has('page');
    } catch (e3) { /* about:blank */ }
    if (pager) {
      pagerReport.testId = pager.getAttribute('data-testid') || pager.getAttribute('data-test-id') || null;
      var controls = pager.querySelectorAll('button, a');
      var tagCounts = {};
      var pages = {};
      for (var ci = 0; ci < controls.length; ci++) {
        var ctl = controls[ci];
        var tag = ctl.tagName.toLowerCase();
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        var href = ctl.getAttribute('href');
        if (!href) continue;
        pagerReport.anchors++;
        // The href itself is never reported — it carries the whole filter blob.
        // Only whether it paginates, and which page it points at.
        var m = href.match(/[?&]page(?:=|%3D)(\\d{1,4})/i);
        if (m) { pagerReport.hrefsWithPageParam++; pages[+m[1]] = true; }
      }
      pagerReport.controls = asRows(tagCounts).map(function (row) { return { tag: row.name, n: row.n }; });
      var pageList = [];
      for (var pk in pages) { if (Object.prototype.hasOwnProperty.call(pages, pk)) pageList.push(+pk); }
      pageList.sort(function (a, b) { return a - b; });
      pagerReport.hrefPages = pageList;

      // "Page X of Y", scoped to the pager so a result blurb containing those
      // words can never hijack the reading. Two numbers out; the string stays.
      var a11y = pager.querySelector('.artdeco-pagination__state--a11y')
        || pager.querySelector('[aria-live]');
      var src = a11y ? (a11y.textContent || '') : (pager.textContent || '');
      var pm = src.match(/Page\\s+(\\d+)\\s+of\\s+([\\d,]+)/i);
      if (pm) {
        pagerReport.page = +pm[1];
        pagerReport.totalPages = +(pm[2].replace(/,/g, ''));
      }
    }

    // ---- embedded + componentkeys ----------------------------------------
    var keyed = document.querySelectorAll('[componentkey]');
    var counts = {};
    for (var i = 0; i < keyed.length; i++) {
      var key = keyed[i].getAttribute('componentkey') || '';
      var cut = key.lastIndexOf('.');
      var prefix = cut > 0 ? key.slice(0, cut) : '(no dotted namespace)';
      counts[prefix] = (counts[prefix] || 0) + 1;
    }
    var namespaces = asRows(counts).map(function (row) { return { prefix: row.name, n: row.n }; });

    var ldJson = document.querySelectorAll('script[type="application/ld+json"]');
    var appJson = document.querySelectorAll('script[type="application/json"]');
    var bprAll = document.querySelectorAll('code[id^="bpr-guid-"]');
    var bpr = [];
    for (var bi = 0; bi < bprAll.length; bi++) {
      if (/^bpr-guid-\\d+$/.test(bprAll[bi].id)) bpr.push(bprAll[bi]);
    }
    var chars = function (list) {
      var total = 0;
      for (var ch = 0; ch < list.length; ch++) total += (list[ch].textContent || '').length;
      return total;
    };
    var globals = [];
    for (var g = 0; g < GLOBALS.length; g++) {
      try { if (typeof window[GLOBALS[g]] !== 'undefined') globals.push(GLOBALS[g]); } catch (e2) { /* cross-origin */ }
    }

    return {
      url: (document.location && document.location.href) || '',
      seat: { appShell: appShell, upsell: upsell, redirectedOffSales: redirectedOffSales },
      scroller: {
        tag: scroller ? scroller.tagName.toLowerCase() : null,
        id: scroller && scroller.id ? scroller.id : null,
        hasComponentKey: scroller ? scroller.hasAttribute('componentkey') : false,
        scrollHeight: scroller ? scroller.scrollHeight : ((document.documentElement && document.documentElement.scrollHeight) || 0),
        clientHeight: scroller ? scroller.clientHeight : (window.innerHeight || 0),
        isDocument: !scroller,
      },
      rows: {
        leadLinks: leadLinks,
        accountLinks: accountLinks,
        lists: lists,
        anonymizeFields: asRows(anonCounts),
        testIds: asRows(testCounts),
      },
      pager: pagerReport,
      embedded: {
        ldJson: ldJson.length,
        ldJsonChars: chars(ldJson),
        applicationJson: appJson.length,
        applicationJsonChars: chars(appJson),
        bprIslands: bpr.length,
        bprIslandChars: chars(bpr),
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

/** A page number the page claimed. Bounded on the way in for the same reason
 *  every string is: the page decides what this returns. */
function pageNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100_000 ? v : null;
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

/** `{name, n}` rows, clamped, deduplicated and bounded. */
function namedCounts(raw: unknown, limit: number): Array<{ name: string; n: number }> {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Array<{ name: string; n: number }> = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const name = clamp(str(row["name"]), MAX_ATTRIBUTE_CHARS);
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, n: num(row["n"]) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Validates and normalizes whatever came back from the page.
 *
 * Pure and total, so every branch of "the page answered oddly" is provable
 * without a browser — and so the bounds are enforced *here*, on the way in,
 * rather than trusted to a page we do not control.
 */
export function interpretSurface(raw: unknown): SurfaceReport | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const seat = (o["seat"] ?? {}) as Record<string, unknown>;
  const scroller = (o["scroller"] ?? {}) as Record<string, unknown>;
  const rows = (o["rows"] ?? {}) as Record<string, unknown>;
  const pager = (o["pager"] ?? {}) as Record<string, unknown>;
  const embedded = (o["embedded"] ?? {}) as Record<string, unknown>;
  const render = (o["render"] ?? {}) as Record<string, unknown>;

  const namespaces = Array.isArray(o["namespaces"])
    ? (o["namespaces"] as unknown[])
        .filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
        .map((n) => ({ prefix: clamp(String(n["prefix"] ?? ""), MAX_PREFIX_CHARS) ?? "", n: num(n["n"]) }))
        .filter((n) => n.prefix !== "")
        .slice(0, MAX_NAMESPACES)
    : [];

  const lists = Array.isArray(rows["lists"])
    ? (rows["lists"] as unknown[])
        .filter((l): l is Record<string, unknown> => l !== null && typeof l === "object")
        .map((l) => ({
          tag: clamp(str(l["tag"]), MAX_TAG_CHARS) ?? "",
          id: clamp(str(l["id"]), MAX_ID_CHARS),
          testId: clamp(str(l["testId"]), MAX_ATTRIBUTE_CHARS),
          items: num(l["items"]),
          rows: num(l["rows"]),
        }))
        .filter((l) => l.tag !== "")
        .slice(0, MAX_LIST_CANDIDATES)
    : [];

  const controls = Array.isArray(pager["controls"])
    ? (pager["controls"] as unknown[])
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
        .map((c) => ({ tag: clamp(str(c["tag"]), MAX_TAG_CHARS) ?? "", n: num(c["n"]) }))
        .filter((c) => c.tag !== "")
        .slice(0, MAX_PAGER_CONTROLS)
    : [];

  // Page numbers, deduplicated, sorted and bounded. The pager is asked for a
  // handful and could answer with a hundred thousand.
  const hrefPages = Array.isArray(pager["hrefPages"])
    ? [...new Set(
        (pager["hrefPages"] as unknown[])
          .map((p) => pageNumber(p))
          .filter((p): p is number => p !== null),
      )].sort((a, b) => a - b).slice(0, MAX_PAGER_CONTROLS)
    : [];

  const globals = Array.isArray(embedded["globals"])
    ? (embedded["globals"] as unknown[])
        .filter((g): g is string => typeof g === "string")
        // Only names this build asked about may come back. A page answering
        // with something else is answering a question nobody posed.
        .filter((g) => (PAYLOAD_GLOBALS as readonly string[]).includes(g))
        .slice(0, MAX_SCRIPT_GLOBALS)
    : [];

  return {
    url: clamp(typeof o["url"] === "string" ? o["url"] : "", MAX_URL_CHARS) ?? "",
    seat: {
      appShell: seat["appShell"] === true,
      upsell: seat["upsell"] === true,
      redirectedOffSales: seat["redirectedOffSales"] === true,
    },
    scroller: {
      tag: clamp(str(scroller["tag"]), MAX_TAG_CHARS),
      id: clamp(str(scroller["id"]), MAX_ID_CHARS),
      hasComponentKey: scroller["hasComponentKey"] === true,
      scrollHeight: num(scroller["scrollHeight"]),
      clientHeight: num(scroller["clientHeight"]),
      // Derived, not taken from the page: `isDocument` and a named element are
      // contradictory in both directions, and the tag is the half with evidence
      // behind it.
      isDocument: str(scroller["tag"]) === null,
    },
    rows: {
      leadLinks: num(rows["leadLinks"]),
      accountLinks: num(rows["accountLinks"]),
      lists,
      anonymizeFields: namedCounts(rows["anonymizeFields"], MAX_ROW_ATTRIBUTES),
      testIds: namedCounts(rows["testIds"], MAX_ROW_ATTRIBUTES),
    },
    pager: {
      present: pager["present"] === true,
      testId: clamp(str(pager["testId"]), MAX_ATTRIBUTE_CHARS),
      controls,
      anchors: num(pager["anchors"]),
      hrefsWithPageParam: num(pager["hrefsWithPageParam"]),
      hrefPages,
      page: pageNumber(pager["page"]),
      totalPages: pageNumber(pager["totalPages"]),
      urlHasPageParam: pager["urlHasPageParam"] === true,
    },
    embedded: {
      ldJson: num(embedded["ldJson"]),
      ldJsonChars: num(embedded["ldJsonChars"]),
      applicationJson: num(embedded["applicationJson"]),
      applicationJsonChars: num(embedded["applicationJsonChars"]),
      bprIslands: num(embedded["bprIslands"]),
      bprIslandChars: num(embedded["bprIslandChars"]),
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

/** The report a surface that could not be measured gets, so downstream code
 *  never has to branch on `null` to print a receipt. */
export function emptySurface(): SurfaceReport {
  return structuredClone(EMPTY);
}

/**
 * The pagination verdict, derived from one surface's measurement.
 *
 * Three-valued on purpose (M5 CONTEXT rule 4):
 *
 * - `url` — the pager's own controls carry hrefs with `page=N`. Navigating one
 *   is the page's own navigation, allowed like any cold load.
 * - `click-only` — a pager exists but expresses itself entirely in script-driven
 *   buttons. Clicking is a class of action this toolkit has never taken and
 *   needs an explicit operator decision before any code does it (D323
 *   precedent). Task 38 stays blocked on that decision.
 * - `none` — no pager rendered. Either the search has one page of results or
 *   the page never finished rendering, and the row counts say which.
 */
export type PaginationVerdict = "url" | "click-only" | "none";

export function paginationVerdict(pager: PagerReport): PaginationVerdict {
  if (!pager.present) return "none";
  return pager.hrefsWithPageParam > 0 ? "url" : "click-only";
}
