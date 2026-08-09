import { describe, expect, it } from "vitest";
import {
  EPOCH_MS_FLOOR,
  FUTURE_TOLERANCE_MS,
  looksEpochMs,
  looksEpochSeconds,
  looksIso8601,
  looksRelativeTime,
  timeShapeOf,
} from "../src/core/fixtures/timeshape.js";

const NOW = Date.UTC(2026, 7, 9);

describe("looksEpochMs", () => {
  it("accepts a plausible LinkedIn timestamp and rejects an id of the same width", () => {
    expect(looksEpochMs(Date.UTC(2026, 6, 1), NOW)).toBe(true);
    // A post id is 19 digits and is not a time. Reading one as a timestamp puts
    // the post in the year 602 million.
    expect(looksEpochMs(7123456789012345678, NOW)).toBe(false);
  });

  it("rejects anything before LinkedIn existed or far in the future", () => {
    expect(looksEpochMs(EPOCH_MS_FLOOR - 1, NOW)).toBe(false);
    expect(looksEpochMs(EPOCH_MS_FLOOR, NOW)).toBe(true);
    expect(looksEpochMs(NOW + FUTURE_TOLERANCE_MS, NOW)).toBe(true);
    expect(looksEpochMs(NOW + FUTURE_TOLERANCE_MS + 1, NOW)).toBe(false);
  });

  it("rejects the counts and small numbers a post body is full of", () => {
    for (const n of [0, 1, 42, 1_500, 105_570]) expect(looksEpochMs(n, NOW)).toBe(false);
  });

  it("rejects a non-integer", () => {
    expect(looksEpochMs(Date.UTC(2026, 6, 1) + 0.5, NOW)).toBe(false);
  });
});

describe("looksEpochSeconds", () => {
  it("accepts a ten-digit second stamp, which millis rejects", () => {
    const seconds = Math.floor(Date.UTC(2026, 6, 1) / 1000);
    expect(looksEpochSeconds(seconds, NOW)).toBe(true);
    expect(looksEpochMs(seconds, NOW)).toBe(false);
  });
});

describe("looksIso8601", () => {
  it("accepts date and instant forms", () => {
    expect(looksIso8601("2026-08-09")).toBe(true);
    expect(looksIso8601("2026-08-09T12:30:00Z")).toBe(true);
    expect(looksIso8601("2026-08-09T12:30:00.123+05:00")).toBe(true);
  });

  it("rejects a string that matches the shape but is not a date", () => {
    // The reason this parses rather than only matching: a regex alone calls
    // month 99 a timestamp.
    expect(looksIso8601("2026-99-09")).toBe(false);
    expect(looksIso8601("not-a-date")).toBe(false);
    expect(looksIso8601("3d")).toBe(false);
  });
});

describe("looksRelativeTime", () => {
  it("accepts what LinkedIn's feed renders", () => {
    for (const t of ["3d", "2w", "1mo", "5h", "12m", "1y", "3 d", "2 days ago", "4h •"]) {
      expect(looksRelativeTime(t)).toBe(true);
    }
  });

  it("is anchored, so it does not match a headline that contains a number", () => {
    // Unanchored, `1m` matches inside this and the probe reports the whole page
    // as a timestamp.
    expect(looksRelativeTime("Scaled revenue to 1m ARR at Example")).toBe(false);
    expect(looksRelativeTime("Founder, 3d printing")).toBe(false);
    expect(looksRelativeTime("")).toBe(false);
  });
});

describe("timeShapeOf", () => {
  it("classifies each form, absolute before relative", () => {
    expect(timeShapeOf(Date.UTC(2026, 6, 1), NOW)).toBe("epoch-ms");
    expect(timeShapeOf(Math.floor(Date.UTC(2026, 6, 1) / 1000), NOW)).toBe("epoch-s");
    expect(timeShapeOf("2026-08-09T12:00:00Z", NOW)).toBe("iso-8601");
    expect(timeShapeOf("3d", NOW)).toBe("relative");
  });

  it("reads a quoted large integer as the timestamp it is", () => {
    expect(timeShapeOf(String(Date.UTC(2026, 6, 1)), NOW)).toBe("epoch-ms");
  });

  it("returns null for everything that is not a time", () => {
    for (const v of [null, undefined, true, {}, [], "Founder at Example", 42, "urn:li:activity:1"]) {
      expect(timeShapeOf(v, NOW)).toBeNull();
    }
  });
});
