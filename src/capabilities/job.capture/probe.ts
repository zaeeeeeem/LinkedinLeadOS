/**
 * The description-truncation measurement.
 *
 * A job detail page shows a long description behind a "see more" control, and
 * §7's `jobs.description` needs the whole thing. Whether that control is a CSS
 * toggle over text already in the DOM, or a button that fetches the rest,
 * decides everything about `job.get` (Task 31) — a toggle means the archived
 * snapshot already holds the full description and no interaction is ever
 * needed; a fetch means the field cannot be had without one.
 *
 * That question is answered **passively**, without clicking anything. A control
 * that only unclamps text measures as a block whose `scrollHeight` far exceeds
 * its `clientHeight` while its computed style clamps it; a control that fetches
 * measures as a short block, unclamped, usually ending in an ellipsis. Clicking
 * would answer it too, and would also be an interaction with the page on the one
 * account — so it is the operator's decision to authorize, not this probe's to
 * take (see the capability's README).
 *
 * Nothing here reads a job *field*. It measures shapes and counts: how many
 * controls, how many clamped blocks, how big the biggest text block is. The
 * fields themselves are addressed later, from the archived snapshot, and only
 * once the operator has extended `CLAUDE.md`'s DOM exception to this surface.
 */

/** Elements walked before the measurement gives up and says so. A job page is
 *  a few thousand elements; anything past this is not a page this measures. */
export const MAX_ELEMENTS = 20_000;

/** An element with more children than this is a layout container, not a block
 *  of text. Without the bound the "largest text block" is always `<body>`. */
export const MAX_CHILDREN_FOR_TEXT_BLOCK = 12;

/** How far `scrollHeight` must exceed `clientHeight` before a block counts as
 *  holding hidden text rather than as a rounding difference. */
export const CLAMP_SLACK_PX = 40;

/** The biggest block of text on the page, and how it is presented. */
export type TextBlock = {
  chars: number;
  tag: string;
  /** SDUI component key, when the element carries one — the only addressing on
   *  these pages that survives a restyle. */
  componentkey: string | null;
  id: string | null;
  clientHeight: number;
  scrollHeight: number;
  /** True when the computed style hides the overflow — `-webkit-line-clamp` or
   *  `overflow: hidden` on a block taller than its box. */
  clamped: boolean;
  /** True when the visible text ends in an ellipsis, which is what a
   *  server-truncated string looks like. */
  endsWithEllipsis: boolean;
};

export type ExpanderProbe = {
  /** Controls whose label is a "see more"/"show more"/"read more" variant. */
  seeMoreControls: number;
  /** Blocks whose overflow is hidden while their content is taller than the box. */
  clampedBlocks: number;
  largest: TextBlock | null;
  /** `document.body` text length, for scale. */
  textChars: number;
  elementsWalked: number;
  /** True when the walk stopped at `MAX_ELEMENTS`: the numbers describe a prefix
   *  of the page, not all of it, and the verdict below must not be trusted. */
  truncated: boolean;
};

/**
 * One `Runtime.evaluate`. Everything is measured in a single round trip for the
 * reason the snapshot is: two round trips describe two different instants, and
 * the verdict would then be about a page other than the one on disk.
 *
 * It never throws — a page that cannot be measured returns `null` and the caller
 * warns, because the page load is already spent.
 */
export const EXPANDER_EXPRESSION = `(() => {
  try {
    var MAX = ${MAX_ELEMENTS};
    var MAX_CHILDREN = ${MAX_CHILDREN_FOR_TEXT_BLOCK};
    var SLACK = ${CLAMP_SLACK_PX};
    var MORE = /\\b(see|show|read)\\s+more\\b|…\\s*more\\b/i;

    var all = document.querySelectorAll('*');
    var limit = all.length > MAX ? MAX : all.length;
    var seeMore = 0;
    var clampedBlocks = 0;
    var largest = null;

    for (var i = 0; i < limit; i++) {
      var el = all[i];
      var tag = (el.tagName || '').toLowerCase();
      var text = typeof el.textContent === 'string' ? el.textContent : '';
      var trimmed = text.replace(/\\s+/g, ' ').trim();

      var role = el.getAttribute ? el.getAttribute('role') : null;
      if ((tag === 'button' || tag === 'a' || role === 'button') && trimmed.length <= 40 && MORE.test(trimmed)) {
        seeMore++;
      }

      var style = null;
      try { style = getComputedStyle(el); } catch (e) { style = null; }
      var hidden = style ? (style.overflowY === 'hidden' || style.overflow === 'hidden' ||
        (style.webkitLineClamp && style.webkitLineClamp !== 'none')) : false;
      var over = (el.scrollHeight || 0) > (el.clientHeight || 0) + SLACK;
      if (hidden && over) clampedBlocks++;

      var children = typeof el.childElementCount === 'number' ? el.childElementCount : 0;
      if (children <= MAX_CHILDREN && (largest === null || trimmed.length > largest.chars)) {
        largest = {
          chars: trimmed.length,
          tag: tag,
          componentkey: el.getAttribute ? el.getAttribute('componentkey') : null,
          id: el.id || null,
          clientHeight: el.clientHeight || 0,
          scrollHeight: el.scrollHeight || 0,
          clamped: !!(hidden && over),
          endsWithEllipsis: /(…|\\.\\.\\.)$/.test(trimmed),
        };
      }
    }

    var bodyText = document.body && typeof document.body.textContent === 'string'
      ? document.body.textContent : '';
    return {
      seeMoreControls: seeMore,
      clampedBlocks: clampedBlocks,
      largest: largest,
      textChars: bodyText.length,
      elementsWalked: limit,
      truncated: all.length > MAX,
    };
  } catch (e) { return null; }
})()`;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Validates and normalizes whatever came back from the page. Pure, so every
 *  branch of the verdict below is provable without a browser. */
export function interpretExpanderProbe(raw: unknown): ExpanderProbe | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o["elementsWalked"] !== "number") return null;

  const l = o["largest"];
  const largest: TextBlock | null =
    l === null || typeof l !== "object"
      ? null
      : {
          chars: num((l as Record<string, unknown>)["chars"]),
          tag: str((l as Record<string, unknown>)["tag"]) ?? "",
          componentkey: str((l as Record<string, unknown>)["componentkey"]),
          id: str((l as Record<string, unknown>)["id"]),
          clientHeight: num((l as Record<string, unknown>)["clientHeight"]),
          scrollHeight: num((l as Record<string, unknown>)["scrollHeight"]),
          clamped: (l as Record<string, unknown>)["clamped"] === true,
          endsWithEllipsis: (l as Record<string, unknown>)["endsWithEllipsis"] === true,
        };

  return {
    seeMoreControls: num(o["seeMoreControls"]),
    clampedBlocks: num(o["clampedBlocks"]),
    largest,
    textChars: num(o["textChars"]),
    elementsWalked: num(o["elementsWalked"]),
    truncated: o["truncated"] === true,
  };
}

/**
 * What the measurement says about where the full description lives.
 *
 * - `dom-toggle` — the text is already in the DOM, clamped by CSS. The archived
 *   snapshot holds all of it and `job.get` needs no interaction.
 * - `likely-request` — the visible text is short, unclamped and ellipsised while
 *   a "see more" control exists, which is what a server-truncated string behind
 *   a fetch looks like. `job.get` cannot have the full description passively.
 * - `not-truncated` — no control, nothing clamped: what is rendered is all there is.
 * - `unknown` — anything else, including a walk that hit its bound. Deliberately
 *   a verdict of its own rather than a default: this measurement exists to make
 *   Task 31's decision, and "we could not tell" must not read as "no fetch".
 */
export type DescriptionVerdict = "dom-toggle" | "likely-request" | "not-truncated" | "unknown";

export function descriptionVerdict(probe: ExpanderProbe | null): DescriptionVerdict {
  if (probe === null || probe.truncated) return "unknown";
  const l = probe.largest;
  if (l === null) return "unknown";
  if (l.clamped && l.scrollHeight > l.clientHeight + CLAMP_SLACK_PX) return "dom-toggle";
  if (probe.clampedBlocks > 0 && probe.seeMoreControls > 0) return "dom-toggle";
  if (probe.seeMoreControls > 0 && l.endsWithEllipsis && !l.clamped) return "likely-request";
  // `!l.clamped` as well as the aggregate: a largest block that is itself clamped
  // while the page-wide count says nothing is, is a contradiction, and "nothing
  // is hidden" is the one answer it must not resolve to.
  if (probe.seeMoreControls === 0 && probe.clampedBlocks === 0 && !l.clamped) return "not-truncated";
  return "unknown";
}

/** The slice of `WorkerTab` this needs. */
export type ProbeTab = {
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
};

/** Runs the measurement. Never throws: a failure here costs the verdict, not
 *  the capture, and the caller turns `null` into a visible warning. */
export async function measureExpander(
  tab: ProbeTab,
  timeoutMs?: number,
): Promise<ExpanderProbe | null> {
  try {
    return interpretExpanderProbe(await tab.evaluate<unknown>(EXPANDER_EXPRESSION, timeoutMs));
  } catch {
    return null;
  }
}
