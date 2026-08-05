import type { z } from "zod";
import type { RunContext } from "../core/run/context.js";
import type { Counts, Stored, Warning } from "../core/run/receipt.js";
import type { ChromeEndpoint } from "../core/chrome/launcher.js";
import type { ForegroundResult, ForegroundState } from "../core/session/tab.js";
import type { NetworkTap, TapTransport } from "../core/tap/network-tap.js";
import type { HumanCursor } from "../core/input/cursor.js";
import type { RawArchive } from "../core/archive/raw.js";
import type { LeaseRecord } from "../core/lease/tab-lease.js";
import type { RunBudget } from "./budget.js";

/**
 * How much LinkedIn a capability is allowed to touch.
 *
 * `local` is an addition to the spec §3 pair. `health.check` issues no LinkedIn
 * request at all, and calling it `read-cheap` would put it in the same bucket the
 * manifest uses to tell an agent "this one spends account safety". A class that
 * lies about the safest capability in the toolkit is worse than a third name.
 */
export type RiskClass = "local" | "read-cheap" | "read-metered";

/**
 * What one invocation expects to spend, in the exact three kinds the budget
 * ledger tracks (§8). Not the receipt's `cost` — that one is measured after the
 * fact from what was actually spent.
 */
export type CostEstimate = {
  page_loads: number;
  search_pages: number;
  profile_opens: number;
};

export const ZERO_COST: CostEstimate = { page_loads: 0, search_pages: 0, profile_opens: 0 };

/** What preflight learned about the session, without issuing a LinkedIn request. */
export type LoginState = {
  logged_in: boolean;
  /** Never the cookie's value — only whether it is there and still valid. */
  cookie: "present" | "missing" | "expired" | "unknown";
  expires_at?: string;
};

/**
 * The worker tab, structurally. Task 4's `WorkerTab` satisfies it — pinned by a
 * compile-time assertion in `tests/cli-run.test.ts`, which is also what lets the
 * runner be exercised offline against a fake tab instead of a live browser.
 */
export type TabLike = {
  readonly targetId: string;
  readonly sessionId: string;
  send<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
  navigate(url: string, timeoutMs?: number): Promise<void>;
  currentUrl(): Promise<string>;
  screenshot(path: string): Promise<string>;
  foregroundState(): Promise<ForegroundState | null>;
  ensureForeground(): Promise<ForegroundResult>;
  close(): Promise<void>;
};

/** The browser session, structurally. Task 4's `BrowserSession` satisfies it. */
export type SessionLike = {
  readonly endpoint: ChromeEndpoint;
  readonly client: TapTransport;
  openWorkerTab(url?: string): Promise<TabLike>;
  close(): Promise<void>;
};

/** Everything that only exists when a capability asked for the browser. */
export type BrowserBundle = {
  session: SessionLike;
  tab: TabLike;
  tap: NetworkTap;
  cursor: HumanCursor;
  archive: RawArchive;
  /** The tab lease this invocation holds. Released on every exit path. */
  lease: LeaseRecord;
};

/** The universal flags of §4.4, plus the lease escape hatch D16 requires. */
export type UniversalFlags = {
  runId: string | null;
  dryRun: boolean;
  /** Field projection for the receipt's `data`. `null` means "no projection". */
  fields: string[] | null;
  noStore: boolean;
  /** Per-invocation page-load cap. Only ever lowers a limit (§8). */
  budget: number | null;
  /** Drop a wedged tab lease after naming its holder on the receipt (D16). */
  forceRelease: boolean;
};

export type CapabilityContext<A, B extends boolean> = {
  run: RunContext;
  args: A;
  flags: UniversalFlags;
  /** Pre-bound to this run and capability, and tallying what it spends so the
   *  receipt's cost is measured rather than re-estimated. */
  budget: RunBudget;
  /** The estimate preflight cleared against the ledger. */
  estimate: CostEstimate;
  login: LoginState;
  browser: B extends true ? BrowserBundle : null;
};

/**
 * What a capability hands back. Deliberately not a `Receipt`: `run_id`,
 * `artifacts`, `cost` and the exit class are the runner's to fill, and a
 * capability that assembled its own receipt would have to re-derive all four —
 * which is how two capabilities end up reporting artifacts differently.
 */
export type CapabilityResult = {
  counts?: Partial<Counts>;
  data?: unknown;
  warnings?: Warning[];
  stored?: Stored;
  next?: string;
};

export type CapabilityDef<S extends z.ZodType = z.ZodType, B extends boolean = boolean> = {
  /** Also the directory name under `src/capabilities/`, and the CLI subcommand. */
  name: string;
  risk: RiskClass;
  /** One line, shown in the manifest. This is what a context-less agent reads. */
  summary: string;
  args: S;
  needsBrowser: B;
  /**
   * Whether a dead LinkedIn session should stop this capability (exit 4).
   * Defaults to `needsBrowser`. `health.check` sets it false: it touches no
   * LinkedIn page, so a logged-out profile is a fact it should *report*, not a
   * reason to refuse to run the diagnostic that reports it.
   */
  needsAuth?: boolean;
  cost: (args: z.infer<S>) => CostEstimate;
  run: (ctx: CapabilityContext<z.infer<S>, B>) => Promise<CapabilityResult>;
};

/**
 * The registry's erased view of a capability. Method parameters are contravariant
 * under `strictFunctionTypes`, so a `CapabilityDef<SpecificSchema>` is *not*
 * assignable to `CapabilityDef<z.ZodType>` — the erasure has to be explicit, and
 * `any` in these two positions is what makes a heterogeneous registry typeable at
 * all. Every call site is inside the runner, which validates `args` against the
 * schema before `run` ever sees them, so the erasure is checked at runtime where
 * it stops being checkable at compile time.
 */
export type AnyCapability = Omit<CapabilityDef<z.ZodType, boolean>, "cost" | "run"> & {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cost: (args: any) => CostEstimate;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (ctx: any) => Promise<CapabilityResult>;
};

/** Identity function; it exists purely so `S` and `B` are inferred at the
 *  definition site and `ctx.args` / `ctx.browser` are typed inside `run`. */
export function defineCapability<S extends z.ZodType, B extends boolean>(
  def: CapabilityDef<S, B>,
): CapabilityDef<S, B> {
  return def;
}
