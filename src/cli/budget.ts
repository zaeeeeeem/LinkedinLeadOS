import { CapabilityError, EXIT } from "../core/run/receipt.js";
import type { BudgetLedger, SpendRecord, UsageSnapshot } from "../core/budget/ledger.js";
import type { SpendKind } from "../core/budget/constants.js";
import type { EventFields, EventName } from "../core/run/events.js";
import type { CostEstimate } from "./types.js";

export type SpendArgs = { kind: SpendKind; n?: number; ref?: string };

type EventSink = { log(event: EventName, fields?: EventFields): unknown };

/**
 * The ledger as a capability sees it: bound to one run, tallying what it spends.
 *
 * Two things this adds over calling `BudgetLedger` directly.
 *
 * `runId` and `capability` are bound once here rather than passed at every
 * spend, so a capability cannot record a spend under the wrong run — which would
 * be invisible until someone tried to explain a run from the ledger.
 *
 * The tally is what the receipt's `cost` is built from. Spec §4.1 reports cost as
 * a fact about the invocation, and the estimate is a guess made before it ran; a
 * receipt that echoed the estimate would report the same numbers whether the work
 * happened or not.
 */
export class RunBudget {
  #pageLoads = 0;
  #searchPages = 0;
  readonly #profiles = new Set<string>();

  constructor(
    private readonly ledger: BudgetLedger,
    private readonly runId: string,
    private readonly capability: string,
    /** `--budget=<n>`: a cap on page loads for this invocation alone. */
    private readonly invocationCap: number | null = null,
    private readonly events?: EventSink,
  ) {}

  get path(): string {
    return this.ledger.path;
  }

  /** What this invocation has actually spent so far. */
  get spent(): CostEstimate {
    return {
      page_loads: this.#pageLoads,
      search_pages: this.#searchPages,
      profile_opens: this.#profiles.size,
    };
  }

  /**
   * Read-only preflight peek. Applies the invocation cap first: a `--budget=2`
   * run must be refused by its own cap before the ledger is consulted, otherwise
   * the receipt would name a daily limit the operator never hit.
   */
  async check(o: SpendArgs): Promise<void> {
    this.assertUnderInvocationCap(o);
    // The capability is bound here, not passed by the caller, for the same
    // reason `spend` binds it: a capability cannot preflight against another
    // capability's daily sub-cap (D153) even by mistake.
    await this.ledger.check({ ...o, capability: this.capability });
  }

  async spend(o: SpendArgs): Promise<SpendRecord> {
    this.assertUnderInvocationCap(o);
    const record = await this.ledger.spend({ ...o, runId: this.runId, capability: this.capability });
    // Tallied only after the ledger committed: a refused spend that still moved
    // this counter would make the receipt's cost describe work that never happened,
    // and would consume the invocation cap on a spend nobody made.
    if (o.kind === "page_load") this.#pageLoads += o.n ?? 1;
    if (o.kind === "search_page") this.#searchPages += o.n ?? 1;
    if (o.kind === "profile_open" && o.ref !== undefined) this.#profiles.add(o.ref);
    this.events?.log("budget.spend", {
      detail: { kind: o.kind, n: o.n ?? 1, invocation_total: this.spent },
    });
    return record;
  }

  usage(now?: Date): Promise<UsageSnapshot> {
    return this.ledger.usage(now);
  }

  private assertUnderInvocationCap(o: SpendArgs): void {
    if (this.invocationCap === null || o.kind !== "page_load") return;
    const after = this.#pageLoads + (o.n ?? 1);
    if (after <= this.invocationCap) return;
    // Its own code, not BUDGET_EXCEEDED: this is the operator's `--budget` flag
    // biting, and the fix is to raise their own number, not to wait out a
    // LinkedIn-facing daily limit. One code per distinct operator action.
    throw new CapabilityError({
      code: "BUDGET_INVOCATION_CAP",
      exit: EXIT.BUDGET,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message:
        `--budget=${this.invocationCap} caps this invocation at ${this.invocationCap} page loads; ` +
        `${this.#pageLoads} already spent, this would make ${after}`,
      evidence: JSON.stringify({ cap: this.invocationCap, spent: this.#pageLoads, requested: o.n ?? 1 }),
    });
  }
}
