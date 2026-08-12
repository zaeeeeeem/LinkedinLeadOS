import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BUDGET_LIMITS, subCapsFor } from "../../core/budget/constants.js";
import { insertSearch } from "../../core/store/index.js";
import { capability, createFilterApplyCapability, selectSearchCapture, type FilterApplyDeps } from "./index.js";

const LEAD_SPEC = JSON.stringify({
  vertical: "LEAD",
  filters: [{
    kind: "values",
    type: "REGION",
    values: [{ id: "103644278", text: "United States", selectionType: "INCLUDED" }],
  }],
});

const ACCOUNT_SPEC = JSON.stringify({
  vertical: "ACCOUNT",
  filters: [{
    kind: "values",
    type: "COMPANY_HEADCOUNT",
    values: [{ id: "C", text: "11-50", selectionType: "INCLUDED" }],
  }],
});

/** The real store export must satisfy the dependency contract, so the offline
 *  composition test exercises the same shape the live run writes through. */
const pinned: FilterApplyDeps["insertSearch"] = (input, client) => insertSearch(input, { client });
void pinned;

type HarnessOptions = {
  spec: string;
  endpoint?: string;
  body?: string;
  queryOverride?: (query: string) => string;
  noStore?: boolean;
  deps?: Partial<FilterApplyDeps>;
};

const DEFAULT_BODY = '{"paging":{"total":17,"count":25,"start":0},"metadata":{"tracking":{"sessionId":"S1"}}}';

function harness(options: HarnessOptions) {
  const order: string[] = [];
  const inserted: unknown[] = [];
  const check = vi.fn(async (input: { kind: string }) => order.push(`check:${input.kind}`));
  const spend = vi.fn(async (input: { kind: string }) => order.push(`spend:${input.kind}`));
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  let capture: unknown = null;
  const navigate = vi.fn(async (url: string) => {
    order.push("navigate");
    const built = url.slice(url.indexOf("query=") + "query=".length);
    const query = options.queryOverride ? options.queryOverride(built) : built;
    capture = {
      seq: 0,
      pattern: "salesapi-search",
      patterns: ["salesapi-search"],
      requestId: "search-1",
      url: `https://www.linkedin.com/sales-api${options.endpoint ?? "/salesApiLeadSearch"}?q=searchQuery&query=${query}&start=0&count=25`,
      status: 200,
      body: options.body ?? DEFAULT_BODY,
      bytes: 88,
      archived: { file: "0001-search.json.gz" },
      capturedAt: "2026-08-12T00:00:00.000Z",
    };
    return { url };
  });
  const deps: FilterApplyDeps = {
    store: () => ({ marker: "store" }) as never,
    insertSearch: async (input) => {
      order.push("insert-search");
      inserted.push(input);
      return { search_id: input.search_id, rows: 1 };
    },
    ...options.deps,
  };
  const context = {
    args: { spec: options.spec },
    flags: { noStore: options.noStore ?? false },
    browser: {
      tab: {
        ensureForeground: async () => ({ ok: true, via: "focus-emulation", state: null }),
        navigate,
        evaluate: vi.fn(async () => ({ url: "https://www.linkedin.com/sales/search/people", text: "", captcha: false })),
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
    run: { runId: "01RUNAPPLY", checkpoint: vi.fn(), log: vi.fn() },
  };
  return { context, order, inserted, navigate, check, spend, releases, deps };
}

function run(options: HarnessOptions) {
  const h = harness(options);
  return { ...h, result: createFilterApplyCapability(h.deps).run(h.context as never) };
}

describe("salesnav.filters.apply composition", () => {
  it("builds, checks, spends, navigates once, and reports a captured-wire honor", async () => {
    const h = run({ spec: LEAD_SPEC });
    const result = await h.result;
    expect(h.order).toEqual([
      "check:page_load",
      "check:search_page",
      "spend:page_load",
      "spend:search_page",
      "navigate",
      "insert-search",
    ]);
    expect(h.navigate).toHaveBeenCalledOnce();
    expect(h.navigate.mock.calls[0]![0]).toContain("/sales/search/people?query=");
    expect(result.data).toMatchObject({
      vertical: "LEAD",
      verdict: { clean: true, honored: 1, rewritten: 0, dropped: 0, injected: 0 },
      paging: { total: 17, count: 25, start: 0 },
      session_id: "S1",
      evidence: { search_archive_id: "0001-search.json.gz" },
      storage: { skipped: false, table: "searches", search_id: "01RUNAPPLY", search_results: 0 },
      interactions: { clicks: 0, keystrokes: 0, wheel_events: 0 },
    });
    expect((result.warnings ?? []).some((w) => w.code === "FILTER_REWRITTEN" || w.code === "FILTER_DROPPED")).toBe(false);
    expect(h.releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("routes the ACCOUNT vertical to the company search page and its own endpoint and kind", async () => {
    const h = run({ spec: ACCOUNT_SPEC, endpoint: "/salesApiAccountSearch" });
    const result = await h.result;
    expect(h.navigate.mock.calls[0]![0]).toContain("/sales/search/company?query=");
    expect(result.data).toMatchObject({ vertical: "ACCOUNT", verdict: { clean: true } });
    expect(h.inserted[0]).toMatchObject({ kind: "sn_accounts", search_id: "01RUNAPPLY" });
  });

  it("stores one searches row with zero search_results, carrying the verdict and count", async () => {
    const h = run({ spec: LEAD_SPEC });
    const result = await h.result;
    expect(h.inserted).toHaveLength(1);
    expect(h.inserted[0]).toMatchObject({
      search_id: "01RUNAPPLY",
      kind: "sn_leads",
      filter_json: {
        vertical: "LEAD",
        filters_count: 1,
        verdict: { clean: true, exact: true, filters: [{ type: "REGION", verdict: "honored" }] },
        paging: { total: 17 },
        session_id: "S1",
        evidence: { search_archive_id: "0001-search.json.gz" },
      },
    });
    expect((h.inserted[0] as { filter_url: string }).filter_url).toContain("/sales/search/people?query=");
    expect(result.stored).toEqual({ table: "searches", run_ref: "01RUNAPPLY", rows: 1 });
  });

  it("writes nothing under --no-store and says so on the receipt", async () => {
    const h = run({ spec: LEAD_SPEC, noStore: true });
    const result = await h.result;
    expect(h.inserted).toHaveLength(0);
    expect(result.stored).toBeUndefined();
    expect(result.data).toMatchObject({ storage: { skipped: true, reason: "--no-store" } });
  });

  it("reads the verdict from the captured request, so a dropped filter is loud", async () => {
    const h = run({
      spec: LEAD_SPEC,
      queryOverride: () => "(filters:List((type:INDUSTRY,values:List((id:4,text:Software%20Development,selectionType:INCLUDED)))))",
    });
    const result = await h.result;
    expect(result.data).toMatchObject({
      verdict: { clean: false, honored: 0, dropped: 1, injected: 1 },
    });
    expect(result.warnings).toContainEqual({ code: "FILTER_DROPPED", field: "REGION", n: 1 });
    expect(result.warnings).toContainEqual({ code: "FILTER_INJECTED", field: "INDUSTRY", n: 1 });
    // Exit stays 0: a drop is a finding the loop acts on, not a failure.
    expect(result.data).toMatchObject({ paging: { total: 17 } });
  });

  it("refuses a response that does not identify itself as page 1", async () => {
    const h = run({
      spec: LEAD_SPEC,
      body: '{"paging":{"total":17,"count":25,"start":25},"metadata":{"tracking":{"sessionId":"S1"}}}',
    });
    await expect(h.result).rejects.toMatchObject({ code: "FILTER_APPLY_NOT_PAGE_ONE", exit: 5 });
  });

  it("refuses when the named search endpoint never fired", async () => {
    const h = run({ spec: LEAD_SPEC, endpoint: "/salesApiCompanies" });
    await expect(h.result).rejects.toMatchObject({ code: "FILTER_APPLY_SEARCH_BODY_MISSING", exit: 5 });
  });

  it("warns instead of inventing a session id when the tracking block is absent", async () => {
    const h = run({ spec: LEAD_SPEC, body: '{"paging":{"total":3,"count":25,"start":0}}' });
    const result = await h.result;
    expect(result.data).toMatchObject({ session_id: null });
    expect(result.warnings).toContainEqual({ code: "SESSION_ID_ABSENT", field: "metadata.tracking.sessionId", n: 1 });
  });

  it("refuses an unproven id before any budget check, spend, navigation or store write", async () => {
    const h = harness({
      spec: JSON.stringify({
        vertical: "LEAD",
        filters: [{ kind: "values", type: "REGION", values: [{ id: "103644279", text: "United States", selectionType: "INCLUDED" }] }],
      }),
    });
    await expect(createFilterApplyCapability(h.deps).run(h.context as never))
      .rejects.toMatchObject({ code: "FILTER_VOCABULARY_MISSING", exit: 1 });
    expect(h.check).not.toHaveBeenCalled();
    expect(h.spend).not.toHaveBeenCalled();
    expect(h.navigate).not.toHaveBeenCalled();
    expect(h.inserted).toHaveLength(0);
  });

  it("refuses two distinct captured queries on one navigation", () => {
    const capture = (query: string, file: string) => ({
      url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?query=${query}`,
      archived: { file },
    });
    expect(() => selectSearchCapture([
      capture("(filters:List((type:REGION)))", "one.json.gz"),
      capture("(filters:List((type:INDUSTRY)))", "two.json.gz"),
    ] as never, "/salesApiLeadSearch", "(filters:List((type:REGION)))")).toThrowError(/multiple distinct search queries/);
  });

  it("costs exactly one page load and one search page, and pins its own daily ceiling", () => {
    expect(capability.cost({} as never)).toEqual({ page_loads: 1, search_pages: 1, profile_opens: 0 });
    expect(DEFAULT_BUDGET_LIMITS.searchPagesPerDay).toBe(50);
    expect(subCapsFor("salesnav.filters.apply")).toEqual({
      pageLoadsPerDay: 10,
      searchPagesPerDay: 10,
      distinctProfilesPerDay: 0,
    });
  });
});
