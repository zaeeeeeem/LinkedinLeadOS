/** The worker tab is born blank and navigated afterwards, so nothing loads before
 *  focus emulation and the network tap are in place (D10). */
export const WORKER_TAB_START_URL = "about:blank";

/**
 * Network buffers, raised well above Chrome's defaults. The tap reads response
 * bodies back with `Network.getResponseBody` *after* the fact, so a body evicted
 * from the buffer is a capture that silently returns nothing — carried forward
 * from the reference worker, which lost profile bodies on long runs at the
 * default sizes.
 */
export const NETWORK_RESOURCE_BUFFER_BYTES = 20_000_000;
export const NETWORK_TOTAL_BUFFER_BYTES = 100_000_000;

/**
 * How long a navigation may take to reach `document.readyState === "complete"`.
 * Generous: LinkedIn on a cold profile is slow, and the cost of a false timeout
 * is a wasted page load on a metered account.
 */
export const NAVIGATE_TIMEOUT_MS = 45_000;

/** Gap between readyState polls. Page events are unavailable by design — `Page.enable`
 *  is forbidden (D8) — so readiness is polled rather than awaited. */
export const READY_POLL_INTERVAL_MS = 100;

/** Time for a visibility change to land in the page before re-reading it. */
export const FOREGROUND_SETTLE_MS = 150;

/** Ceiling on any single teardown step. A dying Chrome must not hold the run open. */
export const TEARDOWN_STEP_TIMEOUT_MS = 1_000;
