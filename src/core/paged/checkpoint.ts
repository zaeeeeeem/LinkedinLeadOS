import type { RunContext } from "../run/context.js";
import { CapabilityError, EXIT, type Warning } from "../run/receipt.js";
import { RESULTS_PAGE_COST, ZERO_PAGE_COST, type PageCost } from "./constants.js";
import type {
  CompletedPage, PagedArchive, PagedCheckpointState, WastedSpend,
} from "./types.js";

export const PAGED_STATE_KIND = "paged-run/v1";

/** The key the paged state lives under inside the run's one checkpoint file.
 *  A capability may keep its own state beside it under any other key; both
 *  survive, because every write merges rather than replaces (D346). */
export const PAGED_STATE_KEY = "paged";

export function emptyState(o: { capability: string; plan: string; cost?: PageCost }): PagedCheckpointState {
  return {
    kind: PAGED_STATE_KIND,
    capability: o.capability,
    plan: o.plan,
    cost: o.cost ?? RESULTS_PAGE_COST,
    pages: [],
    attempt: null,
    orphans: [],
    wasted: [],
    stop: null,
    updated_at: new Date().toISOString(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Reads the paged state out of the run's checkpoint, or `null` if this run has
 *  none. A checkpoint written by something else is left strictly alone. */
export function readPagedState(run: Pick<RunContext, "lastCheckpoint">): PagedCheckpointState | null {
  const raw = run.lastCheckpoint<unknown>();
  if (!isRecord(raw)) return null;
  const state = raw[PAGED_STATE_KEY];
  if (!isRecord(state)) return null;
  if (state["kind"] !== PAGED_STATE_KIND) {
    throw new CapabilityError({
      code: "PAGED_CHECKPOINT_UNKNOWN_VERSION",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message:
        `this run's checkpoint holds paged state of kind ${JSON.stringify(state["kind"])}, ` +
        `not ${PAGED_STATE_KIND} — refusing to resume state this build cannot read`,
    });
  }
  return state as unknown as PagedCheckpointState;
}

/**
 * Writes the paged state, preserving every other key already in the checkpoint.
 * Synchronous and immediate: the reference worker's per-page record was
 * fire-and-forget and settled only at run end, so a kill lost the completion
 * record of pages that had already been fully scraped. Here the write is the
 * step, not a side effect of one.
 */
export function writePagedState(
  run: Pick<RunContext, "lastCheckpoint" | "checkpoint">,
  state: PagedCheckpointState,
): void {
  const existing = run.lastCheckpoint<unknown>();
  const base = isRecord(existing) ? existing : {};
  state.updated_at = new Date().toISOString();
  run.checkpoint({ ...base, [PAGED_STATE_KEY]: state });
}

export function addCost(a: PageCost, b: PageCost): PageCost {
  return { page_loads: a.page_loads + b.page_loads, search_pages: a.search_pages + b.search_pages };
}

/** Never below zero: a bound computed from two records that a crash may have
 *  left inconsistent must not come back negative. */
export function subtractCost(a: PageCost, b: PageCost): PageCost {
  return {
    page_loads: Math.max(0, a.page_loads - b.page_loads),
    search_pages: Math.max(0, a.search_pages - b.search_pages),
  };
}

export function totalCost(spends: readonly { spent: PageCost }[]): PageCost {
  return spends.reduce((acc, s) => addCost(acc, s.spent), { ...ZERO_PAGE_COST });
}

/** The upper bound on ledger lines this run cannot account for. */
export function totalUnconfirmed(spends: readonly { unconfirmed?: PageCost }[]): PageCost {
  return spends.reduce(
    (acc, s) => (s.unconfirmed ? addCost(acc, s.unconfirmed) : acc),
    { ...ZERO_PAGE_COST },
  );
}

export type Reconciliation = {
  state: PagedCheckpointState;
  /** Pages whose claim the archive did not corroborate, dropped and due to be
   *  loaded (and paid for) again. */
  respentPages: number[];
  /** A page whose bytes were all on disk although its completion checkpoint
   *  never landed. Adopted with its original spend — never paid for twice. */
  adoptedPage: number | null;
  orphansAdded: string[];
  warnings: Warning[];
};

function planMismatch(expected: string, found: string): CapabilityError {
  return new CapabilityError({
    code: "PAGED_RESUME_PLAN_MISMATCH",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `this run id was opened for a different paged plan — resuming it would file one ` +
      `search's pages behind another's checkpoint`,
    evidence: JSON.stringify({ checkpoint_plan: found, requested_plan: expected }),
  });
}

/**
 * Decides what a resumed run may keep, by reading the archive rather than the
 * checkpoint's claim about it (the contract's headline).
 *
 * Three outcomes per record:
 *
 * - **Proved.** Every archive id the page named is on disk. Kept, not re-spent.
 * - **Torn.** A named id is missing. That page and *every page after it* are
 *   dropped — the pages after it were reached through a cursor the dropped page
 *   produced, and a cursor chain cannot be trusted past a hole. Their bytes
 *   stay on disk as orphans and their spends are recorded as wasted.
 * - **Adopted.** The in-flight attempt archived exactly as many bodies as it
 *   said it would. All its bytes are on disk, only the completion checkpoint
 *   is missing, so it becomes a completed page carrying its original spend.
 *   Anything short of the full count is torn, not adopted: a partial page
 *   silently promoted is the one failure no later step could detect.
 */
export async function reconcile(o: {
  state: PagedCheckpointState;
  archive: PagedArchive;
  plan: string;
}): Promise<Reconciliation> {
  const state = o.state;
  if (state.plan !== o.plan) throw planMismatch(o.plan, state.plan);

  const entries = await o.archive.list();
  const present = new Set(entries.map((e) => e.file));

  const kept: CompletedPage[] = [];
  const dropped: CompletedPage[] = [];
  let torn = false;

  for (const page of state.pages) {
    const proved = !torn && page.archive_ids.length > 0 && page.archive_ids.every((id) => present.has(id));
    if (proved) {
      kept.push(page);
      continue;
    }
    torn = true;
    dropped.push(page);
  }

  const orphansAdded: string[] = [];
  const wasted: WastedSpend[] = [...state.wasted];
  const now = new Date().toISOString();

  for (const page of dropped) {
    for (const id of page.archive_ids) if (present.has(id)) orphansAdded.push(id);
    wasted.push({ page: page.page, spent: page.spent, at: now, reason: "torn-archive" });
  }

  let adoptedPage: number | null = null;
  const attempt = state.attempt;
  if (attempt) {
    const claimed = new Set(kept.flatMap((p) => p.archive_ids));
    // Two shapes, and which one this attempt used decides what "all its bytes
    // are on disk" means.
    //
    // **Named ids** — the source archived its own bytes and said which. Every
    // named id must be present, and only those ids are this page's. This is the
    // live, tap-driven shape: the archive also holds every other body the page
    // fetched, so counting entries in the range would find more than `expected`
    // on an ordinary page and refuse to adopt a page that is entirely on disk,
    // which is D346 read backwards.
    //
    // **A count** — the loop wrote the bytes itself, so the ids did not exist
    // when the attempt was recorded. Everything above the attempt's high-water
    // mark is this page's by construction, and a count short of `expected` is a
    // torn write. Anything short is torn, never adopted: a partial page silently
    // promoted is the one failure no later step could detect.
    const named = attempt.archive_ids;
    const mine = named !== undefined
      ? named.filter((id) => present.has(id))
      : entries
          .filter((e) => e.seq >= attempt.archive_seq_before && !claimed.has(e.file))
          .map((e) => e.file);

    // `spend_confirmed` is redundant with `expected` — a page is only loaded
    // after its spend commits — and is required anyway, because adoption keeps
    // the attempt's own spend and must never keep one nobody watched land.
    const complete = named !== undefined
      ? named.length > 0 && mine.length === named.length
      : attempt.expected !== null && attempt.expected > 0 && mine.length === attempt.expected;
    const whole = !torn && attempt.spend_confirmed && complete;

    if (whole) {
      kept.push({
        page: attempt.page,
        archive_ids: mine,
        items: attempt.items ?? 0,
        has_more: attempt.hasMore ?? false,
        spent: attempt.spent,
        ...(attempt.fingerprint === undefined ? {} : { fingerprint: attempt.fingerprint }),
        ...(attempt.cursor === undefined ? {} : { cursor: attempt.cursor }),
        completed_at: now,
      });
      adoptedPage = attempt.page;
    } else {
      orphansAdded.push(...mine);
      // What the ledger may hold for this attempt beyond what the loop watched
      // commit. Zero once the spend confirmed; otherwise the rest of the plan,
      // which is a bound and not a count — see D347.
      const unconfirmed = attempt.spend_confirmed
        ? { ...ZERO_PAGE_COST }
        : subtractCost(attempt.spend_plan, attempt.spent);
      wasted.push({
        page: attempt.page,
        spent: attempt.spent,
        ...(unconfirmed.page_loads > 0 || unconfirmed.search_pages > 0 ? { unconfirmed } : {}),
        at: now,
        reason: !attempt.spend_confirmed
          ? "crash-in-spend"
          : mine.length === 0 ? "crash-before-load" : "torn-archive",
      });
    }
  }

  const respentPages = dropped.map((p) => p.page);
  if (attempt && adoptedPage === null) respentPages.push(attempt.page);

  const warnings: Warning[] = [];
  if (respentPages.length > 0) {
    warnings.push({ code: "RESUMED_PAGE_RESPENT", n: respentPages.length, field: respentPages.join(",") });
  }
  if (adoptedPage !== null) {
    warnings.push({ code: "RESUMED_PAGE_ADOPTED", n: 1, field: String(adoptedPage) });
  }
  if (orphansAdded.length > 0) {
    warnings.push({ code: "RESUMED_ORPHAN_CAPTURES", n: orphansAdded.length });
  }

  const orphans = [...new Set([...state.orphans, ...orphansAdded])];

  return {
    state: { ...state, pages: kept, attempt: null, orphans, wasted, stop: null },
    respentPages,
    adoptedPage,
    orphansAdded,
    warnings,
  };
}
