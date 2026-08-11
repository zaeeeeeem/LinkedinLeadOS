import { BudgetLedger } from "../core/budget/ledger.js";
import { RawArchive } from "../core/archive/raw.js";
import { HumanCursor } from "../core/input/cursor.js";
import { acquireLease, forceReleaseLease, inspectLease, releaseLease } from "../core/lease/tab-lease.js";
import { defaultLeasePath } from "../core/lease/constants.js";
import { RunContext } from "../core/run/context.js";
import { StoreWriteError } from "../core/store/persons.js";
import {
  buildErr, buildOk, CapabilityError, EXIT,
} from "../core/run/receipt.js";
import type { Counts, ExitCode, Receipt, Warning } from "../core/run/receipt.js";
import { BrowserSession } from "../core/session/session.js";
import { NetworkTap } from "../core/tap/network-tap.js";
import { RunBudget } from "./budget.js";
import { preflight, teardown, type EventSink, type PreflightDeps, type Prepared } from "./preflight.js";
import { needsAuth as capabilityNeedsAuth } from "./registry.js";
import type {
  AnyCapability, BrowserBundle, CostEstimate, LoginState, TabLike, UniversalFlags,
} from "./types.js";
import { ZERO_COST } from "./types.js";

const ZERO_COUNTS: Counts = { requested: 0, captured: 0, usable: 0, skipped: 0 };

/** The run id a receipt carries when the invocation failed before a run existed. */
export const NO_RUN = "-";

export type ExecuteDeps = PreflightDeps & {
  makeArchive(dir: string): RawArchive;
  makeTap(o: {
    session: BrowserBundle["session"];
    tab: TabLike;
    archive: RawArchive;
    events: EventSink;
  }): NetworkTap;
  makeCursor(tab: TabLike): HumanCursor;
};

export const defaultDeps: ExecuteDeps = {
  openSession: () => BrowserSession.open(),
  acquireLease,
  releaseLease,
  inspectLease,
  forceReleaseLease,
  makeArchive: (dir) => new RawArchive(dir),
  makeTap: (o) =>
    new NetworkTap({
      cdp: o.session.client,
      sessionId: o.tab.sessionId,
      archive: o.archive,
      events: o.events,
    }),
  makeCursor: (tab) => new HumanCursor(tab),
};

export type ExecuteOptions = {
  def: AnyCapability;
  rawArgs: Record<string, unknown>;
  flags: UniversalFlags;
  runsDir?: string;
  leasePath?: string;
  budgetPath?: string;
  deps?: Partial<ExecuteDeps>;
  /**
   * Handed a teardown thunk as soon as there is anything to tear down, and
   * handed a no-op once there is not. It is what lets a crash handler outside
   * this function still release the tab and the lease: `execute` covers every
   * throw on its own await chain, but an exception raised from a CDP listener
   * lands on `uncaughtException`, where nothing otherwise knows what was held.
   */
  onCleanup?: (fn: () => Promise<void>) => void;
};

export type Outcome = { receipt: Receipt; exit: ExitCode };

function usageError(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false, message, evidence,
  });
}

/** Anything a capability threw that was not already classified. Exit 1 is the
 *  spec's "anything else"; re-deciding retryability for an error nobody
 *  classified would be a guess (D13's question, answered "we don't know"). */
function unclassified(err: unknown): CapabilityError {
  if (err instanceof CapabilityError) return err;
  return usageError(
    "CAPABILITY_FAILED",
    `capability threw an unclassified error: ${err instanceof Error ? err.message : String(err)}`,
  );
}

/** `--fields=a,b` projects the receipt's `data` down to the named keys (§4.4). */
export function project(data: unknown, fields: string[] | null): unknown {
  if (fields === null || data === null || data === undefined) return data;
  const pick = (row: unknown): unknown => {
    if (typeof row !== "object" || row === null) return row;
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      if (f in (row as Record<string, unknown>)) out[f] = (row as Record<string, unknown>)[f];
    }
    return out;
  };
  return Array.isArray(data) ? data.map(pick) : pick(data);
}

/**
 * Runs one capability invocation end to end and returns its receipt plus the
 * exit code that receipt names.
 *
 * It deliberately does not print or exit — `main` in `index.ts` owns stdout and
 * the process, which is what makes every failure class here provable offline
 * instead of only by watching a real process die.
 */
export async function execute(o: ExecuteOptions): Promise<Outcome> {
  const deps: ExecuteDeps = { ...defaultDeps, ...o.deps };
  const { def, flags } = o;
  const started = Date.now();

  // Before anything runs: the args schema. A capability must never begin work on
  // arguments it would have rejected — that is the difference between a typo and
  // a page load spent on one.
  //
  // On a resume, the run's own recorded arguments sit underneath the command
  // line (D411). An omitted flag then means "as before" rather than "as the
  // schema defaults", which is the difference between continuing a run and
  // silently truncating one that has already paid for its pages. Anything
  // typed on this invocation still wins.
  const persisted = flags.runId === null
    ? null
    : RunContext.persistedArgs({ runId: flags.runId, ...(o.runsDir === undefined ? {} : { runsDir: o.runsDir }) });
  const parsed = def.args.safeParse({ ...(persisted ?? {}), ...o.rawArgs });
  if (!parsed.success) {
    return failEarly(
      def.name,
      flags.runId ?? NO_RUN,
      usageError(
        "ARGS_INVALID",
        `invalid arguments for ${def.name}: ${parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      ),
      started,
    );
  }
  const args: unknown = parsed.data;

  let run: RunContext;
  try {
    run = RunContext.open({
      capability: def.name,
      args: args as Record<string, unknown>,
      ...(flags.runId === null ? {} : { runId: flags.runId }),
      ...(o.runsDir === undefined ? {} : { runsDir: o.runsDir }),
    });
  } catch (e) {
    return failEarly(def.name, flags.runId ?? NO_RUN, unclassified(e), started);
  }

  let estimate: CostEstimate;
  try {
    estimate = def.cost(args);
  } catch (e) {
    return finishWith(run, buildErr({
      run_id: run.runId, capability: def.name,
      err: usageError("COST_ESTIMATE_FAILED", `cost estimate threw: ${String(e)}`),
      cost: { search_credits: 0, page_loads: 0, elapsed_ms: run.elapsedMs() },
    }));
  }

  // `--budget=<n>` is a cap on *this invocation*, enforced only by RunBudget.
  //
  // It is deliberately not also a ledger limit override. The ledger's windows
  // count every run's page loads, so an override compares the operator's number
  // against other runs' spend: with 40 page loads already in the hour, a run
  // asking for 2 with `--budget=5` was refused with "limit is 5, already at 40",
  // naming a limit nobody hit and stopping a run that was well inside its own
  // cap. The effective ceiling is min(invocation cap, ledger limit) either way —
  // the ledger's own §8 limits stay the account-safety floor and nothing here
  // can raise them, which is all §4.4's "only lowers" asks for.
  let ledger: BudgetLedger;
  try {
    ledger = BudgetLedger.open({
      ...(o.budgetPath === undefined ? {} : { path: o.budgetPath }),
    });
  } catch (e) {
    return finishWith(run, buildErr({
      run_id: run.runId, capability: def.name, err: unclassified(e),
      cost: { search_credits: 0, page_loads: 0, elapsed_ms: run.elapsedMs() },
    }));
  }
  const budget = new RunBudget(ledger, run.runId, def.name, flags.budget, run);
  const leasePath = o.leasePath ?? defaultLeasePath();

  if (flags.dryRun) return dryRun({ ...o, deps, run, budget, estimate, leasePath });

  let prepared: Prepared | null = null;
  const bundleRef: { current: BrowserBundle | null } = { current: null };
  const warnings: Warning[] = [];
  try {
    const workerTargetId = run.workerTargetId();
    prepared = await preflight({
      runId: run.runId,
      capability: def.name,
      needsBrowser: def.needsBrowser,
      needsAuth: capabilityNeedsAuth(def),
      estimate,
      flags,
      budget,
      events: run,
      leasePath,
      ...(workerTargetId === null ? {} : { workerTargetId }),
      deps,
      // Registered from inside preflight, the moment there is anything to
      // release. Registering it here, after preflight returned, left a window
      // between acquiring the lease and opening the worker tab in which a throw
      // from a CDP listener would reach `uncaughtException` with nothing to run.
      onCleanup: (fn) => o.onCleanup?.(async () => {
        if (bundleRef.current) {
          try {
            bundleRef.current.tap.stop();
          } catch { /* teardown reports nothing */ }
        }
        await fn();
      }),
    });
    warnings.push(...prepared.warnings);
    if (prepared.tab) run.rememberWorkerTarget(prepared.tab.targetId);

    const browser = buildBundle(def, prepared, deps, run);
    // Published before the tap is started, so a throw from `start()` still
    // reaches teardown holding the tap it was in the middle of attaching.
    bundleRef.current = browser;
    browser?.tap.start();
    const result = await def.run({
      run, args, flags, budget, estimate, login: prepared.login, browser,
    });

    warnings.push(...(result.warnings ?? []));
    warnings.push(...(await tearDownQuietly(prepared, browser, run.runId, leasePath, deps)));
    run.forgetWorkerTarget();
    prepared = null;
    bundleRef.current = null;
    o.onCleanup?.(async () => {});

    return finishWith(run, buildOk({
      run_id: run.runId,
      capability: def.name,
      counts: { ...ZERO_COUNTS, ...result.counts },
      warnings,
      cost: receiptCost(budget.spent, run.elapsedMs()),
      artifacts: run.artifacts(),
      ...(result.stored === undefined ? {} : { stored: result.stored }),
      ...(result.next === undefined ? {} : { next: result.next }),
      ...(result.data === undefined ? {} : { data: project(result.data, flags.fields) }),
    }));
  } catch (e) {
    const err = unclassified(e);
    try {
      run.log("error", { level: "error", detail: { code: err.code, action: err.action, retryable: err.retryable } });
    } catch { /* the receipt is the report of record; a failed log must not replace it */ }
    if (prepared) {
      await tearDownQuietly(prepared, bundleRef.current, run.runId, leasePath, deps);
      run.forgetWorkerTarget();
    }
    o.onCleanup?.(async () => {});
    return finishWith(run, buildErr({
      run_id: run.runId, capability: def.name, err,
      cost: receiptCost(budget.spent, run.elapsedMs()),
      ...(e instanceof StoreWriteError ? { partial: { stored: e.stored } } : {}),
    }));
  }
}

function receiptCost(spent: CostEstimate, elapsedMs: number) {
  // `search_credits` on the receipt (§4.1) is the search-page spend: one metered
  // search page is one credit against the §8 limit, and there is no second meter.
  return { search_credits: spent.search_pages, page_loads: spent.page_loads, elapsed_ms: elapsedMs };
}

function buildBundle(
  def: AnyCapability, prepared: Prepared, deps: ExecuteDeps, run: RunContext,
): BrowserBundle | null {
  if (!def.needsBrowser) return null;
  const session = prepared.session!;
  const tab = prepared.tab!;
  const archive = deps.makeArchive(run.paths.raw);
  // The run context is the tap's event sink, so `capture.hit` / `capture.miss`
  // land in this run's events.ndjson rather than nowhere (§5, D5).
  const tap = deps.makeTap({ session, tab, archive, events: run });
  return { session, tab, tap, cursor: deps.makeCursor(tab), archive, lease: prepared.lease! };
}

/** Stops the tap, closes the browser, releases the lease — on every path, and
 *  reporting rather than throwing when a step fails. */
async function tearDownQuietly(
  prepared: Prepared, browser: BrowserBundle | null,
  runId: string, leasePath: string, deps: ExecuteDeps,
): Promise<Warning[]> {
  const warnings: Warning[] = [];
  if (browser) {
    try {
      browser.tap.stop();
    } catch (cause) {
      warnings.push({ code: "TEARDOWN_TAP_FAILED", n: 1, field: String(cause) });
    }
  }
  warnings.push(...(await teardown(prepared, { runId, leasePath, deps })));
  return warnings;
}

async function dryRun(o: ExecuteOptions & {
  deps: ExecuteDeps; run: RunContext; budget: RunBudget; estimate: CostEstimate; leasePath: string;
}): Promise<Outcome> {
  const warnings: Warning[] = [];
  let budgetOk = true;
  let budgetError: { code: string; message: string } | null = null;

  // Local file reads only. Nothing below opens a session, so a dry run cannot
  // reach LinkedIn even if the capability would have.
  try {
    if (o.estimate.page_loads > 0) await o.budget.check({ kind: "page_load", n: o.estimate.page_loads });
    if (o.estimate.search_pages > 0) await o.budget.check({ kind: "search_page", n: o.estimate.search_pages });
  } catch (e) {
    budgetOk = false;
    const err = unclassified(e);
    budgetError = { code: err.code, message: err.message };
    warnings.push({ code: "BUDGET_WOULD_EXCEED", n: 1, field: err.code });
  }

  const lease = await o.deps.inspectLease(o.leasePath).catch(() => ({ state: "unknown" as const }));
  const login: LoginState = { logged_in: false, cookie: "unknown" };

  return finishWith(o.run, buildOk({
    run_id: o.run.runId,
    capability: o.def.name,
    counts: ZERO_COUNTS,
    warnings,
    cost: receiptCost(ZERO_COST, o.run.elapsedMs()),
    artifacts: o.run.artifacts(),
    data: {
      dry_run: true,
      plan: {
        capability: o.def.name,
        risk: o.def.risk,
        args: o.run.args,
        needs_browser: o.def.needsBrowser,
        needs_auth: capabilityNeedsAuth(o.def),
      },
      estimate: o.estimate,
      budget: { ok: budgetOk, error: budgetError, usage: await o.budget.usage(), ledger: o.budget.path },
      lease,
      login,
      flags: o.flags,
    },
  }));
}

function finishWith(run: RunContext, receipt: Receipt): Outcome {
  try {
    run.finish(receipt);
  } catch { /* the receipt still goes to stdout; a lost summary.json is not worth losing it over */ }
  return { receipt, exit: receipt.ok ? EXIT.OK : receipt.error.exit };
}

function failEarly(capability: string, runId: string, err: CapabilityError, started: number): Outcome {
  const receipt = buildErr({
    run_id: runId, capability, err,
    cost: { search_credits: 0, page_loads: 0, elapsed_ms: Date.now() - started },
  });
  return { receipt, exit: err.exit };
}
