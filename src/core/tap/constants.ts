/**
 * Ceiling on one `Network.getResponseBody` round-trip. Short on purpose: the
 * body is already sitting in Chrome's buffer by the time we ask for it, so a
 * slow answer means the tab is wedged, and every millisecond spent waiting is
 * a millisecond closer to the buffer evicting it.
 */
export const BODY_FETCH_TIMEOUT_MS = 10_000;

/**
 * Default ceiling for `waitFor`. A watched response that never arrives must
 * fail as a bounded wait, never hang — a hung capability holds the tab lease
 * and burns the run.
 */
export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/**
 * How many request ids the tap remembers for events that arrived before their
 * `Network.responseReceived` (finish-before-response) and for the HTTP method
 * of a matching request. CDP event order is not guaranteed across event types,
 * so these have to be remembered — but a long crawl issues tens of thousands of
 * requests, and an unbounded map is a leak with no upper bound on a process
 * that is expected to run for hours. Oldest ids are dropped first.
 */
export const SEEN_REQUEST_CAP = 500;
