import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import {
  CHALLENGE_PRECEDENCE, classifyResponse, type ChallengeDetection,
} from "../../core/challenge/classify.js";
import { anyStop, installSignalPause, pauseFileStop } from "../../core/paged/index.js";
import type { Warning } from "../../core/run/receipt.js";
import { documentPattern } from "../profile.capture/patterns.js";
import {
  DEFAULT_ACCOUNTS_SEARCH_URL, DEFAULT_LEADS_SEARCH_URL,
} from "../salesnav.probe/url.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import {
  HARVEST_DEFAULT_MAX_MINUTES,
  HARVEST_DEFAULT_SEARCH_PAGE_BUDGET,
  HARVEST_DOCUMENT_PATTERN,
  HARVEST_ENDPOINT_RECEIPT_CAP,
  HARVEST_FINAL_SETTLE_MS,
  HARVEST_MAX_MINUTES,
  HARVEST_MAX_CAPTURE_RECORDS,
  HARVEST_MAX_SEARCH_PAGES_PER_INVOCATION,
} from "./constants.js";
import {
  reconcileObservedSearches, observeHarvest, type HarvestObservation,
} from "./observe.js";

const args = z.object({
  vertical: z.enum(["LEAD", "ACCOUNT"]).default("LEAD"),
  /** The operator's own words, persisted in run.json before contact. */
  operatorPlan: z.string().min(1).max(4_000),
  searchPageBudget: z.coerce.number().int().min(1)
    .max(HARVEST_MAX_SEARCH_PAGES_PER_INVOCATION)
    .default(HARVEST_DEFAULT_SEARCH_PAGE_BUDGET),
  maxMinutes: z.coerce.number().int().min(1).max(HARVEST_MAX_MINUTES)
    .default(HARVEST_DEFAULT_MAX_MINUTES),
}).strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;

export type HarvestDeps = {
  gate: typeof assertNoChallenge;
  observe(options: Parameters<typeof observeHarvest>[0]): Promise<HarvestObservation>;
  announce(message: string): void;
  settle(ms: number): Promise<void>;
};

const defaults: HarvestDeps = {
  gate: assertNoChallenge,
  observe: observeHarvest,
  // Stdout belongs to the final receipt (D3). This is operator coordination,
  // so it goes to stderr and carries no captured data.
  announce: (message) => process.stderr.write(`${message}\n`),
  settle: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

function worst(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((left, right) =>
    CHALLENGE_PRECEDENCE.indexOf(left.kind) <= CHALLENGE_PRECEDENCE.indexOf(right.kind)
      ? left
      : right);
}

function endpointCounts(urls: readonly string[]): Array<{ endpoint: string; n: number }> {
  const counts = new Map<string, number>();
  for (const raw of urls) {
    let path: string;
    try { path = new URL(raw).pathname; } catch { continue; }
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([endpoint, n]) => ({ endpoint, n }))
    .sort((a, b) => b.n - a.n || a.endpoint.localeCompare(b.endpoint))
    .slice(0, HARVEST_ENDPOINT_RECEIPT_CAP);
}

export async function runHarvestSession(ctx: Context, deps: HarvestDeps = defaults) {
  const { run, args: input, browser, budget } = ctx;
  const { tab, tap } = browser;
  const target = input.vertical === "LEAD" ? DEFAULT_LEADS_SEARCH_URL : DEFAULT_ACCOUNTS_SEARCH_URL;
  const warnings: Warning[] = [];
  const releases = [
    ...SALESNAV_PATTERNS.map((pattern) => tap.watch(pattern)),
    tap.watch(documentPattern(target, HARVEST_DOCUMENT_PATTERN)),
  ];
  const signals = installSignalPause({
    onSignal: (signal, first) => run.log("checkpoint.save", {
      detail: { source: "signal", signal, action: first ? "finish-harvest" : "terminate-now" },
    }),
  });
  let observation: HarvestObservation | null = null;
  let foreground: Awaited<ReturnType<typeof tab.ensureForeground>> | null = null;
  let checkedCaptureCount = 0;
  let unrecognizedResponses = 0;

  try {
    await budget.check({ kind: "page_load", n: 1 });
    await budget.check({ kind: "search_page", n: input.searchPageBudget });
    foreground = await tab.ensureForeground();
    if (!foreground.ok) warnings.push({
      code: "TAB_NOT_FOREGROUND", n: 1,
      field: "the automation-profile worker tab did not become foreground; do not begin manual filter work",
    });

    // The full human-driven allowance is charged before navigation. A crash
    // can therefore waste budget but can never erase searches the operator
    // already caused before the passive tap reconciled them (D440).
    await budget.spend({ kind: "page_load", n: 1 });
    await budget.spend({ kind: "search_page", n: input.searchPageBudget });
    run.log("nav.start", { phase: "filters.harvest", item_ref: `salesnav:${input.vertical.toLowerCase()}` });
    const started = Date.now();
    await tab.navigate(target);
    run.log("nav.done", {
      phase: "filters.harvest",
      item_ref: `salesnav:${input.vertical.toLowerCase()}`,
      duration_ms: Date.now() - started,
      detail: {
        interaction_boundary: "capability navigation complete; operator drives from here",
        capability_input_events_after_navigation: 0,
      },
    });
    await deps.gate({ tab, run, state: { phase: "harvest-post-navigation", vertical: input.vertical } });

    const pausePath = `${run.dir}/PAUSE`;
    deps.announce(
      `observing ${input.vertical.toLowerCase()} filters — use the automation-profile worker tab; ` +
      `the capability will send zero clicks, keystrokes, or wheel events. ` +
      `Finish with Ctrl-C once or create ${pausePath}`,
    );
    run.log("render.wait", {
      phase: "filters.harvest",
      detail: {
        observing: true,
        operator_plan_recorded_in_run_args: true,
        search_page_budget: input.searchPageBudget,
        capability_input_events_after_navigation: 0,
      },
    });

    const inspectResponses = async () => {
      const all = tap.captures();
      if (all.length + tap.misses().length > HARVEST_MAX_CAPTURE_RECORDS) return;
      const fresh = all.slice(checkedCaptureCount);
      checkedCaptureCount = all.length;
      const detections = fresh
        .map((capture) => classifyResponse({ status: capture.status, url: capture.url }))
        .filter((detection): detection is ChallengeDetection => !detection.clean);
      const halting = detections.filter((detection) => detection.kind !== "unrecognized");
      if (halting.length > 0) {
        throw await recordChallenge({
          detection: worst(halting), tab, run,
          state: { phase: "harvest-observing", vertical: input.vertical },
        });
      }
      unrecognizedResponses += detections.length - halting.length;
    };

    const stop = anyStop(signals.stop, pauseFileStop(run.dir));
    observation = await deps.observe({
      tap,
      searchPageBudget: input.searchPageBudget,
      prechargedSearchPages: input.searchPageBudget,
      maxMs: input.maxMinutes * 60_000,
      stopRequested: async () => (await stop()) !== null,
      inspect: inspectResponses,
    });
    // The operator has stopped sending input. Give the UI's last request a
    // bounded quiet window to finish, then reconcile again so a response that
    // crossed the stop boundary is still charged and archived in this run.
    await deps.settle(HARVEST_FINAL_SETTLE_MS);
    await tap.drain();
    const finalAccounting = reconcileObservedSearches({
      tap,
      searchPageBudget: input.searchPageBudget,
      alreadyCharged: observation.searchPagesCharged,
    });
    observation = {
      ...observation,
      search: finalAccounting.search,
      searchPagesCharged: finalAccounting.charged,
      ...(finalAccounting.search.requestIds.length >= input.searchPageBudget
        ? { stop: "search-budget" as const }
        : {}),
    };
    await deps.gate({ tab, run, state: { phase: "harvest-pre-success", vertical: input.vertical } });
  } finally {
    signals.dispose();
    await tap.drain();
    for (const release of releases) release();
  }

  const captures = tap.captures();
  const misses = tap.misses();
  const observed = observation!;
  run.log("parse.ok", {
    phase: "filters.harvest",
    detail: {
      measurement: "archive-ready-for-offline-harvest",
      stop: observed.stop,
      captured_bodies: captures.length,
      capture_misses: misses.length,
      operator_search_requests: observed.search.requestIds.length,
      search_pages_charged: observed.searchPagesCharged,
      capability_input_events_after_navigation: 0,
    },
  });
  if (observed.stop === "time-limit") warnings.push({
    code: "HARVEST_TIME_LIMIT", n: 1,
    field: `observation stopped at the configured ${input.maxMinutes}-minute limit`,
  });
  if (unrecognizedResponses > 0) warnings.push({
    code: "RESPONSE_STATUS_UNRECOGNIZED",
    n: unrecognizedResponses,
    field: "one or more observed harvest responses returned an unrecognized status",
  });
  if (observed.stop === "search-budget") warnings.push({
    code: "HARVEST_SEARCH_BUDGET_REACHED", n: 1,
    field: `observation stopped after ${input.searchPageBudget} UI-issued search requests`,
  });
  if (misses.length > 0) warnings.push({
    code: "CAPTURE_MISSES", n: misses.length,
    field: "watched responses were seen but not delivered; request ids still count toward search spend",
  });

  return {
    counts: {
      requested: input.searchPageBudget,
      captured: captures.length,
      usable: 0,
      skipped: misses.length,
    },
    warnings,
    data: {
      vertical: input.vertical,
      stop: observed.stop,
      capability: {
        navigations: 1,
        clicks: 0,
        keystrokes: 0,
        wheel_events: 0,
        input_events_after_navigation: 0,
      },
      operator: {
        plan_recorded_in_run_args: true,
        interactions_reconstructed: false,
      },
      search_accounting: {
        observed_requests: observed.search.requestIds.length,
        lead: observed.search.lead,
        account: observed.search.account,
        charged_pages: observed.searchPagesCharged,
        precharged_session_allowance: input.searchPageBudget,
      },
      capture: {
        bodies: captures.length,
        misses: misses.length,
        endpoints: endpointCounts([
          ...captures.map((capture) => capture.url),
          ...misses.map((miss) => miss.url),
        ]),
      },
      foreground: { ok: foreground?.ok ?? false, via: foreground?.via ?? null },
      artifacts: run.artifacts(),
    },
    next: `Run salesnav.filters.vocab --operation=harvest --run-ids=${run.runId} offline after FILTER-MAP classifies the measured endpoint shapes.`,
  };
}

export function createHarvestCapability(deps: HarvestDeps = defaults) {
  return defineCapability({
    name: "salesnav.filters.harvest",
    risk: "read-metered",
    summary: "Open one Sales Navigator search page, then passively archive operator-driven filter vocabulary traffic.",
    args,
    needsBrowser: true,
    // Registry manifests call cost with an unparsed empty object. Preserve the
    // schema default there instead of serializing NaN as a misleading null.
    cost: (input) => ({
      page_loads: 1,
      search_pages: input.searchPageBudget ?? HARVEST_DEFAULT_SEARCH_PAGE_BUDGET,
      profile_opens: 0,
    }),
    run: (ctx) => runHarvestSession(ctx, deps),
  });
}

export const capability = createHarvestCapability();
export default capability;
