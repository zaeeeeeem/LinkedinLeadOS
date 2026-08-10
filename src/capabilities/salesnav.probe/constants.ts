/**
 * The Sales Navigator probe's own tunables.
 *
 * Pacing is deliberately `profile.capture`'s (`../profile.capture/constants.js`)
 * and is not restated here, for `company.probe`'s reason: those numbers are the
 * shape of a human reading a page on the one account that cannot be burned, and
 * a second set of them for a second surface is a second fingerprint to keep in
 * sync. Sales Navigator is the most defended surface this account will ever
 * touch (M5 CONTEXT rule 3), which is an argument for reusing the proven pacing
 * rather than inventing a faster one.
 */

/**
 * The hard ceiling on page loads for one probe invocation, from the task's own
 * stated budget of 6 page loads / 6 search pages.
 *
 * Not a flag and not raisable by one. A probe that wants another page is a
 * checkpoint for the operator to record, not a loop to run (M5 CONTEXT rule 1:
 * one probe page is 2% of the day's search-page budget).
 */
export const PROBE_MAX_PAGE_LOADS = 6;

/**
 * The ceiling on *metered search pages* for one invocation, tracked separately
 * from page loads because they are separate budgets with separate scarcity.
 *
 * The default surface list spends 3 of these. The gap is deliberate headroom
 * for a second target the operator asks for by name, not for a loop.
 */
export const PROBE_MAX_SEARCH_PAGES = 6;

/**
 * How long to wait for a surface's first LinkedIn response before recording
 * that it issued none.
 *
 * "This surface fetches nothing" is the headline **finding** on a probe, not a
 * failure — the document response and the DOM snapshot land either way. Longer
 * than `company.probe`'s 15s because a Sales Navigator search page is heavier
 * than a company tab and a premature timeout here would produce exactly the
 * wrong verdict on the one question this task exists to answer.
 */
export const SURFACE_API_TIMEOUT_MS = 25_000;

/** How long the structural measurement's single `Runtime.evaluate` may take. */
export const SURFACE_TIMEOUT_MS = 20_000;

/**
 * How many endpoint rows reach the receipt, per surface.
 *
 * The full table is in the raw archive's sidecars; stdout is a bounded envelope
 * (§4.1, D3).
 */
export const RECEIPT_ENDPOINTS_PER_SURFACE = 12;

/**
 * How many result-row shapes the structural measurement may report per surface.
 *
 * The rows themselves are third-party people and companies and **never** reach
 * a receipt (M5 CONTEXT rule 6). What this bounds is the report of *which
 * attributes the rows carry* — names of attributes, counts, and whether a
 * `/sales/lead/` href exists. The values are in the archived snapshot, where
 * the offline sweep reads them.
 */
export const MAX_ROW_ATTRIBUTES = 32;

/** A `data-anonymize` / `data-testid` attribute value. Anything longer than
 *  this is not one, and is a page putting a string on a receipt. */
export const MAX_ATTRIBUTE_CHARS = 120;

/** How many pager controls to describe. A Sales Nav pager shows ~8 numbered
 *  buttons plus next/previous. */
export const MAX_PAGER_CONTROLS = 16;
