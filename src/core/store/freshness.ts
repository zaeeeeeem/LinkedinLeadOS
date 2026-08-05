import { CapabilityError, EXIT } from "../run/receipt.js";
import { DURATION_GRAMMAR, DURATION_UNITS_MS } from "./constants.js";

/**
 * Freshness is the single largest saving in the design (§7): a row younger than
 * `--max-age` is returned from the store and costs zero page loads. Both halves of
 * that decision live here, pure and offline-testable — nothing in this file touches
 * the network.
 */

const DURATION_RE = /^(\d+)(ms|s|m|h|d)?$/;

function invalidDuration(input: unknown, why: string): CapabilityError {
  return new CapabilityError({
    code: "INVALID_DURATION",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `invalid duration ${JSON.stringify(input)}: ${why} — ${DURATION_GRAMMAR}`,
  });
}

/**
 * Parses the `--max-age` grammar to milliseconds.
 *
 * Anything outside the grammar throws. It is never silently treated as "no
 * max-age" or as the default: a typo'd `--max-age=7days` that quietly became the
 * 7-day default would be indistinguishable from working, and a typo that quietly
 * became 0 would re-fetch every profile against a budget that exists to stop
 * exactly that.
 */
export function parseDuration(input: string | number): number {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw invalidDuration(input, "not a finite number");
    if (!Number.isInteger(input)) throw invalidDuration(input, "not a whole number");
    if (input < 0) throw invalidDuration(input, "negative");
    return input;
  }

  const text = input.trim().toLowerCase();
  const m = DURATION_RE.exec(text);
  if (!m) throw invalidDuration(input, text.length === 0 ? "empty" : "does not match the grammar");

  const digits = m[1] as string;
  const unit = m[2] ?? "ms";
  const scale = DURATION_UNITS_MS[unit] as number;
  const ms = Number(digits) * scale;
  if (!Number.isSafeInteger(ms)) throw invalidDuration(input, "too large to represent exactly");
  return ms;
}

/**
 * True when a stored row may be served instead of loading the page.
 *
 * Deliberate edges, each pinned by a test:
 * - A missing or unparseable `last_seen` is **stale**. The store cannot say how old
 *   the row is, so it does not get to claim it is new.
 * - `maxAgeMs === 0` is always stale, whatever the row's age — it is the documented
 *   way to force a re-fetch.
 * - The comparison is strict: a row exactly `maxAgeMs` old is not *fresher than*
 *   max-age, so it is stale.
 * - A `last_seen` in the future is fresh. That is clock skew between this machine
 *   and Postgres, not evidence about the row.
 */
export function isFresh(
  lastSeen: string | Date | null | undefined,
  maxAgeMs: number,
  now: number = Date.now(),
): boolean {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw invalidDuration(maxAgeMs, "max-age must be zero or positive");
  }
  if (maxAgeMs === 0) return false;
  if (lastSeen === null || lastSeen === undefined || lastSeen === "") return false;

  const at = lastSeen instanceof Date ? lastSeen.getTime() : Date.parse(lastSeen);
  if (!Number.isFinite(at)) return false;

  return now - at < maxAgeMs;
}
