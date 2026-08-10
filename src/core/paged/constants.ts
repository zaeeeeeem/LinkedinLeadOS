/**
 * Every tunable of the paged-run loop, in one file — the same rule the human
 * input layer follows. Changing one of these is an account-safety decision, not
 * a tuning convenience.
 */

/** What one results page costs the ledger (D343). Both kinds, deliberately. */
export type PageCost = { page_loads: number; search_pages: number };

export const RESULTS_PAGE_COST: PageCost = { page_loads: 1, search_pages: 1 };

export const ZERO_PAGE_COST: PageCost = { page_loads: 0, search_pages: 0 };

/**
 * The hard ceiling on pages one invocation may load, whatever `--limit` asks
 * for. A paged surface has no natural end a reader can trust, so the loop is
 * bounded by a number that exists before the run does (D325's rule for the
 * feed, applied to searches). It sits at the largest M5 sub-cap, so a single
 * run can at most exhaust one capability's day and never the global 50.
 */
export const MAX_PAGES_PER_RUN = 20;

/**
 * Inter-page dwell, drawn per page — never a fixed cadence (§8).
 *
 * The shape is lifted from the reference worker's `humanDelay`, which arrived
 * at it after a flat uniform draw produced a visibly machine-like gap
 * histogram: mostly a log-normal clustered near the low end (a reader skimming),
 * a small fraction of very short gaps (a glance and a page turn), and a small
 * heavy tail (a reader who stopped to read something). Rewritten typed; the
 * reference worker's own bug is not carried over — its long tail drew from a
 * hardcoded 60–180s band regardless of the configured range, which produced
 * measured 177s gaps on a 5–40s config.
 */
export const PAGE_DWELL_MS_MIN = 8_000;
export const PAGE_DWELL_MS_MAX = 40_000;

/** Probability of the short "glance and turn" draw, and its own band. */
export const PAGE_DWELL_MICRO_PROBABILITY = 0.03;
export const PAGE_DWELL_MICRO_MS_MIN = 1_200;
export const PAGE_DWELL_MICRO_MS_MAX = 5_000;

/** Probability of the heavy tail. It draws from the top of the configured
 *  band — never from a band of its own. */
export const PAGE_DWELL_LONG_PROBABILITY = 0.07;
export const PAGE_DWELL_LONG_FLOOR_PCT = 0.6;

/** Median of the log-normal body, as a fraction into the band, and its sigma. */
export const PAGE_DWELL_MEDIAN_PCT = 0.25;
export const PAGE_DWELL_SIGMA = 0.55;

/** Every this many pages, the dwell is a long break instead — the reference
 *  worker's `batchBreak`. A reader who turns twenty pages without ever putting
 *  the tab down is a script. */
export const PAGE_BREAK_EVERY = 5;
export const PAGE_BREAK_MS_MIN = 90_000;
export const PAGE_BREAK_MS_MAX = 240_000;

/** Nothing the dwell layer draws may exceed this. A mis-set band that stalls a
 *  live run while it holds the tab lease is a worse failure than one dwell
 *  landing short. */
export const PAGE_DWELL_MAX_MS_GUARD = 300_000;

/** The file an operator (or an agent) drops in a run directory to ask a live
 *  paged run to stop cleanly at the next page boundary. Checked before the
 *  spend for the next page, so a paused run never pays for a page it will not
 *  load. */
export const PAUSE_FILE_NAME = "PAUSE";
