import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { SCROLLER_SELECTION_JS } from "../profile.capture/read.js";
import { MAX_ATTRIBUTE_CHARS } from "./constants.js";
import { SEARCH_RESULT_PATTERNS } from "./patterns.js";

/**
 * The one click this toolkit performs: a pagination control.
 *
 * Granted by **D400** (operator, 2026-08-11) after D352 measured that Sales
 * Navigator's pager renders 12 buttons and 0 anchors — no href carries `page=N`
 * and the address bar never produces one, so page 2 is unreachable without a
 * click. Every constraint in this file is a clause of that grant rather than a
 * style choice:
 *
 * - **Only a pagination control, only inside a pager.** The candidate must be a
 *   descendant of the pager container and its accessible name must match the
 *   allowlist below. Nothing else on any page is clickable.
 * - **Resolved or refused, never guessed** (the D127/D130 shape). Zero matches
 *   is a refusal; two matches that cannot be told apart is a refusal. There is
 *   no "closest match" branch, deliberately.
 * - **Disabled means the page does not exist.** A `disabled` or `aria-disabled`
 *   control is a stop, not something to click and see.
 * - **A trusted click.** `HumanCursor` dispatches a real pointer path, settle,
 *   press and release. `element.click()` is never used anywhere: a synthetic DOM
 *   click carries `isTrusted: false` and arrives with no preceding pointer
 *   traffic, which is a louder signal than not clicking at all.
 * - **Wheel, never `scrollIntoView`.** Bringing the control into view is a
 *   scroll like any other and obeys §8.
 *
 * What this file deliberately does **not** do: decide whether the click
 * worked. The pager's own label advances on a re-render that changed no rows, so
 * arrival is read from the response body's paging offsets (D400 clause 6),
 * which is the caller's job.
 */

/** Which control to press. Numbered page buttons are granted by D400 too, and
 *  are not implemented here because nothing in M5 needs to jump. */
export type PagerDirection = "next" | "prev";

/**
 * Accessible names that identify a pagination control, per direction.
 *
 * Anchored (`^…$`) rather than substring-matched: "next" as a substring also
 * matches "next steps" and "view next lead", and a loose match here is a click
 * on something nobody approved.
 */
export const PAGER_CONTROL_NAMES: Record<PagerDirection, RegExp> = {
  next: /^(next|next page|go to next page)$/i,
  prev: /^(prev|previous|previous page|go to previous page)$/i,
};

/** The pager container, in preference order. Shared with `surface.ts` so the
 *  element this clicks inside is the same one the measurement described. */
export const PAGER_SELECTORS = [
  ".artdeco-pagination",
  '[data-testid*="pagination"]',
  '[class*="pagination"]',
] as const;

/**
 * Whether the control is clickable is decided by a **hit test**, not by a margin.
 *
 * The first live run refused here, correctly and uselessly: the reveal read
 * called the control out of view because its centre sat within 80px of the
 * viewport's bottom edge, and the pager lives at the bottom of
 * `div#search-results-container`, which the page read had already scrolled to
 * the end of. Nothing could move, so three wheel passes changed nothing and the
 * click was refused — a rule that fires on the page's normal resting state.
 *
 * `document.elementFromPoint` answers the question the margin was proxying for:
 * *does the pixel we are about to press belong to this control?* A control under
 * a sticky overlay fails it, a control 10px from the bottom edge passes it, and
 * neither answer is a guess about layout.
 */
export const HIT_TEST = true;

/** A reveal pass that moves the control less than this has not moved it. Stops
 *  the loop wheeling against a scroller that is already at its end. */
export const REVEAL_PROGRESS_PX = 4;

/** Wheel-and-retry attempts before the control is declared unreachable. */
export const MAX_REVEAL_ATTEMPTS = 3;

export type ControlLocation = {
  /** How many controls in the pager matched the allowlist. Anything but 1 is a
   *  refusal — this is reported so the receipt says *which* refusal. */
  matches: number;
  /** The matched control's accessible name, clamped. LinkedIn's own UI string,
   *  not a third party's data. */
  name: string | null;
  tag: string | null;
  disabled: boolean;
  /** Viewport coordinates of the control's centre. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** True when the centre is inside the viewport **and** the pixel at that
   *  centre belongs to this control — the hit test, not a margin. */
  inView: boolean;
  /** True when the centre is inside the viewport but the pixel at it belongs to
   *  something else: an overlay, a sticky bar, a modal. Distinguished from
   *  simply being off-screen because scrolling does not fix it. */
  obscured: boolean;
  viewportWidth: number;
  viewportHeight: number;
  /** Centre of the element that scrolls this surface, for aiming the wheel —
   *  a wheel outside the results scroller scrolls the wrong box (D298). */
  scrollerX: number;
  scrollerY: number;
};

function refusal(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false, message,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

/**
 * The single `Runtime.evaluate` that locates the control.
 *
 * One round trip, for `surfaceExpression`'s reason: a rect measured in one call
 * and clicked after another describes a page that may have re-laid out in
 * between, and this one ends in a real click.
 *
 * It never throws — an unreadable page returns `null` and the caller refuses.
 */
export function pagerControlExpression(direction: PagerDirection): string {
  return `(() => {
  try {
    var NAMES = ${JSON.stringify(PAGER_CONTROL_NAMES[direction].source)};
    var re = new RegExp(NAMES, 'i');
    var SELECTORS = ${JSON.stringify([...PAGER_SELECTORS])};

    var pager = null;
    for (var s = 0; s < SELECTORS.length && !pager; s++) {
      pager = document.querySelector(SELECTORS[s]);
    }
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;

    var scroller = ${SCROLLER_SELECTION_JS}();
    var sx = vw / 2, sy = vh / 2;
    if (scroller) {
      try {
        var sr = scroller.getBoundingClientRect();
        sx = sr.left + sr.width / 2;
        sy = sr.top + sr.height / 2;
      } catch (e1) { /* detached */ }
    }

    var base = {
      matches: 0, name: null, tag: null, disabled: false,
      x: 0, y: 0, width: 0, height: 0, inView: false, obscured: false,
      viewportWidth: vw, viewportHeight: vh, scrollerX: sx, scrollerY: sy,
    };
    if (!pager) return base;

    // The accessible name, in the order a screen reader would resolve it.
    var nameOf = function (el) {
      var v = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
      return v.replace(/\\s+/g, ' ').trim();
    };

    var hits = [];
    var controls = pager.querySelectorAll('button, a');
    for (var c = 0; c < controls.length; c++) {
      if (re.test(nameOf(controls[c]))) hits.push(controls[c]);
    }
    base.matches = hits.length;
    if (hits.length !== 1) return base;

    var el = hits[0];
    var r = el.getBoundingClientRect();
    var cx = r.left + r.width / 2;
    var cy = r.top + r.height / 2;
    base.name = nameOf(el).slice(0, 200);
    base.tag = (el.tagName || '').toLowerCase();
    base.disabled = !!(el.disabled || el.getAttribute('aria-disabled') === 'true');
    base.x = cx; base.y = cy; base.width = r.width; base.height = r.height;

    // The hit test: does the pixel we would press belong to this control? A
    // margin cannot answer that — it rejects a control resting legitimately at
    // the bottom of a scrolled-to-the-end list, and accepts one buried under a
    // modal in the middle of the screen.
    var onScreen = r.width > 0 && r.height > 0 && cx >= 0 && cx < vw && cy >= 0 && cy < vh;
    var hit = false;
    if (onScreen) {
      try {
        var top = document.elementFromPoint(cx, cy);
        hit = !!top && (top === el || el.contains(top));
      } catch (e2) { hit = false; }
    }
    base.inView = onScreen && hit;
    base.obscured = onScreen && !hit;
    return base;
  } catch (e) { return null; }
})()`;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Validates whatever the page answered. Pure and total, so every refusal branch
 * is provable without a browser — and so the bounds are enforced here rather
 * than trusted to a page we do not control.
 */
export function interpretControl(raw: unknown): ControlLocation | null {
  if (raw === null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = typeof o["name"] === "string" && o["name"] !== ""
    ? o["name"].slice(0, MAX_ATTRIBUTE_CHARS)
    : null;
  const tag = typeof o["tag"] === "string" && o["tag"] !== "" ? o["tag"].slice(0, 32) : null;
  return {
    matches: Math.max(0, Math.trunc(num(o["matches"]))),
    name,
    tag,
    disabled: o["disabled"] === true,
    x: num(o["x"]),
    y: num(o["y"]),
    width: num(o["width"]),
    height: num(o["height"]),
    inView: o["inView"] === true,
    obscured: o["obscured"] === true,
    viewportWidth: num(o["viewportWidth"]),
    viewportHeight: num(o["viewportHeight"]),
    scrollerX: num(o["scrollerX"]),
    scrollerY: num(o["scrollerY"]),
  };
}

/**
 * Turns a located control into the refusal it deserves, or `null` when it is
 * clickable.
 *
 * Separate from the locating so the whole decision table is testable with no
 * browser and no cursor: this function is where "resolved or refused" lives.
 */
export function controlRefusal(
  location: ControlLocation | null,
  direction: PagerDirection,
): CapabilityError | null {
  if (location === null) {
    return refusal("PAGER_UNREADABLE", `the page would not answer where its ${direction} control is`);
  }
  if (location.matches === 0) {
    return refusal(
      "PAGER_CONTROL_NOT_FOUND",
      `no control inside the pager has an accessible name matching ${direction} — refusing to click ` +
        `anything else on the page (D400)`,
    );
  }
  if (location.matches > 1) {
    return refusal(
      "PAGER_CONTROL_AMBIGUOUS",
      `${location.matches} controls inside the pager match ${direction}; a click is resolved or ` +
        `refused, never guessed (D400)`,
      `matches=${location.matches}`,
    );
  }
  if (location.disabled) {
    return refusal(
      "PAGER_CONTROL_DISABLED",
      `the ${direction} control is disabled — the page it would reach does not exist, so this is a ` +
        `stop rather than a click to attempt`,
      location.name ?? undefined,
    );
  }
  if (location.width <= 0 || location.height <= 0) {
    return refusal(
      "PAGER_CONTROL_NOT_RENDERED",
      `the ${direction} control has no box, so nothing on screen corresponds to it`,
    );
  }
  return null;
}

/** The slice of the tab this needs. */
export type PagerTab = { evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> };

/** The slice of `HumanCursor` this needs. */
export type PagerCursor = {
  click(x: number, y: number, opts?: { clickCount?: number }): Promise<{ x: number; y: number }>;
  wheel(x: number, y: number, deltaY: number, opts?: { maxNotches?: number }): Promise<unknown>;
  pause(min?: number, max?: number): Promise<number>;
};

export type ClickReport = {
  direction: PagerDirection;
  /** The control's accessible name — LinkedIn's own UI string. */
  control: string | null;
  tag: string | null;
  /** How many wheel passes it took to bring the control into view. */
  revealPasses: number;
  x: number;
  y: number;
};

/**
 * Locate, reveal, click. The only click in the toolkit.
 *
 * Refuses rather than improvises at every step: an unreadable page, no match,
 * more than one match, a disabled control, or a control that will not come into
 * view inside `MAX_REVEAL_ATTEMPTS` all raise instead of clicking approximately.
 *
 * Returns what it pressed. It does **not** report whether the page advanced —
 * that is read from the response body (D400 clause 6), because a pager label can
 * advance on a re-render that changed no rows.
 */
export async function clickPagerControl(o: {
  tab: PagerTab;
  cursor: PagerCursor;
  direction: PagerDirection;
  timeoutMs?: number;
}): Promise<ClickReport> {
  const locate = async (): Promise<ControlLocation | null> =>
    interpretControl(await o.tab.evaluate<unknown>(pagerControlExpression(o.direction), o.timeoutMs));

  let location = await locate();
  let refused = controlRefusal(location, o.direction);
  if (refused) throw refused;

  let passes = 0;
  while (location !== null && !location.inView && !location.obscured && passes < MAX_REVEAL_ATTEMPTS) {
    // Toward the control, aimed inside the box that actually scrolls.
    const before = location.y;
    const delta = Math.round(location.y - location.viewportHeight / 2);
    if (delta === 0) break;
    await o.cursor.wheel(location.scrollerX, location.scrollerY, delta);
    await o.cursor.pause();
    passes++;
    location = await locate();
    refused = controlRefusal(location, o.direction);
    if (refused) throw refused;
    // A scroller already at its end does not move, and wheeling it again will
    // not either. Stop rather than spend the remaining passes proving it.
    if (location !== null && Math.abs(location.y - before) < REVEAL_PROGRESS_PX) break;
  }

  if (location !== null && location.obscured) {
    throw refusal(
      "PAGER_CONTROL_OBSCURED",
      `the ${o.direction} control is on screen but the pixel at its centre belongs to something else — ` +
        `an overlay, a sticky bar or a modal. Clicking it would click that instead, so this stops`,
      `at ${Math.round(location.x)},${Math.round(location.y)} of ${location.viewportWidth}x${location.viewportHeight}`,
    );
  }
  if (location === null || !location.inView) {
    throw refusal(
      "PAGER_CONTROL_OFFSCREEN",
      `the ${o.direction} control would not come into view after ${passes} wheel pass(es); a click at ` +
        `coordinates the pointer cannot actually reach is a click on whatever is there instead`,
      location === null
        ? undefined
        : `at ${Math.round(location.x)},${Math.round(location.y)} of ${location.viewportWidth}x${location.viewportHeight}`,
    );
  }

  await o.cursor.click(location.x, location.y);
  return {
    direction: o.direction,
    control: location.name,
    tag: location.tag,
    revealPasses: passes,
    x: location.x,
    y: location.y,
  };
}

/**
 * Which page arrived, and how confident the answer is.
 *
 * `from` exists because the first accounts run got this wrong. The rule was
 * "largest non-document body", and on `/sales/search/company` the largest is
 * `salesApiSearchFilterLayout` (81 KB) rather than `salesApiAccountSearch`
 * (53 KB) — and the filter layout carries a `paging` block of its own. The
 * receipt read `count 10` for a page of 25 rows. It happened to be right on the
 * leads surface only because the lead search *is* the biggest body there.
 *
 * A body's size is not its identity. The search endpoint is now chosen by name,
 * and when no named search endpoint answered, the fallback says so rather than
 * presenting a `salesApiLego` offset as the search's own — which matters because
 * D400 clause 6 makes this the arrival check for a clicked page.
 */
export type PagingEvidence = {
  start: number;
  count: number;
  from: "search-body" | "largest-body";
};

/**
 * The paging offsets a captured body claims, if any.
 *
 * D400 clause 6: which page arrived is read from the body, never from the
 * button. This is the **only** body read the probe performs, and it reads two
 * integers — `paging.start` and `paging.count` — and nothing else. No row, no
 * name, no urn: those are Task 38's, offline, from the archive.
 *
 * Bounded and total: a body that carries no paging block yields `null`.
 */
export function pagingFromCaptures(
  captures: readonly { body: string; bytes: number; patterns: readonly string[] }[],
  /** The watch name of this surface's own document response, excluded. */
  excludePattern: string,
): PagingEvidence | null {
  const usable = captures.filter((c) => !c.patterns.includes(excludePattern));
  // The search endpoint by name, first. Size is not identity: on the accounts
  // surface `salesApiSearchFilterLayout` is 81 KB against the account search's
  // 53 KB, and it carries a `paging` block of its own — reading it reported
  // `count 10` for a page of 25 rows. See below.
  const search = usable
    .filter((c) => c.patterns.some((p) => (SEARCH_RESULT_PATTERNS as readonly string[]).includes(p)))
    .sort((a, b) => b.bytes - a.bytes);
  for (const capture of search) {
    const paging = pagingOffsetOf(capture.body);
    if (paging !== null) return { ...paging, from: "search-body" };
  }
  // Nothing matched a named search endpoint. Largest body, and the receipt says
  // the evidence is indirect rather than presenting it as the search's own.
  const rest = usable.slice().sort((a, b) => b.bytes - a.bytes);
  for (const capture of rest) {
    const paging = pagingOffsetOf(capture.body);
    if (paging !== null) return { ...paging, from: "largest-body" };
  }
  return null;
}

export function pagingOffsetOf(body: string): { start: number; count: number } | null {
  const block = /"paging"\s*:\s*\{[^{}]*\}/.exec(body);
  if (block === null) return null;
  const start = /"start"\s*:\s*(\d{1,7})/.exec(block[0]);
  const count = /"count"\s*:\s*(\d{1,7})/.exec(block[0]);
  if (start?.[1] === undefined || count?.[1] === undefined) return null;
  return { start: Number(start[1]), count: Number(count[1]) };
}
