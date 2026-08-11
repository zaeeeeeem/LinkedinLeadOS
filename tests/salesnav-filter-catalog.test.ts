import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { FILTER_CATALOG_FIXTURE, FILTER_CATALOG_PROVENANCE, loadPinnedFilterCatalog } from "../src/core/salesnav-query/index.js";

describe("Sales Navigator promoted filter catalog", () => {
  it("pins the measured per-vertical sets from the promoted body", () => {
    expect(createHash("sha256").update(gunzipSync(readFileSync(FILTER_CATALOG_FIXTURE))).digest("hex"))
      .toBe(FILTER_CATALOG_PROVENANCE.bodySha256);
    expect(FILTER_CATALOG_PROVENANCE.scrubbed).toEqual([]);
    const rows = loadPinnedFilterCatalog();
    const lead = rows.filter((row) => row.vertical === "LEAD");
    const account = rows.filter((row) => row.vertical === "ACCOUNT");
    expect(lead).toHaveLength(35);
    expect(account).toHaveLength(17);
    expect(new Set(rows.map((row) => row.type))).toHaveLength(46);
    expect(new Set(rows.filter((row) => row.valueShape !== "aggregate").map((row) => row.type))).toHaveLength(44);
    expect(lead.map((row) => row.type).sort()).toEqual([
      "ACCOUNT_LIST", "COMPANY_HEADCOUNT", "COMPANY_HEADQUARTERS", "COMPANY_TYPE", "CONNECTION_OF",
      "CURRENT_COMPANY", "CURRENT_TITLE", "FIRST_NAME", "FOLLOWS_YOUR_COMPANY", "FUNCTION", "GEOGRAPHY",
      "GROUP", "INDUSTRY", "LAST_NAME", "LEADS_IN_CRM", "LEAD_INTERACTIONS", "LEAD_LIST", "PAST_COLLEAGUE",
      "PAST_COMPANY", "PAST_TITLE", "PERSONA", "POSTAL_CODE", "POSTED_ON_LINKEDIN", "PROFILE_LANGUAGE",
      "RECENTLY_CHANGED_JOBS", "REGION", "RELATIONSHIP", "SAVED_LEADS_AND_ACCOUNTS", "SCHOOL",
      "SENIORITY_LEVEL", "VIEWED_YOUR_PROFILE", "WITH_SHARED_EXPERIENCES", "YEARS_AT_CURRENT_COMPANY",
      "YEARS_IN_CURRENT_POSITION", "YEARS_OF_EXPERIENCE",
    ]);
    expect(account.map((row) => row.type).sort()).toEqual([
      "ACCOUNTS_IN_CRM", "ACCOUNT_ACTIVITIES", "ACCOUNT_LIST", "ANNUAL_REVENUE", "COMPANY_HEADCOUNT",
      "COMPANY_HEADCOUNT_GROWTH", "DEPARTMENT_HEADCOUNT", "DEPARTMENT_HEADCOUNT_GROWTH", "FORTUNE",
      "HEADQUARTERS_LOCATION", "INDUSTRY", "JOB_OPPORTUNITIES", "NUM_OF_FOLLOWERS", "POSTAL_CODE", "REGION",
      "RELATIONSHIP", "SAVED_ACCOUNTS",
    ]);
  });

  it("reads capability flags and range choices from the fixture, not copied constants", () => {
    const rows = loadPinnedFilterCatalog();
    expect(rows.find((row) => row.vertical === "LEAD" && row.type === "CURRENT_TITLE")).toMatchObject({
      valueShape: "values", typeaheadSupported: true, rawTextSupported: true, exclusionSupported: true,
    });
    expect(rows.find((row) => row.vertical === "LEAD" && row.type === "COMPANY_HEADCOUNT")).toMatchObject({
      typeaheadSupported: false, rawTextSupported: false, exclusionSupported: false,
    });
    const revenue = rows.find((row) => row.vertical === "ACCOUNT" && row.type === "ANNUAL_REVENUE")!;
    expect(revenue.valueShape).toBe("range");
    expect(revenue.acceptedValues).toHaveLength(12);
    expect(revenue.subFilters).toHaveLength(22);
    expect(rows.find((row) => row.vertical === "ACCOUNT" && row.type === "DEPARTMENT_HEADCOUNT_GROWTH")!.subFilters).toHaveLength(26);
  });
});
