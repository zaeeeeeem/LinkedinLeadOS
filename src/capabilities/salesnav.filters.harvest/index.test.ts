import { describe, expect, it, vi } from "vitest";
import { createHarvestCapability } from "./index.js";

describe("salesnav.filters.harvest composition", () => {
  it("navigates once and reports zero capability input events after handoff", async () => {
    const order: string[] = [];
    const release = vi.fn();
    const watch = vi.fn(() => release);
    const navigate = vi.fn(async () => {
      order.push("navigate");
      return { url: "https://www.linkedin.com/sales/search/people" };
    });
    const cursor = {
      click: vi.fn(() => { throw new Error("must not click"); }),
      wheel: vi.fn(() => { throw new Error("must not wheel"); }),
      pause: vi.fn(() => { throw new Error("must not pause through HumanCursor"); }),
    };
    const check = vi.fn(async () => undefined);
    const spend = vi.fn(async (input: { kind: string }) => {
      order.push(input.kind);
    });
    const log = vi.fn();
    const announce = vi.fn();
    const observe = vi.fn(async () => ({
      stop: "operator-stop" as const,
      search: { requestIds: ["initial"], lead: 1, account: 0 },
      searchPagesCharged: 4,
      polls: 1,
    }));
    const capability = createHarvestCapability({
      gate: vi.fn(async () => ({
        kind: "clean" as const,
        clean: true as const,
        signal: "none" as const,
        detail: "no challenge markers",
      })),
      observe,
      announce,
      settle: vi.fn(async () => undefined),
    });
    const result = await capability.run({
      args: {
        vertical: "LEAD",
        operatorPlan: "Open taxonomy facets and type agreed prefixes.",
        searchPageBudget: 4,
        maxMinutes: 5,
      },
      browser: {
        tab: {
          ensureForeground: async () => ({ ok: true, via: "focus-emulation", state: null }),
          navigate,
        },
        tap: {
          watch,
          captures: () => [],
          misses: () => [],
          drain: async () => undefined,
        },
        cursor,
      },
      budget: { check, spend },
      run: {
        dir: "/tmp/task43-test-run",
        runId: "TEST43",
        log,
        artifacts: () => ({ raw: "runs/TEST43/raw" }),
      },
    } as never);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("https://www.linkedin.com/sales/search/people");
    expect(spend.mock.calls).toEqual([
      [{ kind: "page_load", n: 1 }],
      [{ kind: "search_page", n: 4 }],
    ]);
    expect(order).toEqual(["page_load", "search_page", "navigate"]);
    expect(check.mock.calls).toEqual([
      [{ kind: "page_load", n: 1 }],
      [{ kind: "search_page", n: 4 }],
    ]);
    expect(cursor.click).not.toHaveBeenCalled();
    expect(cursor.wheel).not.toHaveBeenCalled();
    expect(cursor.pause).not.toHaveBeenCalled();
    expect(announce).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      capability: {
        navigations: 1,
        clicks: 0,
        keystrokes: 0,
        wheel_events: 0,
        input_events_after_navigation: 0,
      },
      operator: { interactions_reconstructed: false },
    });
    expect(release).toHaveBeenCalledTimes(watch.mock.calls.length);
  });

  it("estimates the full declared search allowance for preflight", () => {
    const capability = createHarvestCapability();
    expect(capability.cost({} as never)).toEqual({
      page_loads: 1,
      search_pages: 12,
      profile_opens: 0,
    });
    expect(capability.cost({
      vertical: "ACCOUNT",
      operatorPlan: "Open account taxonomy facets.",
      searchPageBudget: 7,
      maxMinutes: 10,
    })).toEqual({ page_loads: 1, search_pages: 7, profile_opens: 0 });
  });
});
