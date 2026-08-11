import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SAVED_SEARCH_FIELD_PATHS } from "./field-map.js";
import {
  MAX_SAVED_SEARCHES_PER_VERTICAL, parseSavedSearches, savedSearchUrl,
} from "./parse.js";

const leadFixture = readFileSync(join(import.meta.dirname, "test-fixtures", "saved-leads.synthetic.json"), "utf8");
const accountFixture = readFileSync(join(import.meta.dirname, "test-fixtures", "saved-accounts.synthetic.json"), "utf8");

describe("salesnav.savedsearch.list — FIELD-MAP meaning", () => {
  it("pins every path to the intended synthetic value, not merely its type", () => {
    const lead = JSON.parse(leadFixture).elements[0];
    const account = JSON.parse(accountFixture).elements[0];
    expect(SAVED_SEARCH_FIELD_PATHS.rows).toBe("$.elements[]");
    expect(lead.id).toBe(1111111111);
    expect(lead.name).toBe("SYNTHETIC_OPERATOR_LEAD_SEARCH");
    expect(lead.filters[0].singleFilterMetadata.type).toBe("CURRENT_TITLE");
    expect(account.id).toBe(2222222222);
    expect(account.keywords).toBe("SYNTHETIC_THIRD_PARTY_KEYWORD");

    const map = readFileSync(join(import.meta.dirname, "FIELD-MAP.md"), "utf8");
    for (const path of Object.values(SAVED_SEARCH_FIELD_PATHS)) expect(map).toContain(`\`${path}\``);
  });
});
describe("salesnav.savedsearch.list — pure parser", () => {
  it("reads Lead identity, operator label and the UI-measured re-execution URL", () => {
    const parsed = parseSavedSearches(leadFixture, "sn_leads");
    expect(parsed.ok).toBe(true);
    expect(parsed.searches).toEqual([{
      search_id: "sn_leads:1111111111",
      saved_search_id: "1111111111",
      kind: "sn_leads",
      label: "SYNTHETIC_OPERATOR_LEAD_SEARCH",
      filter_url: "https://www.linkedin.com/sales/search/people?savedSearchId=1111111111",
      created_at: "2026-08-11T00:00:00.000Z",
      last_viewed_at: "2026-08-12T00:00:00.000Z",
      filters_count: 1,
      has_keywords: false,
    }]);
  });

  it("keeps Account identity disjoint and uses the company route", () => {
    const parsed = parseSavedSearches(accountFixture, "sn_accounts");
    expect(parsed.searches[0]).toMatchObject({
      search_id: "sn_accounts:2222222222",
      saved_search_id: "2222222222",
      kind: "sn_accounts",
      filter_url: "https://www.linkedin.com/sales/search/company?savedSearchId=2222222222",
      filters_count: 1,
      has_keywords: true,
    });
  });

  it("constructs only the two measured Sales Navigator routes", () => {
    expect(savedSearchUrl("sn_leads", "7")).toBe("https://www.linkedin.com/sales/search/people?savedSearchId=7");
    expect(savedSearchUrl("sn_accounts", "7")).toBe("https://www.linkedin.com/sales/search/company?savedSearchId=7");
  });

  it("refuses identity-less and duplicate rows without shifting another identity", () => {
    const body = JSON.parse(leadFixture);
    body.elements.push({ ...body.elements[0], id: null });
    body.elements.push({ ...body.elements[0] });
    const parsed = parseSavedSearches(JSON.stringify(body), "sn_leads");
    expect(parsed.searches).toHaveLength(1);
    expect(parsed.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "SAVED_SEARCH_ID_MISSING", n: 1 }),
      expect.objectContaining({ code: "SAVED_SEARCH_ID_DUPLICATE", n: 1 }),
    ]));
  });

  it("bounds every vertical at 50 rows and reports the unexamined suffix", () => {
    const row = JSON.parse(leadFixture).elements[0];
    const elements = Array.from({ length: MAX_SAVED_SEARCHES_PER_VERTICAL + 3 }, (_, i) => ({ ...row, id: i + 1 }));
    const parsed = parseSavedSearches(JSON.stringify({ elements }), "sn_leads");
    expect(parsed.searches).toHaveLength(MAX_SAVED_SEARCHES_PER_VERTICAL);
    expect(parsed.warnings).toContainEqual({
      code: "SAVED_SEARCHES_NOT_EXAMINED", n: 3,
      field: "3 rows exceeded the 50-per-vertical bound",
    });
  });

  it("distinguishes a real empty list from a missing envelope", () => {
    expect(parseSavedSearches('{"elements":[],"paging":{"count":0}}', "sn_leads"))
      .toMatchObject({ ok: true, searches: [], examined: 0, total: 0 });
    expect(parseSavedSearches("{}", "sn_leads"))
      .toMatchObject({ ok: false, warnings: [{ code: "SAVED_SEARCH_ENVELOPE_MISSING" }] });
  });
});
