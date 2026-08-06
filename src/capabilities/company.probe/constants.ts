/**
 * The probe's own tunables.
 *
 * Everything about *pacing* — scroll passes, pauses, dwell — is deliberately
 * `profile.capture`'s (`../profile.capture/constants.js`) and is not restated
 * here. Those numbers are the shape of a human reading a page on the one
 * account that cannot be burned; a second set of them for a second surface
 * would be a second fingerprint to keep in sync.
 */

/**
 * The hard ceiling on page loads for one probe invocation, from the task's own
 * stated budget: five sub-pages plus one spare (CONTEXT rule 8).
 *
 * It is not a `--budget` flag and cannot be raised by one. A probe that wants
 * another load is a checkpoint for the operator to record, not a loop to run.
 */
export const PROBE_MAX_PAGE_LOADS = 6;

/**
 * How long to wait for a sub-page's first LinkedIn api response before
 * recording that it issued none.
 *
 * Shorter than `profile.capture`'s 25s because the outcome here is different:
 * there, no response means the capture failed and the wait is worth the
 * seconds; here, "this sub-page fetches nothing" is a **finding** the probe
 * exists to record, and the document response and the DOM snapshot are still
 * collected either way.
 */
export const SUBPAGE_API_TIMEOUT_MS = 15_000;

/** How long the surface measurement's single `Runtime.evaluate` may take. */
export const SURFACE_TIMEOUT_MS = 20_000;

/**
 * How many endpoint rows reach the receipt, per sub-page.
 *
 * Lower than `profile.capture`'s 40 because there are up to five sub-pages on
 * one receipt. The full table is in the raw archive's sidecars; stdout is a
 * bounded envelope (§4.1, D3).
 */
export const RECEIPT_ENDPOINTS_PER_SUBPAGE = 12;
