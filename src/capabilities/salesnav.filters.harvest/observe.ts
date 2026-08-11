import type { Capture, CaptureMiss, NetworkTap } from "../../core/tap/network-tap.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { HARVEST_MAX_CAPTURE_RECORDS, HARVEST_POLL_MS } from "./constants.js";

export type HarvestTap = Pick<NetworkTap, "captures" | "misses" | "drain">;
export type SearchObservation = {
  requestIds: string[];
  lead: number;
  account: number;
};

export type HarvestStopReason = "operator-stop" | "time-limit" | "search-budget";

export type HarvestObservation = {
  stop: HarvestStopReason;
  search: SearchObservation;
  searchPagesCharged: number;
  polls: number;
};

const SEARCH_ENDPOINT = /salesApi(Lead|Account)Search/i;

function isSearchUrl(url: string): "lead" | "account" | null {
  const match = SEARCH_ENDPOINT.exec(url);
  if (match?.[1] === undefined) return null;
  return match[1].toLowerCase() === "lead" ? "lead" : "account";
}

/** Counts UI-issued search requests from both delivered bodies and recorded
 * misses. Request ids are the identity: a retry is a second request and costs
 * again, while one request observed on two paths is counted once. */
export function searchObservation(
  captures: readonly Pick<Capture, "requestId" | "url">[],
  misses: readonly Pick<CaptureMiss, "requestId" | "url">[],
): SearchObservation {
  const requests = new Map<string, "lead" | "account">();
  for (const candidate of [...captures, ...misses]) {
    const vertical = isSearchUrl(candidate.url);
    if (vertical !== null && candidate.requestId !== "") requests.set(candidate.requestId, vertical);
  }
  const verticals = [...requests.values()];
  return {
    requestIds: [...requests.keys()].sort(),
    lead: verticals.filter((vertical) => vertical === "lead").length,
    account: verticals.filter((vertical) => vertical === "account").length,
  };
}

function overBudget(observed: number, budget: number): CapabilityError {
  return new CapabilityError({
    code: "HARVEST_SEARCH_BUDGET_EXCEEDED",
    exit: EXIT.BUDGET,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `the operator-driven harvest produced ${observed} search requests against a ` +
      `${budget}-page session budget; stop interacting and inspect the ledger before another session`,
  });
}

function assertCaptureBound(tap: Pick<HarvestTap, "captures" | "misses">): void {
  const records = tap.captures().length + tap.misses().length;
  if (records <= HARVEST_MAX_CAPTURE_RECORDS) return;
  throw new CapabilityError({
    code: "HARVEST_CAPTURE_BOUND_EXCEEDED",
    exit: EXIT.TRANSIENT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `the broad harvest net observed more than ${HARVEST_MAX_CAPTURE_RECORDS} capture records; ` +
      `stop the session and classify the archive before widening any bound`,
  });
}

export function reconcileObservedSearches(o: {
  tap: Pick<HarvestTap, "captures" | "misses">;
  searchPageBudget: number;
  alreadyCharged: number;
}): { search: SearchObservation; charged: number } {
  if (o.alreadyCharged < o.searchPageBudget) {
    throw new CapabilityError({
      code: "HARVEST_SEARCH_ALLOWANCE_NOT_PRECHARGED",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: "the full operator-driven search allowance must be charged before the handoff",
    });
  }
  assertCaptureBound(o.tap);
  const search = searchObservation(o.tap.captures(), o.tap.misses());
  const observed = search.requestIds.length;
  if (observed > o.searchPageBudget) throw overBudget(observed, o.searchPageBudget);
  return { search, charged: o.alreadyCharged };
}

/** Passive wait after the one navigation. No tab, cursor, keyboard, wheel or
 * click object is accepted, so it cannot send an input event by construction. */
export async function observeHarvest(o: {
  tap: HarvestTap;
  searchPageBudget: number;
  /** The initial navigation was pre-charged before it left the machine. */
  prechargedSearchPages: number;
  maxMs: number;
  stopRequested(): boolean | Promise<boolean>;
  inspect?: () => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
}): Promise<HarvestObservation> {
  if (o.prechargedSearchPages < o.searchPageBudget) {
    throw new CapabilityError({
      code: "HARVEST_SEARCH_ALLOWANCE_NOT_PRECHARGED",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: "the full operator-driven search allowance must be charged before the handoff",
    });
  }
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const started = now();
  let charged = o.prechargedSearchPages;
  let polls = 0;

  for (;;) {
    await o.tap.drain();
    await o.inspect?.();
    polls++;
    const accounting = reconcileObservedSearches({
      tap: o.tap,
      searchPageBudget: o.searchPageBudget,
      alreadyCharged: charged,
    });
    const { search } = accounting;
    charged = accounting.charged;
    const observed = search.requestIds.length;

    if (observed >= o.searchPageBudget) {
      return { stop: "search-budget", search, searchPagesCharged: charged, polls };
    }
    if (await o.stopRequested()) {
      return { stop: "operator-stop", search, searchPagesCharged: charged, polls };
    }
    if (now() - started >= o.maxMs) {
      return { stop: "time-limit", search, searchPagesCharged: charged, polls };
    }
    await sleep(o.pollMs ?? HARVEST_POLL_MS);
  }
}
