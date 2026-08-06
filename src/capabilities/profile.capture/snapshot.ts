import type { ArchivedCapture } from "../../core/archive/raw.js";
import { SUBJECT_CONTAINER_MIN_SECTIONS, SUBJECT_CONTAINER_MIN_TEXT } from "./constants.js";

/**
 * The rendered-DOM snapshot: the one place a data field may be read off the DOM.
 *
 * D121 measured that a cold load of `/in/<vanity>` issues no Voyager call
 * carrying the subject's content, and that the copy embedded in the document is
 * a React Server Components flight stream in which the subject and a "people
 * also viewed" stranger are the same shape at different, meaningless indices.
 * D123 resolved it: identity stays on the Voyager body, content comes from the
 * *rendered* DOM, where the subject lives in the main container and the
 * suggestions live in a sidebar — a distinction position in a flight stream
 * could not provide.
 *
 * This module takes that snapshot. It archives `outerHTML` like any captured
 * body (D2) so the parser runs offline against it, and it reports whether the
 * subject's container was actually there — a snapshot of a half-rendered page
 * is a visible warning, never a silently short fixture.
 */

/** Marks the snapshot's archive record as a DOM read rather than a tapped
 *  response. Promotion branches on it, and `log:why` can tell the two apart. */
export const DOM_SNAPSHOT_PATTERN = "dom-snapshot";

/** The synthetic url the snapshot is archived under. Prefixed with a scheme
 *  that is not `http`, so nothing downstream can mistake it for something
 *  LinkedIn served over the wire. */
export function domSnapshotUrl(targetUrl: string): string {
  return `${DOM_SNAPSHOT_PATTERN}:${targetUrl}`;
}

/** True for an archive entry that is a DOM snapshot rather than a network body.
 *  The sidecar's `pattern` is authoritative; the url prefix is the fallback for
 *  an entry whose sidecar write failed (`ARCHIVE_SIDECAR_FAILED`). */
export function isDomSnapshotEntry(entry: { url: string; pattern?: string }): boolean {
  return entry.pattern === DOM_SNAPSHOT_PATTERN || entry.url.startsWith(`${DOM_SNAPSHOT_PATTERN}:`);
}

/**
 * Where the subject's own content lives, in preference order.
 *
 * `main#workspace` is what D115 measured as LinkedIn's real scroller on a
 * profile page. The generic fallbacks exist so a layout change degrades to a
 * wider container rather than to nothing — a wider container still excludes the
 * sidebar, which is the property that matters.
 */
export const SUBJECT_CONTAINER_SELECTORS = ["main#workspace", "main", "[role=main]"] as const;

/** The sidebar the subject must be distinguishable *from*: "people also viewed"
 *  and its neighbours. Measured, not assumed — the probe counts these so the
 *  live run can prove they sit outside the subject container. */
export const SIDEBAR_SELECTORS = ["aside", "[role=complementary]"] as const;

/** What the subject's container looked like when the snapshot was taken. */
export type SnapshotContainer = {
  /** The selector that matched, or `null` when none did. */
  selector: string | null;
  /** `outerHTML.length` of the container. */
  chars: number;
  /** `innerText`-ish length, the measure of whether anything actually rendered. */
  textChars: number;
  /** `<section>` elements inside it. A rendered profile has many. */
  sections: number;
  /** Sidebar elements found anywhere in the document. */
  sidebars: number;
  /** Sidebar elements found *inside* the subject container. Non-zero means the
   *  container does not cleanly exclude suggestions and a parser scoped to it
   *  can still read a stranger — the exact D121 failure, one layer up. */
  sidebarsInside: number;
};

/** The raw shape `SNAPSHOT_EXPRESSION` returns. */
export type SnapshotProbe = {
  html: string;
  /** `location.href` at the moment of the snapshot, so a page that navigated
   *  out from under us is visible rather than assumed. */
  url: string;
  htmlChars: number;
  textChars: number;
  container: SnapshotContainer;
};

/**
 * One `Runtime.evaluate`, returning the whole rendered document plus the
 * measurements that say whether it is worth anything.
 *
 * Everything is read in a single round trip on purpose: a container measured in
 * one call and serialized in another describes two different instants, and the
 * warning that says "the subject rendered" would then be about a page other
 * than the one on disk.
 *
 * It never throws. A page that cannot be read returns `null` and the caller
 * warns — the page load is already spent, and a thrown measurement error would
 * discard a snapshot that may well be fine.
 */
export const SNAPSHOT_EXPRESSION = `(() => {
  try {
    var CONTAINERS = ${JSON.stringify(SUBJECT_CONTAINER_SELECTORS)};
    var SIDEBARS = ${JSON.stringify(SIDEBAR_SELECTORS)};
    var root = document.documentElement;
    if (!root) return null;
    var html = root.outerHTML || '';

    var container = null;
    var selector = null;
    for (var i = 0; i < CONTAINERS.length; i++) {
      var found = document.querySelector(CONTAINERS[i]);
      if (found) { container = found; selector = CONTAINERS[i]; break; }
    }

    var sidebarSelector = SIDEBARS.join(',');
    var sidebars = document.querySelectorAll(sidebarSelector).length;
    var sidebarsInside = container ? container.querySelectorAll(sidebarSelector).length : 0;

    var textOf = function (el) {
      if (!el) return 0;
      var t = el.innerText;
      if (typeof t !== 'string') t = el.textContent;
      return typeof t === 'string' ? t.length : 0;
    };

    return {
      html: html,
      url: (document.location && document.location.href) || '',
      htmlChars: html.length,
      textChars: textOf(document.body),
      container: {
        selector: selector,
        chars: container ? (container.outerHTML || '').length : 0,
        textChars: textOf(container),
        sections: container ? container.querySelectorAll('section').length : 0,
        sidebars: sidebars,
        sidebarsInside: sidebarsInside,
      },
    };
  } catch (e) { return null; }
})()`;

const EMPTY_CONTAINER: SnapshotContainer = {
  selector: null, chars: 0, textChars: 0, sections: 0, sidebars: 0, sidebarsInside: 0,
};

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Validates and normalizes whatever came back from the page. Pure, so the
 *  "half-rendered page" branch is provable without a browser. */
export function interpretSnapshot(raw: unknown): SnapshotProbe | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["html"] !== "string" || o["html"] === "") return null;

  const c = (o["container"] ?? {}) as Record<string, unknown>;
  return {
    html: o["html"],
    url: typeof o["url"] === "string" ? o["url"] : "",
    htmlChars: typeof o["htmlChars"] === "number" ? o["htmlChars"] : o["html"].length,
    textChars: num(o["textChars"]),
    container: {
      selector: typeof c["selector"] === "string" ? c["selector"] : null,
      chars: num(c["chars"]),
      textChars: num(c["textChars"]),
      sections: num(c["sections"]),
      sidebars: num(c["sidebars"]),
      sidebarsInside: num(c["sidebarsInside"]),
    },
  };
}

/**
 * Whether this snapshot is worth writing a parser against.
 *
 * Two conditions, and both are needed. A container that exists proves the shell
 * mounted; a container carrying text and sections proves the content inside it
 * rendered. LinkedIn's shell mounts `main#workspace` long before anything fills
 * it, so the first alone certifies an empty page as a fixture.
 */
export function isSubjectRendered(container: SnapshotContainer): boolean {
  return (
    container.selector !== null &&
    container.textChars >= SUBJECT_CONTAINER_MIN_TEXT &&
    container.sections >= SUBJECT_CONTAINER_MIN_SECTIONS
  );
}

/** Why a snapshot did not land. One code per distinct operator action: a page
 *  that would not answer is a different problem from an archive that would not
 *  take the answer. */
export type SnapshotFailure = "probe-failed" | "archive-failed";

export type DomSnapshotResult = {
  /** The archive record, when the html reached disk. */
  archived: ArchivedCapture | null;
  probe: SnapshotProbe | null;
  /** `isSubjectRendered` over the probe, or false when there is no probe. */
  rendered: boolean;
  failure: SnapshotFailure | null;
  /** The underlying error text, for the receipt's evidence. Never the html. */
  detail: string | null;
};

/** The slice of `WorkerTab` this needs. */
export type SnapshotTab = {
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
};

/** The slice of `RawArchive` this needs. */
export type SnapshotArchive = {
  archive(input: {
    body: string | Uint8Array;
    url: string;
    status: number;
    method?: string;
    pattern?: string;
    contentType?: string;
  }): Promise<ArchivedCapture>;
};

/**
 * Takes the snapshot and archives it, raw-first (D2), exactly like a tapped
 * body — but recorded distinctly, because it is not one: `status: 0` says no
 * server answered this, and the `dom-snapshot` pattern plus the synthetic url
 * say where it did come from.
 *
 * Never throws. Both of its failure modes end up on the receipt as warnings
 * instead, for the same reason `readLikeAHuman` does not throw: by the time
 * this runs the page load is already spent, and a capture that archived 26
 * response bodies and no snapshot is still worth more than a halt.
 */
export async function captureDomSnapshot(o: {
  tab: SnapshotTab;
  archive: SnapshotArchive;
  /** The canonical target url, for the snapshot's synthetic archive url. */
  targetUrl: string;
  timeoutMs?: number;
}): Promise<DomSnapshotResult> {
  let probe: SnapshotProbe | null = null;
  try {
    probe = interpretSnapshot(await o.tab.evaluate<unknown>(SNAPSHOT_EXPRESSION, o.timeoutMs));
  } catch (cause) {
    return {
      archived: null, probe: null, rendered: false,
      failure: "probe-failed", detail: String(cause),
    };
  }
  if (probe === null) {
    return {
      archived: null, probe: null, rendered: false,
      failure: "probe-failed",
      detail: "the page returned no serializable document",
    };
  }

  const rendered = isSubjectRendered(probe.container);

  // Archived whether or not it rendered. A short snapshot is evidence about the
  // page, and discarding it would leave the warning with nothing behind it.
  try {
    const archived = await o.archive.archive({
      body: probe.html,
      url: domSnapshotUrl(o.targetUrl),
      status: 0,
      method: "DOM",
      pattern: DOM_SNAPSHOT_PATTERN,
      contentType: "text/html; charset=utf-8",
    });
    return { archived, probe, rendered, failure: null, detail: null };
  } catch (cause) {
    return {
      archived: null, probe, rendered,
      failure: "archive-failed",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}
