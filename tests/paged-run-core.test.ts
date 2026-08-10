import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPaged } from "../src/core/paged/run.js";
import { PAUSE_FILE_NAME, MAX_PAGES_PER_RUN, RESULTS_PAGE_COST } from "../src/core/paged/constants.js";
import { anyStop, installSignalPause, pauseFileStop } from "../src/core/paged/pause.js";
import { decideDwell, nextDwellMs } from "../src/core/paged/dwell.js";
import { CAPTURES_PER_PAGE, harness, type Harness } from "./helpers/paged.js";

const silent = { sleep: async () => {}, rng: () => 0.5 };

let h: Harness;
afterEach(() => h?.cleanup());

async function runOnce(o: { pages: number } & Record<string, unknown>) {
  h = harness({ pages: o.pages, ...(o["stuck"] === true ? { stuck: true } : {}) });
  const s = h.session();
  try {
    return await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
      ...(o["limit"] === undefined ? {} : { limit: o["limit"] as number }),
      ...(o["maxPages"] === undefined ? {} : { maxPages: o["maxPages"] as number }),
      ...(o["stopRequested"] === undefined ? {} : { stopRequested: o["stopRequested"] as () => null }),
    });
  } finally {
    s.close();
  }
}

describe("runPaged — the happy path", () => {
  it("loads every page once, archives it, and checkpoints it", async () => {
    const outcome = await runOnce({ pages: 3 });

    expect(outcome.stop).toBe("end-of-results");
    expect(outcome.complete).toBe(true);
    expect(outcome.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(outcome.items).toBe(15);
    expect(outcome.loaded).toHaveLength(3);
    expect(h.archiveFiles()).toHaveLength(3 * CAPTURES_PER_PAGE);
    expect(outcome.orphans).toEqual([]);
    expect(outcome.wasted).toEqual({ page_loads: 0, search_pages: 0 });
  });

  it("charges one search page and one page load per results page", async () => {
    const outcome = await runOnce({ pages: 3 });

    expect(RESULTS_PAGE_COST).toEqual({ page_loads: 1, search_pages: 1 });
    expect(h.ledgerCount("search_page")).toBe(3);
    expect(h.ledgerCount("page_load")).toBe(3);
    expect(h.ledgerCount("profile_open")).toBe(0);
    expect(outcome.spent).toEqual({ page_loads: 3, search_pages: 3 });
  });

  it("spends for page N strictly before page N is requested", async () => {
    await runOnce({ pages: 3 });

    // Read inside the source at the moment of the load: the ledger already
    // carries this page's lines. This is the interleaving the contract forbids
    // reversing, and the mutation check in paged-run-resume proves it bites.
    for (const [i, load] of h.loads().entries()) {
      expect(load.ledgerAtLoad.search_page).toBe(i + 1);
      expect(load.ledgerAtLoad.page_load).toBe(i + 1);
    }
  });

  it("checkpoints a page only after its bytes are on disk", async () => {
    const outcome = await runOnce({ pages: 2 });
    const files = new Set(h.archiveFiles());

    for (const page of outcome.pages) {
      expect(page.archive_ids).toHaveLength(CAPTURES_PER_PAGE);
      for (const id of page.archive_ids) expect(files.has(id)).toBe(true);
    }
  });

  it("hands each page the cursor the previous page returned", async () => {
    h = harness({ pages: 3 });
    const seen: unknown[] = [];
    const s = h.session();
    const source = {
      loadPage: async (req: Parameters<typeof s.source.loadPage>[0]) => {
        seen.push(req.cursor);
        return s.source.loadPage(req);
      },
    };
    await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    s.close();

    expect(seen).toEqual([undefined, { after: 1 }, { after: 2 }]);
  });
});

describe("runPaged — bounds", () => {
  it("stops at --limit without loading a page it does not need", async () => {
    const outcome = await runOnce({ pages: 10, limit: 12 });

    expect(outcome.stop).toBe("limit-reached");
    expect(outcome.complete).toBe(false);
    expect(outcome.pages).toHaveLength(3); // 5 items a page: 3 pages crosses 12
    expect(h.ledgerCount("search_page")).toBe(3);
  });

  it("stops at maxPages rather than reading a search to the bottom", async () => {
    const outcome = await runOnce({ pages: 100, maxPages: 2 });

    expect(outcome.stop).toBe("page-limit");
    expect(outcome.complete).toBe(false);
    expect(outcome.pages).toHaveLength(2);
  });

  it("never lets maxPages raise the ceiling", async () => {
    const outcome = await runOnce({ pages: 500, maxPages: 999 });

    expect(outcome.pages).toHaveLength(MAX_PAGES_PER_RUN);
    expect(h.ledgerCount("search_page")).toBe(MAX_PAGES_PER_RUN);
  });

  it("stops when the surface hands back the page it already gave", async () => {
    const outcome = await runOnce({ pages: 10, stuck: true });

    expect(outcome.stop).toBe("no-advance");
    expect(outcome.pages).toHaveLength(2);
  });

  it("refuses to checkpoint a page that produced no bytes", async () => {
    h = harness({ pages: 2 });
    const s = h.session();
    await expect(runPaged({
      run: s.run, budget: s.budget, archive: s.archive,
      source: { loadPage: async () => ({ hasMore: true, items: 3 }) },
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    })).rejects.toMatchObject({ code: "PAGED_PAGE_NO_BYTES" });
    s.close();

    expect(h.state()?.pages).toEqual([]);
  });
});

describe("runPaged — pause", () => {
  it("stops cleanly at a page boundary when a stop is requested", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    let pages = 0;
    const outcome = await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
      stopRequested: () => (pages++ >= 2 ? "paused" : null),
    });
    s.close();

    expect(outcome.stop).toBe("paused");
    expect(outcome.complete).toBe(false);
    expect(outcome.pages).toHaveLength(2);
    // The pause is asked before the spend, so nothing was paid for a page that
    // never loaded.
    expect(h.ledgerCount("search_page")).toBe(2);
    expect(outcome.wasted).toEqual({ page_loads: 0, search_pages: 0 });
    expect(outcome.resumeToken).toBe(h.runId());
  });

  it("a paused run resumes from its checkpoint and finishes", async () => {
    h = harness({ pages: 4 });
    const first = h.session();
    let pages = 0;
    const paused = await runPaged({
      run: first.run, budget: first.budget, archive: first.archive, source: first.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
      stopRequested: () => (pages++ >= 2 ? "paused" : null),
    });
    first.close();
    expect(paused.pages).toHaveLength(2);

    const second = h.session();
    const done = await runPaged({
      run: second.run, budget: second.budget, archive: second.archive, source: second.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    second.close();

    expect(done.stop).toBe("end-of-results");
    expect(done.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
    // The two proved pages were not paid for a second time.
    expect(h.ledgerCount("search_page")).toBe(4);
    expect(h.archiveFiles()).toHaveLength(4 * CAPTURES_PER_PAGE);
  });

  it("the PAUSE file in the run directory is a stop source", async () => {
    h = harness({ pages: 10 });
    const s = h.session();
    const stop = pauseFileStop(s.run.dir);
    expect(await stop()).toBeNull();

    let pages = 0;
    const outcome = await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
      stopRequested: () => {
        if (pages++ === 1) writeFileSync(join(s.run.dir, PAUSE_FILE_NAME), "");
        return stop();
      },
    });
    s.close();

    expect(existsSync(join(s.run.dir, PAUSE_FILE_NAME))).toBe(true);
    expect(outcome.stop).toBe("paused");
    expect(outcome.pages).toHaveLength(1);
  });
});

describe("installSignalPause", () => {
  function fakeProcess() {
    const handlers = new Map<string, (() => void)[]>();
    const killed: string[] = [];
    return {
      killed,
      on(sig: string, fn: () => void) { handlers.set(sig, [...(handlers.get(sig) ?? []), fn]); },
      off(sig: string, fn: () => void) {
        handlers.set(sig, (handlers.get(sig) ?? []).filter((h) => h !== fn));
      },
      kill(_pid: number, sig: string) { killed.push(sig); },
      pid: 1234,
      raise(sig: string) { for (const fn of [...(handlers.get(sig) ?? [])]) fn(); },
      count: (sig: string) => (handlers.get(sig) ?? []).length,
    };
  }

  it("the first signal asks for a pause instead of killing the process", () => {
    const proc = fakeProcess();
    const pause = installSignalPause({ process: proc as never });

    expect(pause.stop()).toBeNull();
    proc.raise("SIGINT");
    expect(pause.stop()).toBe("paused");
    expect(proc.killed).toEqual([]);
    pause.dispose();
  });

  it("the second signal restores the default and re-raises", () => {
    const proc = fakeProcess();
    const pause = installSignalPause({ process: proc as never });

    proc.raise("SIGINT");
    proc.raise("SIGINT");

    expect(proc.killed).toEqual(["SIGINT"]);
    expect(proc.count("SIGINT")).toBe(0);
    expect(proc.count("SIGTERM")).toBe(0);
  });

  it("dispose removes every handler it installed", () => {
    const proc = fakeProcess();
    const pause = installSignalPause({ process: proc as never });
    expect(proc.count("SIGINT")).toBe(1);
    pause.dispose();
    expect(proc.count("SIGINT")).toBe(0);
  });

  it("anyStop returns the first reason and asks sources in order", async () => {
    const asked: string[] = [];
    const stop = anyStop(
      () => { asked.push("a"); return null; },
      () => { asked.push("b"); return "paused"; },
      () => { asked.push("c"); return "page-limit"; },
    );
    expect(await stop()).toBe("paused");
    expect(asked).toEqual(["a", "b"]);
  });
});

describe("dwell", () => {
  it("stays inside the band across the whole distribution", () => {
    let micro = 0;
    let long = 0;
    for (let i = 0; i < 5000; i++) {
      const ms = nextDwellMs(Math.random);
      expect(ms).toBeGreaterThanOrEqual(1_200);
      expect(ms).toBeLessThanOrEqual(40_000);
      if (ms < 8_000) micro += 1;
      if (ms >= 8_000 + (40_000 - 8_000) * 0.6) long += 1;
    }
    // Both tails are populated: a run whose gaps are all one cluster is the
    // fixed cadence §8 forbids.
    expect(micro).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(0);
  });

  it("is not a constant", () => {
    const draws = new Set(Array.from({ length: 50 }, () => nextDwellMs(Math.random)));
    expect(draws.size).toBeGreaterThan(20);
  });

  it("takes a long break every fifth page", () => {
    expect(decideDwell(5, () => 0.5).kind).toBe("break");
    expect(decideDwell(10, () => 0.5).kind).toBe("break");
    expect(decideDwell(4, () => 0.5).kind).toBe("dwell");
    expect(decideDwell(0, () => 0.5).kind).toBe("dwell");
    expect(decideDwell(5, () => 0.5).ms).toBeGreaterThanOrEqual(90_000);
  });

  it("dwells between pages and never before the first", async () => {
    h = harness({ pages: 3 });
    const slept: number[] = [];
    const s = h.session();
    const outcome = await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a",
      rng: Math.random,
      sleep: async (ms) => { slept.push(ms); },
    });
    s.close();

    expect(slept).toHaveLength(2);
    expect(outcome.dwellMs).toBe(slept.reduce((a, b) => a + b, 0));
  });
});
