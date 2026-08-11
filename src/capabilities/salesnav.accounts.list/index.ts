import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import {
  MAX_PAGES_PER_RUN,
  RESULTS_PAGE_COST,
  anyStop,
  budgetStopError,
  installSignalPause,
  pauseFileStop,
  readPagedState,
  runPaged,
  type CompletedPage,
  type PagedRunOutcome,
  type PagedSource,
} from "../../core/paged/index.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import {
  ensureRunRecord,
  ensureSearch,
  finishRunRecord,
  getStore,
  insertSearchResults,
  StoreWriteError,
  type RunRecordFinish,
  type SearchResultInput,
  type SearchResultsInsertResult,
  type StoreClient,
} from "../../core/store/index.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { normalizeSalesNavUrl, type SalesNavTarget } from "../salesnav.probe/url.js";
import { MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE, parseSalesNavAccounts, type SalesNavAccountsParseResult } from "./parse.js";
import { createAccountsSource, accountsFingerprint, type AccountsCursor, type AccountsPageData, type AccountsSourceOptions } from "./source.js";

export const DEFAULT_PAGES = 2;
export const DEFAULT_LIMIT = 50;

const args = z.object({
  /** Required on a fresh run. A resume may recover it from the paged checkpoint. */
  url: z.string().min(1).optional(),
  pages: z.coerce.number().int().min(1).max(MAX_PAGES_PER_RUN).default(DEFAULT_PAGES),
  limit: z.coerce.number().int().min(1).max(MAX_PAGES_PER_RUN * MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE).default(DEFAULT_LIMIT),
  scrolls: z.coerce.number().int().min(0).max(12).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();

type AccountsArgs = z.infer<typeof args>;
type AccountsContext = CapabilityContext<AccountsArgs, true>;

export type SalesNavAccountsDeps = {
  store(): StoreClient;
  ensureRun(input: Parameters<typeof ensureRunRecord>[0], client: StoreClient): Promise<void>;
  finishRun(runId: string, finish: RunRecordFinish, client: StoreClient): Promise<void>;
  ensureSearch(input: Parameters<typeof ensureSearch>[0], client: StoreClient): Promise<{ search_id: string; rows: 1; inserted: boolean }>;
  insertResults(rows: readonly SearchResultInput[], client: StoreClient): Promise<SearchResultsInsertResult>;
  paged(options: Parameters<typeof runPaged>[0]): Promise<PagedRunOutcome>;
  source(options: AccountsSourceOptions): PagedSource;
};

/** Task 40 inherits Task 35's exact runner; it does not carry a vertical pager. */
export const accountsPagedRunner: SalesNavAccountsDeps["paged"] = runPaged;

const defaults: SalesNavAccountsDeps = {
  store: getStore,
  ensureRun: (input, client) => ensureRunRecord(input, { client }),
  finishRun: (runId, finish, client) => finishRunRecord(runId, finish, { client }),
  ensureSearch: (input, client) => ensureSearch(input, { client }),
  insertResults: (rows, client) => insertSearchResults(rows, { client }),
  paged: accountsPagedRunner,
  source: createAccountsSource,
};

function refusal(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function targetFor(ctx: AccountsContext): SalesNavTarget {
  let raw = ctx.args.url;
  if (raw === undefined && ctx.run.resumed) raw = readPagedState(ctx.run)?.plan;
  if (raw === undefined) {
    throw refusal("SALESNAV_URL_REQUIRED", "a fresh salesnav.accounts.list run requires --url=<Sales Navigator company search>");
  }
  const target = normalizeSalesNavUrl(raw);
  if (target.vertical !== "company") {
    throw refusal("SALESNAV_VERTICAL_MISMATCH", "salesnav.accounts.list accepts only /sales/search/company targets");
  }
  if (target.page !== null && target.page !== 1) {
    throw refusal(
      "SALESNAV_START_PAGE_REFUSED",
      "a cold page-N URL is not a navigation the measured UI offers; start on page 1 and use the pager",
      `page=${target.page}`,
    );
  }
  return target;
}

function finishShape(ctx: AccountsContext, status: "ok" | "error", exitCode: number): RunRecordFinish {
  return {
    status,
    page_loads: ctx.budget.spent.page_loads,
    search_credits: ctx.budget.spent.search_pages,
    elapsed_ms: ctx.run.elapsedMs(),
    exit_code: exitCode,
  };
}

type ProvedProjection = {
  rows: SearchResultInput[];
  inspected: number;
  refused: number;
  warnings: Warning[];
};

/** Reads store input from the archive claims, never from the checkpoint's counts. */
export async function projectProvedPages(o: {
  pages: readonly CompletedPage[];
  readText(id: string): Promise<string>;
  searchId: string;
  runRef: string;
  sessionUrns: readonly string[];
}): Promise<ProvedProjection> {
  const rows: SearchResultInput[] = [];
  const warnings: Warning[] = [];
  let inspected = 0;
  let refused = 0;
  for (const page of o.pages) {
    const parsed: SalesNavAccountsParseResult[] = [];
    for (const id of page.archive_ids) {
      const body = await o.readText(id);
      const result = parseSalesNavAccounts(body, { refusedUrns: o.sessionUrns });
      if (result.paging?.page === page.page) parsed.push(result);
    }
    if (parsed.length === 0) {
      throw refusal(
        "SALESNAV_PROVED_PAGE_UNREADABLE",
        "a page corroborated by archive filenames no longer yields its expected account-search body",
        `page=${page.page} archive_ids=${page.archive_ids.length}`,
      );
    }
    const fingerprints = new Set(parsed.map((result) => accountsFingerprint(result.rows)));
    if (fingerprints.size !== 1 || (page.fingerprint !== undefined && !fingerprints.has(page.fingerprint))) {
      throw refusal(
        "SALESNAV_PROVED_PAGE_IDENTITY_CHANGED",
        "the archived bodies for a proved page no longer agree with its checkpointed row fingerprint",
        `page=${page.page} bodies=${parsed.length}`,
      );
    }
    const result = parsed.at(-1)!;
    inspected += result.inspected;
    refused += result.refused;
    warnings.push(...result.warnings.map(({ code, field, n }) => ({ code, field, n })));
    rows.push(...result.rows.map((row) => ({
      search_id: o.searchId,
      page: row.page,
      position: row.position,
      company_urn: row.company_urn,
      run_ref: o.runRef,
    })));
  }
  return { rows, inspected, refused, warnings };
}

function clickData(pages: readonly CompletedPage[]) {
  return pages.flatMap((page) => {
    const cursor = page.cursor as Partial<AccountsCursor> | undefined;
    if (cursor?.arrival !== "click") return [];
    return [{ page: page.page, control: cursor.click?.control ?? null, reveal_passes: cursor.click?.reveal_passes ?? null }];
  });
}

function loadedWarnings(outcome: PagedRunOutcome): Warning[] {
  return outcome.loaded.flatMap(({ load }) => {
    const data = load.data as Partial<AccountsPageData> | undefined;
    return Array.isArray(data?.warnings) ? data.warnings : [];
  });
}

function uniqueWarnings(warnings: readonly Warning[]): Warning[] {
  const counts = new Map<string, Warning>();
  for (const warning of warnings) {
    const key = `${warning.code}\0${warning.field ?? ""}`;
    const current = counts.get(key);
    counts.set(key, current === undefined ? { ...warning } : { ...current, n: current.n + warning.n });
  }
  return [...counts.values()];
}

export function createSalesNavAccountsCapability(deps: SalesNavAccountsDeps = defaults) {
  return defineCapability({
    name: "salesnav.accounts.list",
    risk: "read-metered",
    summary: "Read a bounded, paged Sales Navigator account search with archive-proved resume and provenance storage.",
    args,
    needsBrowser: true,
    cost: (input) => {
      // Registry manifests call `cost({})` without running the schema; expose
      // the real default there rather than returning undefined budgets.
      const pages = input.pages ?? DEFAULT_PAGES;
      return { page_loads: pages, search_pages: pages, profile_opens: 0 };
    },
    run: async (ctx) => {
      const target = targetFor(ctx);
      const client = ctx.flags.noStore ? null : deps.store();
      let mirrored = false;
      let storedRows = 0;

      try {
        if (client !== null) {
          await deps.ensureRun({
            run_id: ctx.run.runId,
            capability: "salesnav.accounts.list",
            args: ctx.run.args,
          }, client);
          mirrored = true;
          await deps.ensureSearch({
            search_id: ctx.run.runId,
            kind: "sn_accounts",
            filter_url: target.url,
            filter_json: null,
          }, client);
        }

        const source = deps.source({
          browser: ctx.browser,
          run: ctx.run,
          target,
          ...(ctx.args.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: ctx.args.captureTimeoutMs }),
          ...(ctx.args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: ctx.args.layoutTimeoutMs }),
          ...(ctx.args.scrolls === undefined ? {} : { scrolls: ctx.args.scrolls }),
          sessionUrns: () => sessionUrnsOf(ctx.browser.tap.captures()),
        });
        const signals = installSignalPause({
          onSignal: (signal, first) => ctx.run.log("checkpoint.save", {
            detail: { source: "signal", signal, action: first ? "pause-at-page-boundary" : "terminate-now" },
          }),
        });
        let outcome: PagedRunOutcome;
        try {
          outcome = await deps.paged({
            run: ctx.run,
            budget: ctx.budget,
            archive: ctx.browser.archive,
            source,
            capability: "salesnav.accounts.list",
            plan: target.url,
            maxPages: ctx.args.pages,
            limit: ctx.args.limit,
            cost: RESULTS_PAGE_COST,
            stopRequested: anyStop(signals.stop, pauseFileStop(ctx.run.dir)),
          });
        } finally {
          signals.dispose();
          await ctx.browser.tap.drain();
        }

        const projected = await projectProvedPages({
          pages: outcome.pages,
          readText: (id) => ctx.browser.archive.readText(id),
          searchId: ctx.run.runId,
          runRef: ctx.run.runId,
          sessionUrns: sessionUrnsOf(ctx.browser.tap.captures()),
        });
        let stored: SearchResultsInsertResult | null = null;
        if (client !== null) {
          stored = { rows: 0, skipped: 0 };
          for (const page of outcome.pages) {
            const pageRows = projected.rows.filter((row) => row.page === page.page);
            try {
              const wrote = await deps.insertResults(pageRows, client);
              stored.rows += wrote.rows;
              stored.skipped += wrote.skipped;
              storedRows = stored.rows;
            } catch (cause) {
              if (cause instanceof CapabilityError) throw new StoreWriteError(cause, storedRows);
              throw cause;
            }
          }
          ctx.run.log("store.write", {
            phase: "salesnav.accounts.list",
            detail: { table: "search_results", inserted: stored.rows, skipped: stored.skipped, pages: outcome.pages.length },
          });
        }

        if (outcome.stop === "budget-exhausted") throw budgetStopError(outcome);
        if (client !== null) await deps.finishRun(ctx.run.runId, finishShape(ctx, "ok", EXIT.OK), client);

        const warnings = uniqueWarnings([
          ...outcome.warnings,
          ...loadedWarnings(outcome).filter((warning) => !warning.code.startsWith("PARSE_")),
          ...projected.warnings,
        ]);
        return {
          counts: {
            requested: ctx.args.limit,
            captured: projected.inspected,
            usable: projected.rows.length,
            skipped: projected.refused,
          },
          warnings,
          ...(stored === null ? {} : { stored: { table: "search_results", run_ref: ctx.run.runId, rows: stored.rows } }),
          data: {
            search_id: ctx.run.runId,
            source: "labeled-body",
            complete: outcome.complete,
            partial: !outcome.complete,
            stop: outcome.stop,
            pages: outcome.pages.map((page) => page.page),
            clicks: clickData(outcome.pages),
            inspected: projected.inspected,
            refused: projected.refused,
            resume: {
              token: outcome.resumeToken,
              resumed: ctx.run.resumed,
              respent_pages: outcome.respentPages,
              orphan_captures: outcome.orphans.length,
            },
            storage: stored === null
              ? { skipped: true, reason: "--no-store" }
              : { skipped: false, inserted: stored.rows, adopted: stored.skipped },
          },
          next: stored === null
            ? `read the archived account-search bodies under ${ctx.run.artifacts().raw}`
            : `select search_id, page, position, company_urn, run_ref from search_results where search_id = '${ctx.run.runId}' order by page, position`,
        };
      } catch (cause) {
        if (client !== null && mirrored) {
          const exit = cause instanceof CapabilityError ? cause.exit : EXIT.GENERIC;
          try { await deps.finishRun(ctx.run.runId, finishShape(ctx, "error", exit), client); } catch { /* preserve the already-classified cause */ }
        }
        throw cause;
      }
    },
  });
}

export const capability = createSalesNavAccountsCapability();
export default capability;
