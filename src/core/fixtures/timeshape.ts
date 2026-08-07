/**
 * What a timestamp looks like, by shape alone.
 *
 * Task 26 has one question it cannot answer by reading key names: the rendered
 * activity feed shows `3d`, and `person_posts.posted_at` (§7) is an absolute
 * time. Either some source carries an absolute timestamp or none does, and the
 * difference decides whether Tasks 27–29 store a real time or a derived one.
 *
 * So these classifiers are deliberately shape-based and name-free. They make no
 * claim about where LinkedIn puts a timestamp; they say what a value *is*, so
 * the probe can report where such values were found rather than assuming.
 *
 * Pure, offline, and provable against synthetic values — which is what lets the
 * boundaries below be tested rather than trusted.
 */

/**
 * The window a LinkedIn timestamp can plausibly fall in: LinkedIn launched in
 * 2003, and a "timestamp" a decade in the future is an id, a count or a hash
 * that happens to have ten digits.
 *
 * The upper bound is a *duration past now*, not a fixed date, so this file does
 * not quietly stop recognising timestamps at some hardcoded year.
 */
export const EPOCH_MS_FLOOR = Date.UTC(2003, 0, 1);
export const FUTURE_TOLERANCE_MS = 365 * 24 * 60 * 60 * 1000;

/** Epoch milliseconds. LinkedIn's own JSON overwhelmingly uses these. */
export function looksEpochMs(value: number, now: number = Date.now()): boolean {
  return Number.isInteger(value) && value >= EPOCH_MS_FLOOR && value <= now + FUTURE_TOLERANCE_MS;
}

/**
 * Epoch seconds. Reported separately from millis and never merged into them:
 * reading a seconds value as millis puts the post in January 1970, which is a
 * silently wrong date rather than a visible failure.
 */
export function looksEpochSeconds(value: number, now: number = Date.now()): boolean {
  return (
    Number.isInteger(value) &&
    value >= Math.floor(EPOCH_MS_FLOOR / 1000) &&
    value <= Math.floor((now + FUTURE_TOLERANCE_MS) / 1000)
  );
}

/** An ISO-8601 instant, the other absolute form worth finding. */
export const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function looksIso8601(value: string): boolean {
  if (!ISO_8601.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

/**
 * LinkedIn's rendered relative time: `3d`, `2w`, `1mo`, `5h`, and the spelled
 * variants, optionally trailed by the `•` the feed separates them with or by
 * "ago".
 *
 * Anchored on both ends. Unanchored, `1m` matches inside every headline that
 * contains a digit followed by an m, and the probe would report the whole page
 * as a timestamp.
 */
export const RELATIVE_TIME =
  /^\s*(\d{1,3})\s?(s|m|h|d|w|mo|y|sec|min|hr|second|minute|hour|day|week|month|year)s?\b(\s*(ago|•|·))?\s*$/i;

export function looksRelativeTime(text: string): boolean {
  return RELATIVE_TIME.test(text);
}

/** How a value reads as a time. `null` when it does not read as one at all. */
export type TimeShape = "epoch-ms" | "epoch-s" | "iso-8601" | "relative";

/**
 * Classifies one value. Absolute forms are tried before the relative one, and
 * `epoch-ms` before `epoch-s`, because the ranges overlap for values around
 * 2003 only in the seconds interpretation — a 13-digit integer is millis and a
 * 10-digit one is seconds, and the floors above are what separate them.
 */
export function timeShapeOf(value: unknown, now: number = Date.now()): TimeShape | null {
  if (typeof value === "number") {
    if (looksEpochMs(value, now)) return "epoch-ms";
    if (looksEpochSeconds(value, now)) return "epoch-s";
    return null;
  }
  if (typeof value !== "string") return null;
  if (looksIso8601(value)) return "iso-8601";
  if (looksRelativeTime(value)) return "relative";
  // A numeric string is still a timestamp if it reads as one — LinkedIn quotes
  // large integers in some envelopes.
  if (/^\d{10,13}$/.test(value)) {
    const n = Number(value);
    if (looksEpochMs(n, now)) return "epoch-ms";
    if (looksEpochSeconds(n, now)) return "epoch-s";
  }
  return null;
}
