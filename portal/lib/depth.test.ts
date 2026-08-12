// portal/lib/depth.test.ts
import { describe, expect, it } from "vitest";
import { companyDepth, effectiveStatus, personDepth } from "./depth";

const base = { hasHeadline: false, hasExperience: false, hasPosts: false };

describe("personDepth", () => {
  it("D1 when only the search row exists", () => {
    expect(personDepth(base)).toBe(1);
  });
  it("D2 when a headline was captured", () => {
    expect(personDepth({ ...base, hasHeadline: true })).toBe(2);
  });
  it("D3 when experience exists, even without a headline (odd data degrades safely)", () => {
    expect(personDepth({ ...base, hasExperience: true })).toBe(3);
  });
  it("D4 when posts exist", () => {
    expect(personDepth({ ...base, hasHeadline: true, hasExperience: true, hasPosts: true })).toBe(4);
  });
});

describe("companyDepth", () => {
  it("C0 when the lead has no company urn", () => {
    expect(companyDepth({ hasCompanyUrn: false, hasCompanyRow: false, hasDetail: false, hasActivity: false })).toBe(0);
  });
  it("C1 name-only", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: false, hasActivity: false })).toBe(1);
  });
  it("C2 when detail fields captured", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: true, hasActivity: false })).toBe(2);
  });
  it("C3 when posts/jobs/people captured", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: true, hasActivity: true })).toBe(3);
  });
});

describe("effectiveStatus", () => {
  it("missing pipeline row means new", () => {
    expect(effectiveStatus(null, 1)).toBe("new");
  });
  it("new + depth >= D3 shows enriched automatically", () => {
    expect(effectiveStatus("new", 3)).toBe("enriched");
    expect(effectiveStatus(null, 4)).toBe("enriched");
  });
  it("human-set statuses always pass through", () => {
    expect(effectiveStatus("contacted", 4)).toBe("contacted");
    expect(effectiveStatus("skipped", 1)).toBe("skipped");
  });
});
