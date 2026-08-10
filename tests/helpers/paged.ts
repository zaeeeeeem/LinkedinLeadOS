import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawArchive, type ArchivedCapture, type CaptureInput } from "../../src/core/archive/raw.js";
import { BudgetLedger } from "../../src/core/budget/ledger.js";
import type { SpendKind } from "../../src/core/budget/constants.js";
import { RunBudget } from "../../src/cli/budget.js";
import { RunContext } from "../../src/core/run/context.js";
import { readPagedState } from "../../src/core/paged/checkpoint.js";
import type { PageLoad, PageRequest, PagedArchive, PagedBudget, PagedCheckpointState, PagedSource } from "../../src/core/paged/types.js";

/** Where a kill lands, named by the step boundary it sits on. The eight points
 *  below are every adjacent pair of steps in one page's cycle. */
export type KillPoint =
  | "between-spends"           // page_load committed, search_page not yet
  | "after-spend"              // both committed, attempt checkpoint not written
  | "before-load"              // attempt checkpoint written, page not requested
  | "after-load"               // page in memory, expected-count not written
  | "before-archive"           // expected-count written, no body on disk
  | "mid-archive"              // some bodies on disk, not all
  | "after-archive"            // every body on disk, completion not written
  | "after-complete";          // page complete, next page not started

export const KILL_POINTS: KillPoint[] = [
  "between-spends", "after-spend", "before-load", "after-load",
  "before-archive", "mid-archive", "after-archive", "after-complete",
];

export class Killed extends Error {
  constructor(readonly point: KillPoint, readonly page: number) {
    super(`killed at ${point} on page ${page}`);
    this.name = "Killed";
  }
}

export type Kill = { point: KillPoint; page: number } | null;

/** Bodies per page. Two, so `mid-archive` is a reachable state. */
export const CAPTURES_PER_PAGE = 2;

export type FakeSourceOptions = {
  pages: number;
  itemsPerPage?: number;
  /** Return the same fingerprint for every page, to exercise `no-advance`. */
  stuck?: boolean;
};

export type Harness = {
  root: string;
  runsDir: string;
  budgetPath: string;
  /** Opens a session against the same run id (or a fresh run the first time). */
  session(kill?: Kill): Session;
  loads(): { page: number; ledgerAtLoad: Record<SpendKind, number> }[];
  ledgerCount(kind: SpendKind): number;
  archiveFiles(): string[];
  state(): PagedCheckpointState | null;
  runId(): string | null;
  cleanup(): void;
};

export type Session = {
  run: RunContext;
  budget: PagedBudget;
  archive: PagedArchive;
  source: PagedSource;
  /** Releases the event-log file descriptor. A kill matrix opens one context
   *  per scenario per resume, and leaked fds hit the process limit long before
   *  the matrix finishes. */
  close(): void;
};

/** `RunContext.finish` needs a receipt to close the log; a killed run has none
 *  and the log is already flushed (writes are synchronous), so the descriptor
 *  is closed directly. */
function closeQuietly(run: RunContext): void {
  try {
    (run as unknown as { logger: { close(): void } }).logger.close();
  } catch { /* already closed */ }
}

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

/**
 * A whole paged run, offline: a real `RunContext` in a temp dir, a real
 * `RawArchive`, a real ledger file, and a page source that hands back invented
 * bodies. The only fake thing is LinkedIn.
 */
export function harness(o: FakeSourceOptions & { capability?: string }): Harness {
  const root = mkdtempSync(join(tmpdir(), "linkedin-os-paged-"));
  const runsDir = join(root, "runs");
  const budgetPath = join(root, "budget.ndjson");
  const capability = o.capability ?? "salesnav.leads.list";
  const itemsPerPage = o.itemsPerPage ?? 5;

  let runId: string | null = null;
  let archiveDir: string | null = null;
  const loads: { page: number; ledgerAtLoad: Record<SpendKind, number> }[] = [];

  function session(kill: Kill = null): Session {
    const run = RunContext.open({
      capability,
      ...(runId === null ? { args: { plan: "fake" } } : { runId }),
      runsDir,
    });
    runId = run.runId;
    archiveDir = run.paths.raw;

    const ledger = BudgetLedger.open({ path: budgetPath });
    const realBudget = new RunBudget(ledger, run.runId, capability);
    const realArchive = new RawArchive(run.paths.raw);

    let spendsThisPage = 0;
    let currentPage = 0;
    let archivedThisPage = 0;

    const budget: PagedBudget = {
      check: (i) => realBudget.check(i),
      async spend(i) {
        const record = await realBudget.spend(i);
        spendsThisPage += 1;
        if (kill && kill.point === "between-spends" && kill.page === currentPage + 1 && spendsThisPage === 1) {
          throw new Killed(kill.point, kill.page);
        }
        return record;
      },
    };

    const archive: PagedArchive = {
      async archive(input: CaptureInput): Promise<ArchivedCapture> {
        if (kill && kill.point === "before-archive" && kill.page === currentPage && archivedThisPage === 0) {
          throw new Killed(kill.point, kill.page);
        }
        const entry = await realArchive.archive(input);
        archivedThisPage += 1;
        if (kill && kill.point === "mid-archive" && kill.page === currentPage
          && archivedThisPage === CAPTURES_PER_PAGE - 1) {
          throw new Killed(kill.point, kill.page);
        }
        if (kill && kill.point === "after-archive" && kill.page === currentPage
          && archivedThisPage === CAPTURES_PER_PAGE) {
          throw new Killed(kill.point, kill.page);
        }
        return entry;
      },
      list: () => realArchive.list(),
    };

    const source: PagedSource = {
      async loadPage(req: PageRequest): Promise<PageLoad> {
        currentPage = req.page;
        spendsThisPage = 0;
        archivedThisPage = 0;
        if (kill && kill.point === "before-load" && kill.page === req.page) {
          throw new Killed(kill.point, kill.page);
        }
        loads.push({
          page: req.page,
          ledgerAtLoad: {
            page_load: countLedger(budgetPath, "page_load"),
            search_page: countLedger(budgetPath, "search_page"),
            profile_open: countLedger(budgetPath, "profile_open"),
          },
        });
        const load: PageLoad = {
          captures: Array.from({ length: CAPTURES_PER_PAGE }, (_, i) => ({
            body: JSON.stringify({ page: req.page, part: i, rows: itemsPerPage }),
            url: `https://www.linkedin.com/sales/api/leadSearch?page=${req.page}&part=${i}`,
            status: 200,
          })),
          items: itemsPerPage,
          hasMore: req.page < o.pages,
          cursor: { after: req.page },
          fingerprint: o.stuck ? "same" : `p${req.page}`,
        };
        if (kill && kill.point === "after-load" && kill.page === req.page) {
          throw new Killed(kill.point, kill.page);
        }
        return load;
      },
    };

    // The two checkpoint-boundary kills. Each fires at most once per session,
    // or a resume would be killed again by the very write that recorded the
    // state it is resuming from.
    let fired = false;
    if (kill && (kill.point === "after-spend" || kill.point === "after-complete")) {
      wrapCheckpoint(run, () => {
        if (fired) return;
        const state = readPagedState(run);
        const hit = kill.point === "after-spend"
          ? state?.attempt?.page === kill.page && state.attempt.expected === null
          : state?.attempt === null && state.pages.some((p) => p.page === kill.page);
        if (!hit) return;
        fired = true;
        throw new Killed(kill.point, kill.page);
      });
    }

    return { run, budget, archive, source, close: () => closeQuietly(run) };
  }

  return {
    root,
    runsDir,
    budgetPath,
    session,
    loads: () => loads,
    ledgerCount: (kind) => countLedger(budgetPath, kind),
    archiveFiles: () =>
      archiveDir === null ? [] : readdirSync(archiveDir).filter((f) => f.endsWith(".json.gz")).sort(),
    // Read straight off disk rather than through a RunContext: opening one
    // would append a `resumed_at` entry and hold an event-log fd, which is a
    // side effect no assertion should have.
    state: () => {
      if (runId === null) return null;
      try {
        const raw = JSON.parse(readFileSync(join(runsDir, runId, "checkpoint.json"), "utf8")) as {
          state?: { paged?: PagedCheckpointState };
        };
        return raw.state?.paged ?? null;
      } catch {
        return null;
      }
    },
    runId: () => runId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Runs `after` immediately following every checkpoint write on this context. */
function wrapCheckpoint(run: RunContext, after: () => void): void {
  const original = run.checkpoint.bind(run);
  (run as unknown as { checkpoint: (s: unknown) => void }).checkpoint = (state: unknown) => {
    original(state);
    after();
  };
}
