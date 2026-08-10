import type { Rng, Sleep } from "../input/random.js";
import type { RunContext } from "../run/context.js";
import { CapabilityError, EXIT, type Warning } from "../run/receipt.js";
import {
  MAX_PAGES_PER_RUN, RESULTS_PAGE_COST, ZERO_PAGE_COST, type PageCost,
} from "./constants.js";
import {
  addCost, emptyState, readPagedState, reconcile, totalCost, totalUnconfirmed, writePagedState,
} from "./checkpoint.js";
import { dwellBetweenPages } from "./dwell.js";
import type { StopRequest } from "./pause.js";
import {
  isComplete,
  type CompletedPage, type PageAttempt, type PagedArchive, type PagedBudget,
  type PagedCheckpointState, type PagedRunOutcome, type PageLoad, type PagedSource,
  type StopReason,
} from "./types.js";

export type PagedRunOptions = {
  run: Pick<RunContext, "runId" | "lastCheckpoint" | "checkpoint" | "log" | "resumed">;
  budget: PagedBudget;
  archive: PagedArchive;
  source: PagedSource;
  capability: string;
  /**
   * What is being paged, as a stable string — the normalized search URL is the
   * obvious one. A resume whose plan differs from the checkpoint's is refused.
   */
  plan: string;
  /** Ceiling on pages for this invocation. Never raises `MAX_PAGES_PER_RUN`. */
  maxPages?: number;
  /** Stop once this many result rows have been collected. `null` means the page
   *  ceiling is the only bound — there is no "read to the bottom" mode. */
  limit?: number | null;
  /** Overrides the per-page ledger cost. Only M5's own capabilities have any
   *  business passing this; it is here so a surface measured to cost something
   *  else can say so rather than lie in `cost()`. */
  cost?: PageCost;
  firstPage?: number;
  stopRequested?: StopRequest;
  rng?: Rng;
  sleep?: Sleep;
};

function noBytes(page: number): CapabilityError {
  return new CapabilityError({
    code: "PAGED_PAGE_NO_BYTES",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `page ${page} was paid for and loaded but produced no archived body — refusing to ` +
      `checkpoint a page the archive cannot prove`,
  });
}

/**
 * Turns a mid-run budget refusal into the receipt's error, at exit 7 with
 * `RESUME` as the action, keeping the refusal that named the cap as evidence.
 *
 * Exported rather than thrown by the loop: whether a partial paged run is a
 * failure or a result is the capability's call, and both callers so far want
 * the rows before they raise it.
 */
export function budgetStopError(outcome: PagedRunOutcome): CapabilityError {
  const detail = outcome.stopDetail;
  return new CapabilityError({
    code: "PAGED_RUN_BUDGET_STOP",
    exit: EXIT.BUDGET,
    action: "RESUME",
    retryable: false,
    message:
      `budget ran out after ${outcome.pages.length} page(s); the run is checkpointed and ` +
      `resumes with --run-id=${outcome.resumeToken} once the window clears` +
      (detail ? ` (${detail.message})` : ""),
    ...(detail?.evidence === undefined ? {} : { evidence: detail.evidence }),
  });
}

function isBudgetRefusal(e: unknown): e is CapabilityError {
  return e instanceof CapabilityError && e.exit === EXIT.BUDGET;
}

/**
 * What the pages already proved say about loading another one. Read from the
 * checkpoint, so it holds across a resume as well as inside one session.
 *
 * `no-advance`: the surface handed back a page identical to the one before it.
 * Paging on would re-read the same rows until the cap stopped the run. The
 * reference worker had no such guard — it trusted the pager's own page number,
 * which a re-render can advance without the results changing.
 */
function continuationStop(pages: readonly CompletedPage[]): StopReason | null {
  const last = pages[pages.length - 1];
  if (!last) return null;
  const previous = pages[pages.length - 2];
  if (previous?.fingerprint !== undefined && last.fingerprint !== undefined
    && previous.fingerprint === last.fingerprint) return "no-advance";
  if (!last.has_more) return "end-of-results";
  if (last.items === 0) return "empty-page";
  return null;
}

/** Kinds to spend for one page, cheapest global budget first (D344). */
function spendPlan(cost: PageCost): { kind: "page_load" | "search_page"; n: number }[] {
  const plan: { kind: "page_load" | "search_page"; n: number }[] = [];
  if (cost.page_loads > 0) plan.push({ kind: "page_load", n: cost.page_loads });
  if (cost.search_pages > 0) plan.push({ kind: "search_page", n: cost.search_pages });
  return plan;
}

/**
 * The paged capture loop: **spend → load → archive → checkpoint**, per page,
 * with a resume that corroborates the checkpoint against the archive on disk.
 *
 * See `README.md` in this directory for the contract and what survives a crash
 * at each of the four boundaries. Consume this; do not re-derive it.
 */
export async function runPaged(o: PagedRunOptions): Promise<PagedRunOutcome> {
  const cost = o.cost ?? RESULTS_PAGE_COST;
  const maxPages = Math.max(1, Math.min(o.maxPages ?? MAX_PAGES_PER_RUN, MAX_PAGES_PER_RUN));
  const firstPage = o.firstPage ?? 1;
  const warnings: Warning[] = [];

  // ---- resume, or start clean -------------------------------------------
  const stored = readPagedState(o.run);
  let state: PagedCheckpointState;
  const respentPages: number[] = [];
  if (stored) {
    const reconciled = await reconcile({ state: stored, archive: o.archive, plan: o.plan });
    state = reconciled.state;
    respentPages.push(...reconciled.respentPages);
    warnings.push(...reconciled.warnings);
    o.run.log("checkpoint.resume", {
      detail: {
        pages_proved: state.pages.length,
        pages_respent: reconciled.respentPages,
        page_adopted: reconciled.adoptedPage,
        orphan_captures: reconciled.orphansAdded.length,
      },
    });
    // Persisted before anything else spends: the reconciliation is itself a
    // fact about the run, and a crash right after it must not replay it.
    writePagedState(o.run, state);
  } else {
    state = emptyState({ capability: o.capability, plan: o.plan, cost });
    writePagedState(o.run, state);
  }

  const loaded: { page: number; load: PageLoad }[] = [];
  let spent: PageCost = { ...ZERO_PAGE_COST };
  let dwellMs = 0;
  let stop: StopReason | null = null;
  let stopDetail: PagedRunOutcome["stopDetail"];

  const itemsSoFar = () => state.pages.reduce((n, p) => n + p.items, 0);
  const lastPage = (): CompletedPage | undefined => state.pages[state.pages.length - 1];

  for (;;) {
    // Every reason to stop is evaluated here, against the checkpointed pages,
    // rather than at the bottom against the page just loaded. That is what
    // makes a resume behave identically to the session it continues: a run
    // whose last page said "no more" must not pay for another page just
    // because a different process is asking this time.
    if (state.pages.length >= maxPages) { stop = "page-limit"; break; }
    if (o.limit !== null && o.limit !== undefined && itemsSoFar() >= o.limit) { stop = "limit-reached"; break; }
    const continuation = continuationStop(state.pages);
    if (continuation) { stop = continuation; break; }

    // Dwell before every page but the first of this session — never a fixed
    // cadence, and never before the pause check, so a pause requested during a
    // four-minute break is honoured when it ends rather than a page later.
    let dwelt = 0;
    if (loaded.length > 0) {
      const { ms } = await dwellBetweenPages({
        pagesDone: state.pages.length,
        ...(o.rng === undefined ? {} : { rng: o.rng }),
        ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
      });
      dwellMs += ms;
      dwelt = ms;
    }

    const requested = await o.stopRequested?.();
    if (requested) { stop = requested; break; }

    const previous = lastPage();
    const page = previous ? previous.page + 1 : firstPage;
    const cursor = previous?.cursor;
    const phase = `page-${page}`;

    // ---- 1. spend ---------------------------------------------------------
    //
    // The archive's high-water mark is taken first: everything written at or
    // above it belongs to this attempt, which is what lets a resume tell this
    // attempt's bytes from every earlier page's.
    //
    // The attempt record is written *before* the first ledger line, naming what
    // is about to be committed. It is never read as proof of payment — a resume
    // always re-spends an attempt it cannot adopt — so writing it early cannot
    // produce an unpaid load, and it is the only way a crash mid-spend leaves
    // any trace at all.
    const seqBefore = (await o.archive.list()).reduce((max, e) => Math.max(max, e.seq + 1), 0);
    const respent = respentPages.includes(page);
    const attempt: PageAttempt = {
      page,
      spend_plan: cost,
      spent: { ...ZERO_PAGE_COST },
      spend_confirmed: false,
      spent_at: new Date().toISOString(),
      archive_seq_before: seqBefore,
      expected: null,
      items: null,
      hasMore: null,
      ...(cursor === undefined ? {} : { request_cursor: cursor }),
    };
    state.attempt = attempt;
    writePagedState(o.run, state);

    // Checked in full before any of it is committed, so a two-kind cost cannot
    // half-commit against a cap it was always going to fail.
    const plan = spendPlan(cost);
    try {
      for (const line of plan) await o.budget.check(line);
      for (const line of plan) {
        await o.budget.spend(line);
        attempt.spent = addCost(attempt.spent, line.kind === "page_load"
          ? { page_loads: line.n, search_pages: 0 }
          : { page_loads: 0, search_pages: line.n });
        writePagedState(o.run, state);
      }
      attempt.spend_confirmed = true;
      writePagedState(o.run, state);
    } catch (e) {
      if (!isBudgetRefusal(e)) throw e;
      const pagePaid = attempt.spent;
      spent = addCost(spent, pagePaid);
      state.attempt = null;
      if (pagePaid.page_loads > 0 || pagePaid.search_pages > 0) {
        state.wasted.push({ page, spent: pagePaid, at: new Date().toISOString(), reason: "budget-stop" });
      }
      // Nothing proved yet means there is no partial result worth an exit code
      // of its own — the refusal that named the cap is the whole story.
      if (state.pages.length === 0) {
        state.stop = "budget-exhausted";
        writePagedState(o.run, state);
        throw e;
      }
      stop = "budget-exhausted";
      stopDetail = { code: e.code, message: e.message, ...(e.evidence === undefined ? {} : { evidence: e.evidence }) };
      break;
    }
    const pagePaid = attempt.spent;
    spent = addCost(spent, pagePaid);

    // ---- 2. load ----------------------------------------------------------
    o.run.log("nav.start", { phase, ...(dwelt > 0 ? { detail: { dwell_ms: dwelt } } : {}) });
    const startedAt = Date.now();
    const load = await o.source.loadPage({ page, pagesDone: state.pages.length, cursor, respent });
    o.run.log("nav.done", {
      phase,
      duration_ms: Date.now() - startedAt,
      detail: { items: load.items ?? 0, has_more: load.hasMore },
    });

    // ---- 3. archive -------------------------------------------------------
    const ids = await archivePage({ page, load, attempt, state, run: o.run, archive: o.archive, warnings });

    // ---- 4. checkpoint ----------------------------------------------------
    const completed: CompletedPage = {
      page,
      archive_ids: ids,
      items: load.items ?? 0,
      has_more: load.hasMore,
      spent: pagePaid,
      ...(load.fingerprint === undefined ? {} : { fingerprint: load.fingerprint }),
      ...(load.cursor === undefined ? {} : { cursor: load.cursor }),
      completed_at: new Date().toISOString(),
      ...(respent ? { respent: true as const } : {}),
    };
    state.pages.push(completed);
    state.attempt = null;
    writePagedState(o.run, state);
    loaded.push({ page, load });
  }

  const finalStop: StopReason = stop ?? "page-limit";
  state.stop = finalStop;
  writePagedState(o.run, state);

  const wastedTotal = totalCost(state.wasted);
  if (state.orphans.length > 0 && !warnings.some((w) => w.code === "RESUMED_ORPHAN_CAPTURES")) {
    warnings.push({ code: "RESUMED_ORPHAN_CAPTURES", n: state.orphans.length });
  }

  return {
    stop: finalStop,
    ...(stopDetail === undefined ? {} : { stopDetail }),
    complete: isComplete(finalStop),
    warnings,
    pages: state.pages,
    loaded,
    items: itemsSoFar(),
    spent,
    wasted: wastedTotal,
    unconfirmed: totalUnconfirmed(state.wasted),
    orphans: state.orphans,
    respentPages,
    dwellMs,
    resumeToken: o.run.runId,
  };
}

/**
 * Step 3. Two shapes reach the same place — a list of archive ids proving this
 * page's bytes are on disk.
 *
 * The `expected` count is checkpointed *before* the first body is written when
 * the loop owns the writing, which is what makes a torn archive detectable on
 * resume: a count that matches means every body landed, and anything less is
 * refused rather than adopted. A source that archives through the network tap
 * cannot offer that window — its bytes are already down when it reports them —
 * and gets the same record written after the fact.
 */
async function archivePage(o: {
  page: number;
  load: PageLoad;
  attempt: PageAttempt;
  state: PagedCheckpointState;
  run: PagedRunOptions["run"];
  archive: PagedArchive;
  warnings: Warning[];
}): Promise<string[]> {
  const { load, attempt, state } = o;

  const record = (expected: number) => {
    attempt.expected = expected;
    attempt.items = load.items ?? 0;
    attempt.hasMore = load.hasMore;
    if (load.fingerprint !== undefined) attempt.fingerprint = load.fingerprint;
    if (load.cursor !== undefined) attempt.cursor = load.cursor;
    state.attempt = attempt;
    writePagedState(o.run, state);
  };

  if (load.captures && load.captures.length > 0) {
    record(load.captures.length);
    const ids: string[] = [];
    for (const capture of load.captures) {
      const archived = await o.archive.archive(capture);
      ids.push(archived.file);
      if (archived.warning) o.warnings.push({ code: archived.warning.code, n: 1, field: archived.file });
    }
    return ids;
  }

  if (load.archived && load.archived.length > 0) {
    const ids = load.archived.map((entry) => entry.file);
    record(ids.length);
    return ids;
  }

  throw noBytes(o.page);
}
