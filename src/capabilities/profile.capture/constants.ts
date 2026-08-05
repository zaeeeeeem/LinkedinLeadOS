/**
 * Every tunable of the capture, in one file.
 *
 * These are pacing numbers on the one account that cannot be burned. They exist
 * to make a scripted profile view indistinguishable from a human one: nobody
 * loads a profile, reads nothing, and closes it in 400ms, and nobody scrolls a
 * page in a single 4000px jump. Widening or narrowing one is a safety decision.
 */

/** Scroll passes down the page when the caller does not name a number. */
export const SCROLL_PASSES_MIN = 3;
export const SCROLL_PASSES_MAX = 6;

/** One pass, as a fraction of the viewport height. Under 1.0 most of the time:
 *  a reader overlaps what they have already seen rather than jumping past it. */
export const SCROLL_FRACTION_MIN = 0.55;
export const SCROLL_FRACTION_MAX = 1.15;

/** Where in the viewport the pointer sits while scrolling, as a fraction. A
 *  wheel event at (0, 0) scrolls a different element than one in the middle. */
export const POINTER_FRACTION_MIN = 0.3;
export const POINTER_FRACTION_MAX = 0.7;

/** Between two scroll passes: the time spent looking at what just appeared. */
export const SCROLL_PAUSE_MS_MIN = 700;
export const SCROLL_PAUSE_MS_MAX = 2_400;

/** The chance a pass goes back up instead of down. People re-read. */
export const SCROLL_BACK_PROBABILITY = 0.25;

/** The pause after the last scroll, before the run declares itself done. */
export const DWELL_MS_MIN = 1_800;
export const DWELL_MS_MAX = 5_000;

/**
 * How long to wait for the page to actually lay out before measuring it.
 *
 * `WorkerTab.navigate` resolves on `document.readyState === "complete"`, which on
 * LinkedIn fires while the SPA is still an empty shell — the first live run
 * measured `scrollHeight === innerHeight === 798` and therefore scrolled nothing,
 * so no lazy section ever fetched and the capture held the profile's urn and
 * nothing else. Readiness is not layout. Polling the document height until it
 * exceeds the viewport and stops growing is a render-confirmation DOM read,
 * which is one of the four D1 permits.
 */
export const LAYOUT_TIMEOUT_MS = 15_000;
export const LAYOUT_POLL_MS = 400;
/** Consecutive identical heights that count as "it has stopped growing". */
export const LAYOUT_STABLE_READS = 2;

/** Fallback viewport when the page cannot be measured. Only the wheel target
 *  point depends on it, and a wrong point still scrolls the document. */
export const FALLBACK_VIEWPORT = { width: 1280, height: 800 } as const;

/**
 * How long to wait for the first LinkedIn API response after navigation.
 *
 * Generous on purpose: the failure this guards is "the page rendered but we saw
 * nothing", and the cost of waiting is seconds while the cost of giving up early
 * is a spent page load with an empty archive.
 */
export const FIRST_CAPTURE_TIMEOUT_MS = 25_000;

/**
 * How long to keep the tap open after the last scroll, letting late fetches land.
 *
 * The tap is passive, so this costs nothing but time — no request is made and no
 * budget is spent. Lazy sections (experience, education, skills) fetch on
 * intersection, and the fetch lands after the scroll that triggered it.
 */
export const SETTLE_MS_MIN = 2_200;
export const SETTLE_MS_MAX = 4_000;
