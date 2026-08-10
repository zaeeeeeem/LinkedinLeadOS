import { afterEach, describe, expect, it } from "vitest";
import { runPaged, budgetStopError } from "../src/core/paged/run.js";
import type { PagedRunOutcome } from "../src/core/paged/types.js";
import {
  CAPABILITY_SUB_CAPS, DEFAULT_BUDGET_LIMITS, subCapsFor,
} from "../src/core/budget/constants.js";
import { EXIT } from "../src/core/run/receipt.js";
import { BudgetLedger } from "../src/core/budget/ledger.js";
import { RunBudget } from "../src/cli/budget.js";
import { CAPTURES_PER_PAGE, harness, type Harness } from "./helpers/paged.js";

const silent = { sleep: async () => {}, rng: () => 0.5 };

let h: Harness;
afterEach(() => h?.cleanup());

/** A ledger bound to the harness's file but with a lowered cap, so exhaustion
 *  happens after a known number of pages instead of after fifty. */
function cappedBudget(h: Harness, runId: string, capability: string, searchPagesPerDay: number) {
  const ledger = BudgetLedger.open({ path: h.budgetPath, limits: { searchPagesPerDay } });
  return new RunBudget(ledger, runId, capability);
}

describe("runPaged — budget exhaustion mid-run", () => {
  it("stops cleanly, keeps every page it proved, and leaves a resumable checkpoint", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    const outcome = await runPaged({
      run: s.run,
      budget: cappedBudget(h, s.run.runId, "salesnav.leads.list", 2),
      archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    s.close();

    expect(outcome.stop).toBe("budget-exhausted");
    expect(outcome.complete).toBe(false);
    expect(outcome.pages.map((p) => p.page)).toEqual([1, 2]);
    expect(outcome.resumeToken).toBe(h.runId());

    // The two proved pages are still claimed by the checkpoint, with their
    // bytes on disk. Nothing about running out of budget discards work.
    const state = h.state()!;
    expect(state.pages).toHaveLength(2);
    expect(state.stop).toBe("budget-exhausted");
    expect(h.archiveFiles()).toHaveLength(2 * CAPTURES_PER_PAGE);
  });

  it("names the cap that refused and offers the resume", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    const outcome = await runPaged({
      run: s.run,
      budget: cappedBudget(h, s.run.runId, "salesnav.leads.list", 2),
      archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    s.close();

    expect(outcome.stopDetail?.code).toBe("BUDGET_EXCEEDED");
    const err = budgetStopError(outcome);
    expect(err.exit).toBe(EXIT.BUDGET);
    expect(err.action).toBe("RESUME");
    expect(err.message).toContain(`--run-id=${h.runId()}`);
    expect(err.message).toContain("search_page");
  });

  it("resumes after the window clears without re-spending the proved pages", async () => {
    h = harness({ pages: 4 });
    const first = h.session();
    await runPaged({
      run: first.run,
      budget: cappedBudget(h, first.run.runId, "salesnav.leads.list", 2),
      archive: first.archive, source: first.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    first.close();
    expect(h.ledgerCount("search_page")).toBe(2);

    // A day later, the window has moved on: the same ledger, the full cap.
    const second = h.session();
    const done = await runPaged({
      run: second.run, budget: second.budget, archive: second.archive, source: second.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    second.close();

    expect(done.stop).toBe("end-of-results");
    expect(done.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    expect(h.ledgerCount("search_page")).toBe(4);
    expect(h.archiveFiles()).toHaveLength(4 * CAPTURES_PER_PAGE);
  });

  it("wastes at most the cheaper line when the cost's second kind is refused", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    const outcome = await runPaged({
      run: s.run,
      budget: cappedBudget(h, s.run.runId, "salesnav.leads.list", 1),
      archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    s.close();

    expect(outcome.pages).toHaveLength(1);
    // The refusal is caught by `check`, before either line commits — the page
    // load is not wasted at all.
    expect(outcome.wasted).toEqual({ page_loads: 0, search_pages: 0 });
    expect(h.ledgerCount("page_load")).toBe(1);
    expect(h.ledgerCount("search_page")).toBe(1);
  });

  it("a refusal on the very first page is the refusal itself, not a partial run", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    await expect(runPaged({
      run: s.run,
      budget: cappedBudget(h, s.run.runId, "salesnav.leads.list", 0),
      archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", exit: EXIT.BUDGET });
    s.close();

    expect(h.state()?.stop).toBe("budget-exhausted");
    expect(h.archiveFiles()).toHaveLength(0);
  });
});

describe("salesnav sub-caps (D153 pattern)", () => {
  const family = [
    "salesnav.leads.list", "salesnav.accounts.list", "salesnav.probe", "salesnav.savedsearch.list",
  ] as const;

  it("every salesnav capability is capped explicitly, not by the fallback", () => {
    for (const name of family) expect(CAPABILITY_SUB_CAPS[name]).toBeDefined();
  });

  it("every sub-cap sits well under the global day", () => {
    for (const name of family) {
      const caps = subCapsFor(name);
      expect(caps.searchPagesPerDay).toBeLessThanOrEqual(DEFAULT_BUDGET_LIMITS.searchPagesPerDay / 2);
      expect(caps.pageLoadsPerDay).toBeLessThan(DEFAULT_BUDGET_LIMITS.pageLoadsPerDay);
    }
  });

  it("no salesnav capability may open a profile", () => {
    for (const name of family) expect(subCapsFor(name).distinctProfilesPerDay).toBe(0);
  });

  it("page loads and search pages move together, because a page costs one of each", () => {
    for (const name of ["salesnav.leads.list", "salesnav.accounts.list", "salesnav.probe"] as const) {
      expect(subCapsFor(name).pageLoadsPerDay).toBe(subCapsFor(name).searchPagesPerDay);
    }
  });

  it("savedsearch.list is capped at zero search pages until Task 37 measures it", () => {
    expect(subCapsFor("salesnav.savedsearch.list").searchPagesPerDay).toBe(0);
    expect(subCapsFor("salesnav.savedsearch.list").pageLoadsPerDay).toBeGreaterThan(0);
  });

  it("a capability at its own cap is refused while the global budget still has room", async () => {
    h = harness({ pages: 100, capability: "salesnav.probe" });
    const s = h.session();
    const outcome = await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.probe", plan: "plan-a", ...silent,
    }) as PagedRunOutcome;
    s.close();

    // Six pages: the probe's own cap. The global 50/day is nowhere near spent.
    expect(outcome.pages).toHaveLength(subCapsFor("salesnav.probe").searchPagesPerDay);
    expect(outcome.stop).toBe("budget-exhausted");
    expect(h.ledgerCount("search_page")).toBeLessThan(DEFAULT_BUDGET_LIMITS.searchPagesPerDay);

    const err = budgetStopError(outcome);
    expect(err.exit).toBe(EXIT.BUDGET);
    expect(outcome.stopDetail?.evidence).toContain("salesnav.probe");
    expect(outcome.stopDetail?.message).toContain("capability salesnav.probe");
  });
});
