import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPaged } from "../src/core/paged/run.js";
import type { PagedRunOutcome } from "../src/core/paged/types.js";
import { CAPTURES_PER_PAGE, KILL_POINTS, Killed, harness, type Harness, type Kill } from "./helpers/paged.js";

const silent = { sleep: async () => {}, rng: () => 0.5 };
const PAGES = 3;

let h: Harness;
afterEach(() => h?.cleanup());

/** One session of a paged run. Returns the outcome, or the kill that stopped it. */
async function attempt(kill: Kill = null): Promise<PagedRunOutcome | Killed> {
  const s = h.session(kill);
  try {
    return await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
  } catch (e) {
    if (e instanceof Killed) return e;
    throw e;
  } finally {
    s.close();
  }
}

/** Runs to completion however many resumes it takes, killing exactly once. */
async function killAndResume(kill: Kill): Promise<PagedRunOutcome> {
  const first = await attempt(kill);
  if (!(first instanceof Killed)) return first;
  for (let i = 0; i < 5; i++) {
    const next = await attempt(null);
    if (!(next instanceof Killed)) return next;
  }
  throw new Error("run never converged");
}

function assertConverged(outcome: PagedRunOutcome, h: Harness): void {
  expect(outcome.stop).toBe("end-of-results");
  expect(outcome.complete).toBe(true);

  // 1. Every page, once, in order.
  expect(outcome.pages.map((p) => p.page)).toEqual([1, 2, 3]);

  // 2. Every claimed byte is on disk, and no two pages claim the same bytes.
  const files = h.archiveFiles();
  const claimed = outcome.pages.flatMap((p) => p.archive_ids);
  for (const id of claimed) expect(files).toContain(id);
  expect(new Set(claimed).size).toBe(claimed.length);
  expect(claimed).toHaveLength(PAGES * CAPTURES_PER_PAGE);

  // 3. Every byte on disk is either claimed by exactly one page or declared an
  //    orphan. Nothing is unaccounted for, and nothing was deleted to tidy up.
  const orphans = new Set(outcome.orphans);
  for (const id of claimed) expect(orphans.has(id)).toBe(false);
  expect(files.length).toBe(claimed.length + orphans.size);

  // 4. The ledger never under-counts. Every line is either a page that was
  //    loaded, a spend the crash wasted (asserted *present*, not absent), or —
  //    for a crash inside the spend phase itself — inside the one-line window
  //    the run reports as unconfirmed. It is never below `pages`, which is the
  //    unpaid-load case, and it is never above the accounted bound, which is
  //    the ledger inventing spend nobody made.
  for (const kind of ["search_page", "page_load"] as const) {
    const key = kind === "search_page" ? "search_pages" : "page_loads";
    const floor = PAGES + outcome.wasted[key];
    expect(h.ledgerCount(kind)).toBeGreaterThanOrEqual(floor);
    expect(h.ledgerCount(kind)).toBeLessThanOrEqual(floor + outcome.unconfirmed[key]);
  }
  expect(h.ledgerCount("profile_open")).toBe(0);
}

describe("runPaged — killed between every adjacent pair of steps", () => {
  for (const point of KILL_POINTS) {
    for (let page = 1; page <= PAGES; page++) {
      it(`converges after a kill at ${point} on page ${page}`, async () => {
        h = harness({ pages: PAGES });
        const outcome = await killAndResume({ point, page });
        assertConverged(outcome, h);
      });
    }
  }
});

describe("runPaged — what each kill costs", () => {
  it("a kill after the bytes are all on disk adopts the page and never re-spends it", async () => {
    h = harness({ pages: PAGES });
    const outcome = await killAndResume({ point: "after-archive", page: 2 });

    expect(outcome.wasted).toEqual({ page_loads: 0, search_pages: 0 });
    expect(outcome.orphans).toEqual([]);
    expect(h.ledgerCount("search_page")).toBe(PAGES);
    expect(h.archiveFiles()).toHaveLength(PAGES * CAPTURES_PER_PAGE);
    expect(outcome.warnings.map((w) => w.code)).toContain("RESUMED_PAGE_ADOPTED");
  });

  it("a torn archive is re-spent, re-loaded, and its bytes are kept as orphans", async () => {
    h = harness({ pages: PAGES });
    const outcome = await killAndResume({ point: "mid-archive", page: 2 });

    expect(outcome.wasted.search_pages).toBe(1);
    expect(outcome.orphans).toHaveLength(CAPTURES_PER_PAGE - 1);
    expect(h.ledgerCount("search_page")).toBe(PAGES + 1);
    expect(outcome.respentPages).toContain(2);
    expect(outcome.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(["RESUMED_PAGE_RESPENT", "RESUMED_ORPHAN_CAPTURES"]),
    );
  });

  it("a kill before the load wastes the spend and archives nothing", async () => {
    h = harness({ pages: PAGES });
    const outcome = await killAndResume({ point: "before-load", page: 2 });

    expect(outcome.wasted).toEqual({ page_loads: 1, search_pages: 1 });
    expect(outcome.orphans).toEqual([]);
    expect(h.ledgerCount("search_page")).toBe(PAGES + 1);
    expect(h.archiveFiles()).toHaveLength(PAGES * CAPTURES_PER_PAGE);
  });

  it("a kill inside the spend phase reports the line it could not account for", async () => {
    h = harness({ pages: PAGES });
    const outcome = await killAndResume({ point: "between-spends", page: 2 });

    // The kill lands between one ledger line committing and the checkpoint that
    // would have recorded it — the one irreducible window (D347). The page load
    // really is on the ledger; the run can only say it might be, and does.
    expect(h.ledgerCount("page_load")).toBe(PAGES + 1);
    expect(h.ledgerCount("search_page")).toBe(PAGES);
    expect(outcome.unconfirmed.page_loads).toBe(1);
    expect(outcome.wasted.search_pages).toBe(0);
    expect(h.state()?.wasted.some((w) => w.reason === "crash-in-spend")).toBe(true);
  });
});

describe("runPaged — resume corroborates the checkpoint against the archive", () => {
  it("re-runs a completed page whose bytes are gone, and says so", async () => {
    h = harness({ pages: PAGES });
    const first = await attempt(null);
    expect(first).not.toBeInstanceOf(Killed);

    // The checkpoint still claims page 2. The bytes do not exist.
    const state = h.state()!;
    const page2 = state.pages.find((p) => p.page === 2)!;
    const runDir = join(h.runsDir, h.runId()!, "raw");
    for (const id of page2.archive_ids) rmSync(join(runDir, id));
    const survivors = h.archiveFiles();

    const second = await attempt(null) as PagedRunOutcome;

    expect(second.respentPages).toEqual([2, 3]);
    expect(second.warnings.map((w) => w.code)).toContain("RESUMED_PAGE_RESPENT");
    expect(second.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    // Pages 2 and 3 were paid for twice; page 1 was not.
    expect(h.ledgerCount("search_page")).toBe(PAGES + 2);
    // Page 3's original bytes were never deleted, so they survive as orphans.
    expect(second.orphans).toHaveLength(CAPTURES_PER_PAGE);
    for (const id of second.orphans) expect(survivors).toContain(id);
  });

  it("drops every page after a hole, because the cursor chain runs through it", async () => {
    h = harness({ pages: 4 });
    await attempt(null);

    const state = h.state()!;
    const runDir = join(h.runsDir, h.runId()!, "raw");
    rmSync(join(runDir, state.pages.find((p) => p.page === 2)!.archive_ids[0]!));

    const second = await attempt(null) as PagedRunOutcome;
    expect(second.respentPages).toEqual([2, 3, 4]);
    expect(second.pages.map((p) => p.page)).toEqual([1, 2, 3, 4]);
  });

  it("a second run with nothing left to do re-spends nothing", async () => {
    h = harness({ pages: PAGES });
    await attempt(null);
    const before = h.ledgerCount("search_page");

    const second = await attempt(null) as PagedRunOutcome;

    // The last page said there was no next one, and the checkpoint remembers
    // that — so the second run pays for nothing at all.
    expect(second.stop).toBe("end-of-results");
    expect(second.pages).toHaveLength(PAGES);
    expect(second.loaded).toHaveLength(0);
    expect(h.ledgerCount("search_page")).toBe(before);
  });

  it("refuses to resume a run id under a different plan", async () => {
    h = harness({ pages: PAGES });
    const first = h.session();
    let pages = 0;
    await runPaged({
      run: first.run, budget: first.budget, archive: first.archive, source: first.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
      stopRequested: () => (pages++ >= 1 ? "paused" : null),
    });
    first.close();

    const second = h.session();
    await expect(runPaged({
      run: second.run, budget: second.budget, archive: second.archive, source: second.source,
      capability: "salesnav.leads.list", plan: "plan-b", ...silent,
    })).rejects.toMatchObject({ code: "PAGED_RESUME_PLAN_MISMATCH", exit: 1 });
    second.close();

    expect(h.ledgerCount("search_page")).toBe(1);
  });

  it("refuses paged state written by a version it cannot read", async () => {
    h = harness({ pages: PAGES });
    const s = h.session();
    s.run.checkpoint({ paged: { kind: "paged-run/v99", pages: [] } });
    await expect(runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    })).rejects.toMatchObject({ code: "PAGED_CHECKPOINT_UNKNOWN_VERSION" });
    s.close();

    expect(h.ledgerCount("search_page")).toBe(0);
  });

  it("leaves a capability's own checkpoint state untouched", async () => {
    h = harness({ pages: 2 });
    const s = h.session();
    s.run.checkpoint({ mine: { cursor: "abc" } });
    await runPaged({
      run: s.run, budget: s.budget, archive: s.archive, source: s.source,
      capability: "salesnav.leads.list", plan: "plan-a", ...silent,
    });
    const stored = s.run.lastCheckpoint<{ mine?: unknown; paged?: unknown }>();
    s.close();

    expect(stored?.mine).toEqual({ cursor: "abc" });
    expect(stored?.paged).toBeDefined();
  });
});
