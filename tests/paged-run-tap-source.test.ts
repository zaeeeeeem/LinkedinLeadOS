import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RawArchive } from "../src/core/archive/raw.js";
import { BudgetLedger } from "../src/core/budget/ledger.js";
import type { SpendKind } from "../src/core/budget/constants.js";
import { RunBudget } from "../src/cli/budget.js";
import { RunContext } from "../src/core/run/context.js";
import { runPaged } from "../src/core/paged/run.js";
import type { PageLoad, PageRequest, PagedRunOutcome, PagedSource } from "../src/core/paged/types.js";

/**
 * The **tap-driven** source shape: the bytes are already on disk when the load
 * reports them, so it hands back `archived` rather than `captures`.
 *
 * This is how every live capability will use the loop, and it differs from the
 * offline shape in one way that matters on resume: the archive also holds every
 * *other* body the page fetched — chrome, entitlements, telemetry — which the
 * load never claims. A resume that measured "did all its bytes land" by counting
 * entries above the attempt's high-water mark would therefore find more than it
 * expected on an ordinary page, refuse to adopt, and re-spend a page that was
 * entirely on disk. That is D346 read backwards, and these tests pin it.
 */

/** Bodies the page's own load claims. */
const CLAIMED_PER_PAGE = 2;
/** Bodies the tap archived that the load does not claim. */
const BACKGROUND_PER_PAGE = 3;

class Killed extends Error {}

type Harness = ReturnType<typeof harness>;

function countLedger(path: string, kind: SpendKind): number {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return 0;
  }
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const row = JSON.parse(line) as { kind: SpendKind; n: number };
    if (row.kind === kind) n += row.n;
  }
  return n;
}

function harness(o: { pages: number; killAfterArchivingPage?: number }) {
  const root = mkdtempSync(join(tmpdir(), "linkedin-os-paged-tap-"));
  const runsDir = join(root, "runs");
  const budgetPath = join(root, "budget.ndjson");
  const capability = "salesnav.leads.list";
  let runId: string | null = null;
  let archiveDir: string | null = null;

  function session(killAfterArchivingPage: number | null) {
    const run = RunContext.open({
      capability,
      ...(runId === null ? { args: { plan: "fake" } } : { runId }),
      runsDir,
    });
    runId = run.runId;
    archiveDir = run.paths.raw;

    const ledger = BudgetLedger.open({ path: budgetPath });
    const budget = new RunBudget(ledger, run.runId, capability);
    const archive = new RawArchive(run.paths.raw);

    const source: PagedSource = {
      async loadPage(req: PageRequest): Promise<PageLoad> {
        // The tap archives everything the page fetched, claimed or not.
        const claimed = [];
        for (let i = 0; i < CLAIMED_PER_PAGE; i++) {
          claimed.push(await archive.archive({
            body: JSON.stringify({ page: req.page, part: i }),
            url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?page=${req.page}&part=${i}`,
            status: 200,
          }));
        }
        for (let i = 0; i < BACKGROUND_PER_PAGE; i++) {
          await archive.archive({
            body: JSON.stringify({ chrome: i, page: req.page }),
            url: `https://www.linkedin.com/sales-api/salesApiNavChrome?n=${i}&page=${req.page}`,
            status: 200,
          });
        }
        return {
          archived: claimed,
          items: 5,
          hasMore: req.page < o.pages,
          fingerprint: `p${req.page}`,
        };
      },
    };

    // The kill lands where D346 lives: the page's bytes are on disk and the
    // attempt names them, but the completion checkpoint has not been written.
    // Wrapping the checkpoint rather than the source is what puts it exactly
    // there — a throw inside `loadPage` would be a different boundary.
    if (killAfterArchivingPage !== null) {
      const original = run.checkpoint.bind(run);
      let fired = false;
      (run as unknown as { checkpoint: (s: unknown) => void }).checkpoint = (state: unknown) => {
        original(state as never);
        if (fired) return;
        const paged = (state as { paged?: { attempt?: { page: number; archive_ids?: string[] } } }).paged;
        if (paged?.attempt?.page !== killAfterArchivingPage) return;
        if (paged.attempt.archive_ids === undefined) return;
        fired = true;
        throw new Killed("killed with the page archived and named, before it completed");
      };
    }

    return { run, budget, archive, source, close: () => {
      try {
        (run as unknown as { logger: { close(): void } }).logger.close();
      } catch { /* already closed */ }
    } };
  }

  return {
    session,
    ledgerCount: (kind: SpendKind) => countLedger(budgetPath, kind),
    archiveFiles: () =>
      archiveDir === null ? [] : readdirSync(archiveDir).filter((f) => f.endsWith(".json.gz")).sort(),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const silent = { sleep: async () => {}, rng: () => 0.5 };

async function attempt(h: Harness, kill: number | null): Promise<PagedRunOutcome | Killed> {
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

let h: Harness;
afterEach(() => h?.cleanup());

describe("runPaged — a source that archives its own bytes through the tap", () => {
  it("runs clean, claiming only the bodies the load named", async () => {
    h = harness({ pages: 3 });
    const outcome = await attempt(h, null) as PagedRunOutcome;

    expect(outcome.stop).toBe("end-of-results");
    expect(outcome.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    for (const page of outcome.pages) expect(page.archive_ids).toHaveLength(CLAIMED_PER_PAGE);
    // The background bodies are on disk and claimed by nobody. That is correct
    // and is not an orphan: an orphan is a spend's bytes that no page proved.
    expect(h.archiveFiles()).toHaveLength(3 * (CLAIMED_PER_PAGE + BACKGROUND_PER_PAGE));
    expect(outcome.orphans).toEqual([]);
    expect(h.ledgerCount("search_page")).toBe(3);
  });

  // The regression this file exists for. Before the attempt recorded its ids,
  // adoption compared `expected` against *every* entry above the attempt's
  // high-water mark — five here, not two — so a page whose bytes were all on
  // disk was re-spent on every resume.
  it("adopts a page whose bytes are all on disk, and never pays for it twice", async () => {
    h = harness({ pages: 3 });
    const killed = await attempt(h, 2);
    expect(killed).toBeInstanceOf(Killed);

    const outcome = await attempt(h, null) as PagedRunOutcome;
    expect(outcome.stop).toBe("end-of-results");
    expect(outcome.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(outcome.respentPages).toEqual([]);
    expect(outcome.wasted).toEqual({ page_loads: 0, search_pages: 0 });
    expect(outcome.warnings.map((w) => w.code)).toContain("RESUMED_PAGE_ADOPTED");

    // Three pages, three ledger lines of each kind. The contract's whole point.
    expect(h.ledgerCount("search_page")).toBe(3);
    expect(h.ledgerCount("page_load")).toBe(3);
  });

  // Adoption must still turn on the bytes actually being there. A named id that
  // is missing is a torn archive, and a torn page is re-loaded and re-paid —
  // never adopted on the strength of the checkpoint's own claim.
  it("re-spends the page when a named body is missing from disk", async () => {
    h = harness({ pages: 3 });
    const killed = await attempt(h, 2);
    expect(killed).toBeInstanceOf(Killed);

    // Delete one of the bytes the attempt claimed, as a torn write would.
    const s = h.session(null);
    const state = (JSON.parse(
      readFileSync(join(s.run.paths.dir, "checkpoint.json"), "utf8"),
    ) as { state: { paged: { attempt: { archive_ids: string[] } } } }).state.paged;
    const victim = state.attempt.archive_ids[0]!;
    s.close();
    rmSync(join(s.run.paths.raw, victim));

    const outcome = await attempt(h, null) as PagedRunOutcome;
    expect(outcome.respentPages).toContain(2);
    expect(outcome.wasted.search_pages).toBe(1);
    expect(h.ledgerCount("search_page")).toBe(4);
    expect(outcome.warnings.map((w) => w.code)).toContain("RESUMED_PAGE_RESPENT");
  });
});
