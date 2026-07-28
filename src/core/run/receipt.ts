export const EXIT = {
  OK: 0, GENERIC: 1, CHALLENGE: 2, RATE_LIMITED: 3,
  AUTH: 4, PARSE_DRIFT: 5, TRANSIENT: 6, BUDGET: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export type FailureAction =
  | "RETRY_BACKOFF" | "RETRY_ONCE" | "RESUME"
  | "SKIP_ITEM" | "HALT_AND_NOTIFY" | "REAUTH";

export type Cost = { search_credits: number; page_loads: number; elapsed_ms: number };
export type Counts = { requested: number; captured: number; usable: number; skipped: number };
export type Warning = { code: string; field?: string; n: number };
export type Artifacts = { events: string; raw: string };
export type Stored = { table: string; run_ref: string; rows: number };

export type OkReceipt = {
  ok: true;
  run_id: string;
  capability: string;
  counts: Counts;
  stored?: Stored;
  warnings: Warning[];
  cost: Cost;
  artifacts: Artifacts;
  next?: string;
  data?: unknown;
};

export type ErrReceipt = {
  ok: false;
  run_id: string;
  capability: string;
  error: {
    code: string;
    /** The process exit code this failure class maps to. Carried on the receipt
     *  so emitReceipt never has to be told the failure class a second time. */
    exit: ExitCode;
    retryable: boolean;
    action: FailureAction;
    message: string;
    evidence?: string;
    retry_after_ms?: number;
  };
  partial?: { stored: number; resume_token?: string };
  cost: Cost;
};

export type Receipt = OkReceipt | ErrReceipt;

export class CapabilityError extends Error {
  readonly code: string;
  readonly exit: ExitCode;
  readonly action: FailureAction;
  readonly retryable: boolean;
  readonly evidence?: string;
  readonly retryAfterMs?: number;

  constructor(o: {
    code: string; exit: ExitCode; action: FailureAction;
    retryable: boolean; message: string; evidence?: string; retryAfterMs?: number;
  }) {
    super(o.message);
    this.name = "CapabilityError";
    this.code = o.code;
    this.exit = o.exit;
    this.action = o.action;
    this.retryable = o.retryable;
    this.evidence = o.evidence;
    this.retryAfterMs = o.retryAfterMs;
  }
}

export function buildOk(o: {
  run_id: string; capability: string; counts: Counts; cost: Cost;
  artifacts: Artifacts; stored?: Stored; warnings?: Warning[];
  next?: string; data?: unknown;
}): OkReceipt {
  return {
    ok: true, run_id: o.run_id, capability: o.capability,
    counts: o.counts, stored: o.stored, warnings: o.warnings ?? [],
    cost: o.cost, artifacts: o.artifacts, next: o.next, data: o.data,
  };
}

export function buildErr(o: {
  run_id: string; capability: string; err: CapabilityError;
  cost: Cost; partial?: { stored: number; resume_token?: string };
}): ErrReceipt {
  return {
    ok: false, run_id: o.run_id, capability: o.capability,
    error: {
      code: o.err.code, exit: o.err.exit,
      retryable: o.err.retryable, action: o.err.action,
      message: o.err.message, evidence: o.err.evidence,
      retry_after_ms: o.err.retryAfterMs,
    },
    partial: o.partial, cost: o.cost,
  };
}

/**
 * Prints the receipt as one JSON line on stdout and exits with the failure class
 * the receipt already carries. The exit code is decided once, at the throw site,
 * by the CapabilityError — never re-derived here and never passed in.
 */
export function emitReceipt(r: Receipt): never {
  process.stdout.write(JSON.stringify(r) + "\n");
  process.exit(r.ok ? EXIT.OK : r.error.exit);
}
