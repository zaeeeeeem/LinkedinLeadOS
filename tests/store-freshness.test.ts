import { describe, expect, it } from "vitest";
import { CapabilityError } from "../src/core/run/receipt.js";
import { DEFAULT_MAX_AGE, DEFAULT_MAX_AGE_MS } from "../src/core/store/constants.js";
import { isFresh, parseDuration } from "../src/core/store/freshness.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("parseDuration — the --max-age grammar", () => {
  it("reads the four suffixes", () => {
    expect(parseDuration("7d")).toBe(7 * DAY);
    expect(parseDuration("12h")).toBe(12 * HOUR);
    expect(parseDuration("30m")).toBe(30 * MINUTE);
    expect(parseDuration("45s")).toBe(45 * SECOND);
    expect(parseDuration("500ms")).toBe(500);
  });

  it("reads a bare number as milliseconds", () => {
    expect(parseDuration("500")).toBe(500);
    expect(parseDuration(500)).toBe(500);
  });

  it("reads 0 as zero, in every spelling", () => {
    expect(parseDuration("0")).toBe(0);
    expect(parseDuration(0)).toBe(0);
    expect(parseDuration("0d")).toBe(0);
  });

  it("is case-insensitive and tolerates surrounding whitespace", () => {
    expect(parseDuration("7D")).toBe(7 * DAY);
    expect(parseDuration(" 12H ")).toBe(12 * HOUR);
    expect(parseDuration("500MS")).toBe(500);
  });

  it.each([
    ["", "empty string"],
    ["   ", "whitespace only"],
    ["abc", "not a number"],
    ["d7", "suffix first"],
    ["7dd", "doubled suffix"],
    ["7 d", "inner whitespace"],
    ["7d12h", "compound"],
    ["1.5d", "fractional"],
    ["-1d", "negative with suffix"],
    ["-1", "negative bare"],
    ["7w", "unknown suffix"],
    ["1e3", "exponent notation"],
    ["Infinity", "infinite"],
    ["0x10", "hex"],
  ])("refuses %j (%s) loudly rather than defaulting", (input) => {
    let thrown: unknown;
    try {
      parseDuration(input);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CapabilityError);
    const err = thrown as CapabilityError;
    expect(err.code).toBe("INVALID_DURATION");
    expect(err.exit).toBe(1);
    expect(err.retryable).toBe(false);
    // The operator has to be told the grammar, not just that they were wrong.
    expect(err.message).toContain("7d");
  });

  it.each([
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
    [-1, "negative"],
    [1.5, "fractional"],
  ])("refuses the number %s (%s)", (input) => {
    expect(() => parseDuration(input)).toThrow(CapabilityError);
  });

  it("caps nothing but stays inside safe integers", () => {
    expect(parseDuration("36500d")).toBe(36500 * DAY);
    expect(Number.isSafeInteger(parseDuration("36500d"))).toBe(true);
  });

  it("agrees with the spec §7 default of 7 days", () => {
    expect(parseDuration(DEFAULT_MAX_AGE)).toBe(DEFAULT_MAX_AGE_MS);
    expect(DEFAULT_MAX_AGE_MS).toBe(7 * DAY);
  });
});

describe("isFresh — when the store answers instead of the browser", () => {
  const now = Date.UTC(2026, 7, 8, 12, 0, 0);
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();

  it("is fresh while the row is younger than max-age", () => {
    expect(isFresh(at(DAY), 7 * DAY, now)).toBe(true);
  });

  it("is stale once the row is older", () => {
    expect(isFresh(at(8 * DAY), 7 * DAY, now)).toBe(false);
  });

  it("is stale exactly at the boundary — 'fresher than' is strict", () => {
    expect(isFresh(at(7 * DAY), 7 * DAY, now)).toBe(false);
    expect(isFresh(at(7 * DAY - 1), 7 * DAY, now)).toBe(true);
  });

  it("treats a missing timestamp as stale, always", () => {
    expect(isFresh(null, 7 * DAY, now)).toBe(false);
    expect(isFresh(undefined, 7 * DAY, now)).toBe(false);
    expect(isFresh("", 7 * DAY, now)).toBe(false);
  });

  it("treats an unparseable timestamp as stale rather than certifying it", () => {
    expect(isFresh("not a date", 7 * DAY, now)).toBe(false);
    expect(isFresh(new Date(Number.NaN), 7 * DAY, now)).toBe(false);
  });

  it("re-fetches everything at max-age 0, however new the row is", () => {
    expect(isFresh(at(0), 0, now)).toBe(false);
    expect(isFresh(at(1), 0, now)).toBe(false);
  });

  it("accepts a Date as well as a timestamp string", () => {
    expect(isFresh(new Date(now - DAY), 7 * DAY, now)).toBe(true);
  });

  it("treats a row stamped in the future as fresh — clock skew is not staleness", () => {
    expect(isFresh(at(-HOUR), 7 * DAY, now)).toBe(true);
  });

  it("refuses a negative max-age instead of quietly clamping it", () => {
    expect(() => isFresh(at(0), -1, now)).toThrow(CapabilityError);
  });
});
