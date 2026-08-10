import type { ArchivedCapture, CaptureInput } from "../archive/raw.js";
import type { SpendKind } from "../budget/constants.js";
import type { Warning } from "../run/receipt.js";
import type { PageCost } from "./constants.js";

/** What the loop hands a source when it asks for one page. */
export type PageRequest = {
  /** 1-based, the number a human would read off the pager. */
  page: number;
  /** How many pages this run has already completed, across every session. */
  pagesDone: number;
  /** Whatever the previous page's load returned. `undefined` on the first page
   *  of a run; restored from the checkpoint on a resume. */
  cursor: unknown;
  /** True when a previous session already paid for and attempted this page and
   *  left nothing provable behind. The source may use it to re-navigate from
   *  scratch rather than assume the tab is where it left it. */
  respent: boolean;
};

/**
 * What a source returns for one page.
 *
 * Bytes reach disk one of two ways and the loop supports both, because its two
 * kinds of consumer differ: an offline test (and any source that buffers) hands
 * back `captures` and the loop archives them itself, while a live capability
 * reads through the network tap, which archives every captured body as it
 * arrives and can only report what it already wrote. `archived` is that report.
 *
 * A load that yields neither is a page with no bytes, and the loop refuses to
 * checkpoint it — that is the "receipt claiming a page with no bytes" the
 * contract forbids.
 */
export type PageLoad = {
  /** Bodies the loop must archive (step 3). */
  captures?: readonly CaptureInput[];
  /** Bodies something else already archived into this run's `raw/`. */
  archived?: readonly ArchivedCapture[];
  /** How many result rows this page carried. Counted toward `limit`. */
  items?: number;
  /** Whether the surface says another page exists. `false` ends the run
   *  cleanly as `end-of-results`. */
  hasMore: boolean;
  /** Passed to the next `loadPage`, and checkpointed. Must be JSON-serialisable
   *  and must never contain captured LinkedIn data — a checkpoint is an archive
   *  file, not a data store. */
  cursor?: unknown;
  /**
   * A cheap identity for this page's content — a cursor token, the first row's
   * urn, a hash. Two consecutive pages with the same fingerprint stop the run
   * as `no-advance` instead of paging forever over the same rows. The reference
   * worker trusted the pager's own page number for this and could accept a
   * re-render as an advance; a fingerprint is evidence, a page number is a
   * claim.
   */
  fingerprint?: string;
  /** Anything the capability wants back in memory — rows, warnings, parse
   *  output. Never checkpointed and never touched by the loop. */
  data?: unknown;
};

export type PagedSource = {
  loadPage(req: PageRequest): Promise<PageLoad>;
};

/** Why a paged run stopped. Closed set: every one is a distinct operator
 *  action, and "it just ended" is not one of them. */
export const STOP_REASONS = [
  "end-of-results",
  "page-limit",
  "limit-reached",
  "budget-exhausted",
  "paused",
  "no-advance",
  "empty-page",
] as const;

export type StopReason = (typeof STOP_REASONS)[number];

/** The only stop that means the surface itself was exhausted. Everything else
 *  leaves a resumable run and a partial result that must be flagged as partial. */
export function isComplete(stop: StopReason): boolean {
  return stop === "end-of-results";
}

/** One page this run has proved: paid for, loaded, and archived. */
export type CompletedPage = {
  page: number;
  /** Archive filenames (`ArchivedCapture.file`). What resume corroborates
   *  against the directory listing, rather than believing this record. */
  archive_ids: string[];
  items: number;
  /** What this page said about a next page. Persisted because a resume that
   *  did not know it would pay for a page the surface already said was not
   *  there — the checkpoint has to carry the reason a run ended, not only how
   *  far it got. */
  has_more: boolean;
  spent: PageCost;
  fingerprint?: string;
  cursor?: unknown;
  completed_at: string;
  /** This page was loaded a second time because an earlier session's spend
   *  bought nothing provable. Surfaces as `RESUMED_PAGE_RESPENT`. */
  respent?: true;
};

/**
 * A page that has been paid for and is not yet proved. Written immediately
 * after the ledger commits and cleared only when the page completes, so the
 * checkpoint always names the page a crash was in the middle of.
 *
 * `archive_seq_before` is the archive's next sequence number at the moment the
 * spend landed. Everything at or above it belongs to this attempt, which is
 * what lets a resume tell this attempt's bytes from every earlier page's.
 *
 * `expected` is how many bodies the load said it would archive, written before
 * the first of them reaches disk. A resume that finds exactly that many
 * adopts them; fewer means a torn archive and the page is re-loaded.
 */
export type PageAttempt = {
  page: number;
  /** What the loop is about to commit, written *before* the first ledger line.
   *  A crash inside the spend phase leaves the plan on disk even though the
   *  loop never learned which of its lines landed. */
  spend_plan: PageCost;
  /** The lines the loop saw commit. Between one line committing and this being
   *  updated there is a one-write window in which a crash leaves a real ledger
   *  line attributable to nothing — the irreducible gap, reported as
   *  `unconfirmed` rather than papered over (D347). */
  spent: PageCost;
  spend_confirmed: boolean;
  spent_at: string;
  archive_seq_before: number;
  expected: number | null;
  items: number | null;
  hasMore: boolean | null;
  fingerprint?: string;
  cursor?: unknown;
  request_cursor?: unknown;
};

/** A spend that bought no page. Kept because the ledger over-counting is the
 *  safe direction and hiding it would make the ledger look wrong instead. */
export type WastedSpend = {
  page: number;
  /** Ledger lines this run knows it committed and got nothing for. */
  spent: PageCost;
  /** Ledger lines that may or may not exist: the spend phase was interrupted
   *  and the loop never confirmed them. The ledger holds somewhere between
   *  `spent` and `spent + unconfirmed` for this page. */
  unconfirmed?: PageCost;
  at: string;
  reason: "crash-before-load" | "crash-in-spend" | "torn-archive" | "budget-stop";
};

export type PagedCheckpointState = {
  kind: "paged-run/v1";
  capability: string;
  /** Identifies *what* is being paged. A resume whose plan differs is refused
   *  rather than merged — two searches under one run id would put one search's
   *  rows behind the other's checkpoint. */
  plan: string;
  cost: PageCost;
  pages: CompletedPage[];
  attempt: PageAttempt | null;
  /** Archive ids left by an attempt that could not be proved. On disk forever
   *  (raw-first), claimed by no page, reported rather than deleted. */
  orphans: string[];
  wasted: WastedSpend[];
  stop: StopReason | null;
  updated_at: string;
};

/** The ledger, as the loop needs it. `RunBudget` satisfies it structurally, so
 *  the loop never reaches for the ledger path or the capability name itself. */
export type PagedBudget = {
  check(o: { kind: SpendKind; n?: number; ref?: string }): Promise<void>;
  spend(o: { kind: SpendKind; n?: number; ref?: string }): Promise<unknown>;
};

/** The raw archive, as the loop needs it. `RawArchive` satisfies it. */
export type PagedArchive = {
  archive(input: CaptureInput): Promise<ArchivedCapture>;
  list(): Promise<ArchivedCapture[]>;
};

export type PagedRunOutcome = {
  stop: StopReason;
  /** What refused, when the stop was a refusal. Carries the named cap of a
   *  budget stop through to the receipt without the loop building the receipt. */
  stopDetail?: { code: string; message: string; evidence?: string };
  /** Everything the caller must put on the receipt: resume re-spends, adopted
   *  pages, orphaned captures, degraded archive writes. */
  warnings: Warning[];
  /** Only `end-of-results` is complete. Everything else is partial and says so. */
  complete: boolean;
  /** Every proved page of this run, including ones earlier sessions loaded. */
  pages: CompletedPage[];
  /** Only the pages *this* session loaded, with the source's own `data`. Prior
   *  sessions' rows are not here — their bytes are in `raw/`, and re-reading
   *  them is the capability's decision, not the loop's. */
  loaded: { page: number; load: PageLoad }[];
  items: number;
  /** What this session actually committed to the ledger. */
  spent: PageCost;
  /** Everything this run has ever committed and got nothing provable for,
   *  across every session. Reported, never netted off `spent` — the ledger
   *  over-counting is the safe direction, and hiding it makes the ledger look
   *  wrong instead. */
  wasted: PageCost;
  /** The upper bound on ledger lines this run cannot account for: a spend phase
   *  that was interrupted between committing a line and recording it. The
   *  ledger's count for this run is always in
   *  `[pages + wasted, pages + wasted + unconfirmed]`. */
  unconfirmed: PageCost;
  /** Archive ids from torn attempts: on disk, claimed by no page. */
  orphans: string[];
  respentPages: number[];
  /** Total dwell this session spent between pages, for the pacing record. */
  dwellMs: number;
  /** What to pass to `--run-id` to continue. Always the run id. */
  resumeToken: string;
};
