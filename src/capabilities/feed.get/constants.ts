/**
 * Tunables for the operator's own `/feed/`. Everything about pacing, layout and
 * snapshots is `profile.capture`'s and is imported from there — one set of
 * pacing numbers on the one account, in one file.
 */

/** The only page this capability ever opens. There is no target to normalize:
 *  the feed is the operator's own, and a url argument would only be a way to
 *  point this reader at a page it was not measured against. */
export const FEED_URL = "https://www.linkedin.com/feed/";

/** How many items a default read asks for. */
export const DEFAULT_FEED_LIMIT = 10;

/**
 * Roughly how many feed cards one scroll pass brings into view. Used only to
 * turn `--limit` into a pass count; it is a pacing estimate, not a promise, and
 * the read is always bounded by `MAX_FEED_PASSES` whatever it says.
 */
export const ITEMS_PER_PASS = 2;

/**
 * The hard ceiling on scroll passes, whatever `--limit` asks for.
 *
 * D320's `untilBottom` is for pages that end. A feed does not, so a
 * bottom-seeking read here would mean "scroll to the ceiling" every single time
 * (D325). The read is bounded by a fixed pass count, and what it did not reach
 * is reported as partial rather than as the whole feed.
 */
export const MAX_FEED_PASSES = 8;

/** The floor, so `--limit=1` still scrolls enough to render more than the
 *  above-the-fold card LinkedIn server-renders. */
export const MIN_FEED_PASSES = 2;

/**
 * How many relevant bodies the probe sweeps for urns. Same bound and same
 * reason as `activity.capture`'s: the sweep is offline work over archived
 * bodies, but a feed page archives dozens of them and each can be a megabyte.
 */
export const MAX_INVENTORIED_BODIES = 40;

/** Turns `--limit` into a bounded pass count. Pure, so the bound is testable
 *  without a browser — which is the only way this gets tested at all. */
export function passesFor(limit: number): number {
  const wanted = Math.ceil(limit / ITEMS_PER_PASS);
  return Math.max(MIN_FEED_PASSES, Math.min(MAX_FEED_PASSES, wanted));
}
