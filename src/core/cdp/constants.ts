/**
 * Default ceiling for one command. Chrome answers most calls in single-digit
 * milliseconds; anything past this means the tab or the browser is wedged, and
 * waiting longer only delays the back-off.
 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** How long a WebSocket handshake may take before the endpoint counts as down. */
export const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Keepalive cadence. The timer fires this often but only puts a frame on the
 * wire when nothing else has, so a busy run never pays for a redundant probe.
 */
export const KEEPALIVE_INTERVAL_MS = 30_000;

/** A keepalive that goes unanswered this long means the connection is gone. */
export const KEEPALIVE_TIMEOUT_MS = 10_000;

/**
 * The keepalive command. `Browser.getVersion` is browser-scoped, side-effect
 * free, and — the point — enables no domain: it is the cheapest frame that
 * proves the socket still round-trips without widening the attach surface (D8).
 */
export const KEEPALIVE_METHOD = "Browser.getVersion";

/**
 * Ceiling on one inbound frame. Set explicitly rather than inherited: a body or
 * a DOM snapshot is the largest thing that ever crosses this socket, and a cap
 * that bites would fail precisely on the biggest, most valuable pages. `ws`
 * would otherwise default to 100 MB.
 */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024;
