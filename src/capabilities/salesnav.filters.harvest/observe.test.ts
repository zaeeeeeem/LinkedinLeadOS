import { describe, expect, it } from "vitest";
import { searchObservation, observeHarvest } from "./observe.js";

describe("salesnav.filters.harvest passive observation", () => {
  it("counts each UI-issued search request once across captures and misses", () => {
    const observed = searchObservation(
      [
        { requestId: "lead-1", url: "https://www.linkedin.com/sales-api/salesApiLeadSearch?q=x" },
        { requestId: "account-1", url: "https://www.linkedin.com/sales-api/salesApiAccountSearch?q=x" },
      ],
      [
        { requestId: "lead-1", url: "https://www.linkedin.com/sales-api/salesApiLeadSearch?q=x" },
        { requestId: "lead-2", url: "https://www.linkedin.com/sales-api/salesApiLeadSearch?q=y" },
        { requestId: "other", url: "https://www.linkedin.com/sales-api/salesApiTypeahead?q=z" },
      ],
    );

    expect(observed).toEqual({
      requestIds: ["account-1", "lead-1", "lead-2"],
      lead: 2,
      account: 1,
    });
  });

  it("stops at the declared budget without spending beyond the precharged allowance", async () => {
    const captures: Array<{ requestId: string; url: string }> = [];
    let tick = 0;
    const result = await observeHarvest({
      tap: {
        captures: () => captures as never[],
        misses: () => [],
        drain: async () => undefined,
      },
      searchPageBudget: 3,
      prechargedSearchPages: 3,
      maxMs: 60_000,
      stopRequested: () => false,
      inspect: () => {
        tick++;
        captures.push({
          requestId: `lead-${tick}`,
          url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?q=${tick}`,
        });
      },
      sleep: async () => undefined,
    });

    expect(result.stop).toBe("search-budget");
    expect(result.search.requestIds).toHaveLength(3);
    expect(result.searchPagesCharged).toBe(3);
  });

  it("has no browser-input dependency in its observation contract", async () => {
    const result = await observeHarvest({
      tap: { captures: () => [], misses: () => [], drain: async () => undefined },
      searchPageBudget: 4,
      prechargedSearchPages: 4,
      maxMs: 60_000,
      stopRequested: () => true,
    });

    expect(result.stop).toBe("operator-stop");
    expect(result.searchPagesCharged).toBe(4);
  });

  it("refuses to observe unless the full allowance was charged before handoff", async () => {
    await expect(observeHarvest({
      tap: { captures: () => [], misses: () => [], drain: async () => undefined },
      searchPageBudget: 4,
      prechargedSearchPages: 1,
      maxMs: 60_000,
      stopRequested: () => true,
    })).rejects.toMatchObject({ code: "HARVEST_SEARCH_ALLOWANCE_NOT_PRECHARGED" });
  });

  it("refuses a broad-net session before transient accounting work becomes unbounded", async () => {
    const captures = Array.from({ length: 10_001 }, (_, index) => ({
      requestId: `other-${index}`,
      url: `https://www.linkedin.com/voyager/api/example/${index}`,
    }));
    await expect(observeHarvest({
      tap: {
        captures: () => captures as never[],
        misses: () => [],
        drain: async () => undefined,
      },
      searchPageBudget: 4,
      prechargedSearchPages: 4,
      maxMs: 60_000,
      stopRequested: () => false,
    })).rejects.toMatchObject({ code: "HARVEST_CAPTURE_BOUND_EXCEEDED" });
  });
});
