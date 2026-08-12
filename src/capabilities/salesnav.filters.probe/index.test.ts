import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET_LIMITS, subCapsFor } from "../../core/budget/constants.js";
import { capability, selectSearchCapture } from "./index.js";

const SPEC = JSON.stringify({
  vertical: "LEAD",
  filters: [{
    kind: "values",
    type: "REGION",
    values: [{ id: "103644278", text: "United States", selectionType: "INCLUDED" }],
  }],
});

describe("salesnav.filters.probe composition", () => {
  it("refuses two distinct captured queries even when one matches the builder", () => {
    const capture = (query: string, file: string) => ({
      url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?query=${query}`,
      archived: { file },
    });
    expect(() => selectSearchCapture([
      capture("(filters:List((type:REGION)))", "one.json.gz"),
      capture("(filters:List((type:INDUSTRY)))", "two.json.gz"),
    ] as never, "(filters:List((type:REGION)))")).toThrowError(/multiple distinct lead-search queries/);
  });

  it("builds before spending, spends one page of each kind, navigates once and reports captured-wire evidence", async () => {
    const order: string[] = [];
    const check = vi.fn(async (input: { kind: string }) => order.push(`check:${input.kind}`));
    const spend = vi.fn(async (input: { kind: string }) => order.push(`spend:${input.kind}`));
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    let capture: unknown = null;
    const navigate = vi.fn(async (url: string) => {
      order.push("navigate");
      const query = url.slice(url.indexOf("query=") + "query=".length);
      capture = {
        seq: 0,
        pattern: "salesapi-lead-search",
        patterns: ["salesapi-lead-search", "sales-api-any"],
        requestId: "search-1",
        url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?q=searchQuery&query=${query}&start=0&count=25`,
        status: 200,
        body: '{"paging":{"total":17,"count":25,"start":0},"elements":[]}',
        bytes: 65,
        archived: { file: "0001-search.json.gz" },
        capturedAt: "2026-08-12T00:00:00.000Z",
      };
      return { url };
    });
    const evaluate = vi.fn(async () => ({
      url: "https://www.linkedin.com/sales/search/people",
      text: "",
      captcha: false,
    }));

    const result = await capability.run({
      args: { spec: SPEC },
      browser: {
        tab: {
          ensureForeground: async () => ({ ok: true, via: "focus-emulation", state: null }),
          navigate,
          evaluate,
        },
        tap: {
          cursor: 0,
          watch: vi.fn(() => {
            const release = vi.fn();
            releases.push(release);
            return release;
          }),
          waitFor: vi.fn(async () => capture),
          captures: vi.fn(() => capture === null ? [] : [capture]),
          misses: vi.fn(() => []),
          drain: vi.fn(async () => undefined),
        },
        cursor: { pause: vi.fn(async () => undefined) },
      },
      budget: { check, spend },
      run: { checkpoint: vi.fn(), log: vi.fn() },
    } as never);

    expect(order).toEqual([
      "check:page_load",
      "check:search_page",
      "spend:page_load",
      "spend:search_page",
      "navigate",
    ]);
    expect(navigate).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      query: {
        exact: true,
        echo: {
          filters: [{ type: "REGION", verdict: "honored" }],
          injected_filter_types: [],
          recent_search: "absent",
        },
      },
      paging: { total: 17, count: 25, start: 0 },
      search_filter_metadata: { filter_blocks: 0, value_rows: 0, selected_value_rows: 0, selected_filter_types: [] },
      evidence: { search_archive_id: "0001-search.json.gz", catalog_hash_match: false },
      interactions: { clicks: 0, keystrokes: 0, wheel_events: 0 },
    });
    expect(result.warnings).toContainEqual({
      code: "FILTER_CATALOG_NOT_CAPTURED",
      field: "no filter-layout body arrived on this built-url load",
      n: 1,
    });
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("pins the Task 42 daily ceiling separately from the older surface probe", () => {
    expect(DEFAULT_BUDGET_LIMITS.searchPagesPerDay).toBe(50);
    expect(subCapsFor("salesnav.filters.probe")).toEqual({
      pageLoadsPerDay: 6,
      searchPagesPerDay: 6,
      distinctProfilesPerDay: 0,
    });
  });

  it("refuses an unproven id before any budget check, spend or navigation", async () => {
    const check = vi.fn();
    const spend = vi.fn();
    const navigate = vi.fn();
    const invalid = JSON.stringify({
      vertical: "LEAD",
      filters: [{
        kind: "values",
        type: "REGION",
        values: [{ id: "103644279", text: "United States", selectionType: "INCLUDED" }],
      }],
    });
    await expect(capability.run({
      args: { spec: invalid },
      browser: { tab: { navigate }, tap: {}, cursor: {} },
      budget: { check, spend },
      run: {},
    } as never)).rejects.toMatchObject({ code: "FILTER_VOCABULARY_MISSING", exit: 1 });
    expect(check).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
