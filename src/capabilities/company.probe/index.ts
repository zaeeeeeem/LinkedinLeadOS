import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse, CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import type { Capture } from "../../core/tap/network-tap.js";
import {
  documentPattern, isProfileIsh, summarizeCaptures, type EndpointRow,
} from "../profile.capture/patterns.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import { captureDomSnapshot, type SnapshotContainer } from "../profile.capture/snapshot.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS } from "../profile.capture/constants.js";
import {
  BROAD_PATTERN_NAME, COMPANY_PATTERNS, documentPatternName, isCompanyIsh,
} from "./patterns.js";
import {
  PROBE_MAX_PAGE_LOADS, RECEIPT_ENDPOINTS_PER_SUBPAGE, SUBPAGE_API_TIMEOUT_MS, SURFACE_TIMEOUT_MS,
} from "./constants.js";
import { companySubPageUrl, normalizeCompanyUrl, parseSubPages, type CompanySubPage } from "./url.js";
import { interpretSurface, surfaceExpression, type SurfaceReport } from "./surface.js";

const args = z
  .object({
    /** A company url, a bare `/company/<slug>` path, or a bare slug. */
    url: z.string().min(1),
    /**
     * Which sub-pages to load, comma-separated. Omitted: all five.
     *
     * Validated here, in the schema, rather than only inside `run`: the runner
     * checks args before it estimates cost, opens a tab or takes the lease, so
     * a typo costs nothing. Validating it in `cost()` instead would surface as
     * `COST_ESTIMATE_FAILED`, and validating it only in `run()` would open a
     * browser tab to reject a misspelling.
     */
    subpages: z.string().optional().superRefine((raw, ctx) => {
      try {
        parseSubPages(raw);
      } catch (cause) {
        ctx.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }),
    /** Scroll passes per sub-page. Omitted: `profile.capture`'s randomized 3–6. */
    scrolls: z.coerce.number().int().min(0).max(12).optional(),
    /** How long to wait for a sub-page's first LinkedIn api response. */
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    /** How long to wait for a sub-page to lay out before scrolling it. */
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

/** How far one sub-page got. Written *before* each stage is attempted, so a
 *  throw leaves a record naming where it died rather than an absent one. */
export type SubPageStage =
  | "navigate" | "post-navigation-gate" | "await-api" | "read" | "snapshot" | "surface"
  | "pre-success-gate" | "done";

export type SubPageOutcome = {
  sub: CompanySubPage;
  /** The url this probe asked for. */
  requested_url: string;
  /** `location.href` at the moment of the surface read — a redirect measured
   *  rather than assumed away. `null` when the surface could not be read. */
  landed_url: string | null;
  stage: SubPageStage;
  /** True once the ledger has recorded this sub-page's page load. */
  page_load_spent: boolean;
  /** False when the broad net answered nothing inside the timeout. A finding,
   *  not a failure: the document response and the snapshot still landed. */
  api_response: boolean;
  captured: number;
  /** Bodies carrying company-family data (`isCompanyIsh`). */
  company_ish: number;
  /** Bodies carrying *person* data. The people sub-page is a person-urn
   *  minefield (Task 24), and a probe that reported only company markers would
   *  say "nothing here" about the surface with the most identity risk. */
  person_ish: number;
  /** Company-carrying bodies that no `specific` pattern predicted. */
  unmatched_company_ish: number;
  misses: number;
  layout_settled: boolean;
  scroll_passes: number;
  scrolled_px: number;
  snapshot: {
    archived: string | null;
    bytes: number;
    rendered: boolean;
    failure: string | null;
    container: SnapshotContainer | null;
  };
  surface: SurfaceReport | null;
  endpoints: EndpointRow[];
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
  });
}

/** Highest-precedence detection of a set, by the same ordering the gate uses. */
function worstOf(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((worst, d) =>
    CHALLENGE_PRECEDENCE.indexOf(d.kind) < CHALLENGE_PRECEDENCE.indexOf(worst.kind) ? d : worst,
  );
}

/** The tap's own code for "nothing matched inside the window". */
const CAPTURE_TIMEOUT_CODE = "CAPTURE_TIMEOUT";

/** The slice of `NetworkTap` the wait needs. */
export type WaitingTap = {
  waitFor(pattern: string, opts: { since?: number; timeoutMs?: number }): Promise<unknown>;
};

/**
 * Whether this sub-page issued a LinkedIn api response inside the window.
 *
 * A **timeout** is the finding (D172): the document response and the DOM
 * snapshot are collected either way, and "this tab fetches nothing" is one of
 * the answers the probe exists to return.
 *
 * Every other rejection is re-thrown unchanged. `TAP_UNKNOWN_PATTERN` and
 * `TAP_STOPPED` are fatal and are bugs in this repo; swallowing one would put
 * "this sub-page issues no api calls" on the receipt, which sends an operator
 * to LinkedIn over a defect in here. Errors classified one layer down pass
 * through rather than being re-decided (D17).
 */
export async function awaitFirstApiResponse(
  tap: WaitingTap,
  o: { since: number; timeoutMs: number },
): Promise<boolean> {
  try {
    await tap.waitFor(BROAD_PATTERN_NAME, o);
    return true;
  } catch (cause) {
    if (!(cause instanceof CapabilityError) || cause.code !== CAPTURE_TIMEOUT_CODE) throw cause;
    return false;
  }
}

/** Path-only comparison of two urls, for "did this sub-page redirect". Query
 *  and trailing slash are dropped for `documentKey`'s reasons (D113). */
export function samePage(a: string, b: string): boolean {
  const key = (raw: string): string | null => {
    try {
      return new URL(raw).pathname.replace(/\/+$/, "").toLowerCase();
    } catch {
      return null;
    }
  };
  const ka = key(a);
  const kb = key(b);
  return ka !== null && ka === kb;
}

/**
 * `company.probe` — load a company's page family and archive everything, so a
 * parser is written against measurement instead of memory.
 *
 * It is the Task 15/16 lesson made structural (D152): the four company readers
 * of Tasks 22–25 all start here, and none of them may be designed before this
 * has run. It parses nothing, stores nothing, and resolves no identity — its
 * whole product is what it leaves on disk plus what the receipt says about it.
 *
 * The safety rails are the ones `profile.capture` proved, per sub-page: budget
 * checked before it is spent and spent before the navigation, challenge gates
 * after navigation *and* before declaring a sub-page done, human pacing for the
 * scroll, a randomized dwell, and `tap.drain()` in a `finally` that covers the
 * whole loop — so a throw on sub-page three still leaves sub-pages one and two
 * fully archived.
 */
export const capability = defineCapability({
  name: "company.probe",
  risk: "read-cheap",
  summary: "Load a company's page family and archive every response and DOM snapshot, raw, for offline field mapping.",
  args,
  needsBrowser: true,
  cost: (a) => ({ page_loads: parseSubPages(a.subpages).length, search_pages: 0, profile_opens: 0 }),
  run: async ({ run, args: a, browser, budget }) => {
    const { tab, tap, cursor, archive } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const target = normalizeCompanyUrl(a.url);
    const subs = parseSubPages(a.subpages);
    const warnings: Warning[] = [];

    if (subs.length > PROBE_MAX_PAGE_LOADS) {
      // Unreachable while there are five sub-pages, and kept because the ceiling
      // is the task's stated spend discipline rather than an artifact of the list.
      throw new CapabilityError({
        code: "PROBE_BUDGET_EXCEEDED",
        exit: EXIT.BUDGET,
        action: "HALT_AND_NOTIFY",
        retryable: false,
        message: `this probe may load at most ${PROBE_MAX_PAGE_LOADS} pages; ${subs.length} were asked for`,
      });
    }

    // The whole invocation's page loads, cleared before the first one is spent.
    //
    // The runner's preflight has already checked this same total against
    // `cost()` and is the primary gate; this is a second, in-capability guard
    // for a *direct* caller — the composition Tasks 22–25 will use, the way
    // `profile.get` calls `profile.capture.run` with its own `RunBudget`. Such
    // a caller gets no preflight, and without this its probe would refuse
    // mid-way with two or three page loads already spent on a measurement
    // nobody can use.
    await budget.check({ kind: "page_load", n: subs.length });

    // One watch per sub-page document, named apart, plus the api patterns. A
    // `/company/<slug>/` url is a page rather than an api path, so no broad net
    // can reach it and the document has to be named (D120).
    const patterns = [
      ...COMPANY_PATTERNS,
      ...subs.map((sub) => documentPattern(companySubPageUrl(target, sub), documentPatternName(sub))),
    ];
    for (const pattern of patterns) tap.watch(pattern);

    // A background tab is timer-clamped and never fires IntersectionObserver, so
    // LinkedIn's lazy sections would never fetch.
    const foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "probe",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });
    if (!foreground.ok) {
      warnings.push({
        code: "TAB_NOT_FOREGROUND",
        n: 1,
        field: "the worker tab still reports itself hidden; lazy sections may not have loaded",
      });
    }

    const outcomes: SubPageOutcome[] = [];
    const checkpointState = { target, sub: subs[0] ?? null, phase: "navigate" as string };

    try {
      for (const sub of subs) {
        const requestedUrl = companySubPageUrl(target, sub);
        // Pushed before anything is attempted. Every field below is written the
        // moment it becomes true, never after the loop — a receipt assembled at
        // the end describes only the runs that reached the end.
        const outcome: SubPageOutcome = {
          sub,
          requested_url: requestedUrl,
          landed_url: null,
          stage: "navigate",
          page_load_spent: false,
          api_response: false,
          captured: 0,
          company_ish: 0,
          person_ish: 0,
          unmatched_company_ish: 0,
          misses: 0,
          layout_settled: false,
          scroll_passes: 0,
          scrolled_px: 0,
          snapshot: { archived: null, bytes: 0, rendered: false, failure: null, container: null },
          surface: null,
          endpoints: [],
        };
        outcomes.push(outcome);
        checkpointState.sub = sub;
        checkpointState.phase = "navigate";

        // Checked again per load: the ledger is shared, and another run may have
        // spent the day's remainder since the batch check above.
        await budget.check({ kind: "page_load", n: 1 });
        // Spent before the navigation, not after: a crash mid-load must leave the
        // ledger over-counting, never under-counting (§8).
        await budget.spend({ kind: "page_load", n: 1 });
        outcome.page_load_spent = true;

        const since = tap.cursor;
        const missesBefore = tap.misses().length;
        run.log("nav.start", { phase: "probe", item_ref: `${target.ref}#${sub}` });
        const navStarted = Date.now();
        await tab.navigate(requestedUrl);
        run.log("nav.done", {
          phase: "probe",
          item_ref: `${target.ref}#${sub}`,
          duration_ms: Date.now() - navStarted,
        });

        // Gate one: what did we actually land on?
        outcome.stage = "post-navigation-gate";
        checkpointState.phase = "post-navigation-gate";
        await assertNoChallenge({ tab, run, state: checkpointState });

        // Unlike `profile.capture`, a sub-page that issues no api call is a
        // *measurement*, not a failure — the document response and the DOM
        // snapshot are collected either way, and "this tab fetches nothing" is
        // one of the answers Tasks 22–25 need.
        outcome.stage = "await-api";
        checkpointState.phase = "await-api";
        outcome.api_response = await awaitFirstApiResponse(tap, {
          since,
          timeoutMs: a.captureTimeoutMs ?? SUBPAGE_API_TIMEOUT_MS,
        });

        outcome.stage = "read";
        checkpointState.phase = "read";
        const reading = await readLikeAHuman({
          tab,
          cursor,
          ...(a.scrolls === undefined ? {} : { passes: a.scrolls }),
          ...(a.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: a.layoutTimeoutMs }),
        });
        outcome.layout_settled = reading.layout.settled;
        outcome.scroll_passes = reading.passes;
        outcome.scrolled_px = reading.scrolled;
        run.log("render.wait", {
          phase: "probe",
          item_ref: `${target.ref}#${sub}`,
          detail: {
            layout_settled: reading.layout.settled,
            layout_waited_ms: reading.layout.waitedMs,
            passes: reading.passes,
            scrolled: reading.scrolled,
            inner_scroller: reading.viewport?.innerScroller ?? null,
          },
        });

        // Late fetches triggered by the last scroll. Passive: nothing is
        // requested and nothing is spent — only time.
        await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

        outcome.stage = "snapshot";
        checkpointState.phase = "snapshot";
        const snapshot = await captureDomSnapshot({
          tab, archive, targetUrl: requestedUrl, timeoutMs: SNAPSHOT_TIMEOUT_MS,
        });
        outcome.snapshot = {
          archived: snapshot.archived?.file ?? null,
          bytes: snapshot.archived?.bytes ?? 0,
          rendered: snapshot.rendered,
          failure: snapshot.failure,
          container: snapshot.probe?.container ?? null,
        };
        // A snapshot that never reached disk is a `capture.miss`, not a hit with
        // a null filename — a lost body counted as a hit is the silent loss the
        // tap was fixed for (D52, D124).
        run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
          phase: "probe",
          item_ref: `${target.ref}#${sub}`,
          ...(snapshot.archived === null ? { level: "warn" as const } : {}),
          detail: { kind: "dom-snapshot", ...outcome.snapshot },
        });

        outcome.stage = "surface";
        checkpointState.phase = "surface";
        let surface: SurfaceReport | null = null;
        try {
          surface = interpretSurface(
            await tab.evaluate<unknown>(surfaceExpression(target.segment), SURFACE_TIMEOUT_MS),
          );
        } catch {
          // The page load is already spent and the snapshot is already on disk;
          // a failed measurement must degrade the receipt, never discard them.
          surface = null;
        }
        outcome.surface = surface;
        outcome.landed_url = surface?.url ?? null;

        // Gate two: nothing may be declared done without re-checking. A
        // challenge that appears *during* the read is what this catches.
        outcome.stage = "pre-success-gate";
        checkpointState.phase = "pre-success-gate";
        await assertNoChallenge({ tab, run, state: checkpointState });

        // Drained *before* the slice, not only at the end of the run. A capture
        // enters the tap's list only once its body fetch and archive write have
        // finished, so a body still in flight here would be missing from this
        // sub-page's rows and — because the next sub-page's cursor is taken
        // after it lands — counted into the *next* sub-page's window instead.
        // Tasks 22–25 read `subpages[].endpoints` as "which endpoints does this
        // tab fetch"; attribution that can silently move a row to the wrong tab
        // is worse than no attribution. On the last sub-page there is no next
        // window at all and the row would simply be absent.
        await tap.drain();

        // `seq` is the tap's own monotonic index, so the slice from this
        // sub-page's cursor to the tap's current one is exactly what landed
        // while this sub-page was open.
        const mine = tap.captures().filter((c) => c.seq >= since);
        const myMisses = tap.misses().slice(missesBefore);
        const summary = summarizeCaptures(mine, myMisses, patterns, { isRelevant: isCompanyIsh });
        outcome.captured = summary.captured;
        outcome.company_ish = summary.profile_ish;
        outcome.person_ish = mine.filter((c) => isProfileIsh(c.body)).length;
        outcome.unmatched_company_ish = summary.unmatched_profile_ish;
        outcome.misses = summary.misses;
        outcome.endpoints = summary.endpoints
          .filter((e) => e.profile_ish || e.unpredicted)
          .slice(0, RECEIPT_ENDPOINTS_PER_SUBPAGE);

        outcome.stage = "done";
      }
    } catch (cause) {
      // The one place a mid-probe halt can leave a record. An error receipt is
      // built by the runner from the error alone — a capability's warnings are
      // not on it — so "which sub-pages finished and which one died where"
      // exists nowhere unless it is logged here, and a probe that halts on
      // sub-page three is exactly when an operator needs it. `log:why` reads
      // this file.
      const failed = outcomes.at(-1);
      if (failed !== undefined && failed.stage !== "done") {
        run.log("error", {
          level: "error",
          phase: "probe",
          item_ref: `${target.ref}#${failed.sub}`,
          detail: {
            code: cause instanceof CapabilityError ? cause.code : "UNCLASSIFIED",
            sub: failed.sub,
            stopped_at: failed.stage,
            page_load_spent: failed.page_load_spent,
            completed: outcomes.filter((o) => o.stage === "done").map((o) => o.sub),
            not_attempted: subs.slice(outcomes.length),
          },
        });
      }
      throw cause;
    } finally {
      // Raw-first is not conditional (D2). Every body already on the wire is
      // archived before this function returns, on the throwing paths too.
      await tap.drain();
    }

    const all = tap.captures();
    const overall = summarizeCaptures(all, tap.misses(), patterns, { isRelevant: isCompanyIsh });

    // The status gate. `classifyResponse` is deny-list plus status (D61), so it
    // runs over what the pages fetched rather than over the pages themselves.
    const detections: ChallengeDetection[] = [];
    for (const capture of all) {
      const verdict = classifyResponse({ status: capture.status, url: capture.url });
      if (!verdict.clean) detections.push(verdict);
    }
    const halting = detections.filter((d) => d.kind !== "unrecognized");
    if (halting.length > 0) {
      throw await recordChallenge({
        detection: worstOf(halting),
        tab,
        run,
        state: { ...checkpointState, phase: "response-status-gate" },
      });
    }
    if (detections.length > 0) {
      warnings.push({
        code: "RESPONSE_STATUS_UNRECOGNIZED",
        n: detections.length,
        field: detections.map((d) => d.detail).join("; "),
      });
    }

    pushSurfaceWarnings(warnings, outcomes);

    if (overall.profile_ish === 0) {
      warnings.push({
        code: "NO_COMPANY_PAYLOAD",
        n: 1,
        field: `${overall.captured} linkedin api responses archived across ${outcomes.length} sub-pages, none carrying company-family data`,
      });
    }
    if (overall.unmatched_profile_ish > 0) {
      // The finding this capability exists to surface, and on a first probe of
      // an unmeasured surface it is the *expected* reading, not an alarm.
      warnings.push({
        code: "PATTERN_MISMATCH",
        n: overall.unmatched_profile_ish,
        field: "company payloads arrived on endpoints no specific pattern matched — see data.subpages[].endpoints",
      });
    }
    if (overall.misses > 0) {
      warnings.push({
        code: "CAPTURE_MISSES",
        n: overall.misses,
        field: "watched responses seen but not delivered — see capture.miss events",
      });
    }
    if (overall.captured === 0) {
      // A receipt reporting ok with an empty archive is the one outcome that
      // cannot be allowed to happen quietly.
      throw transient(
        "PROBE_NO_CAPTURE",
        `${outcomes.length} company sub-pages loaded and no LinkedIn api response was archived`,
        `run=${run.runId}`,
      );
    }

    const snapshots = outcomes.filter((o) => o.snapshot.archived !== null).length;

    return {
      counts: {
        requested: subs.length,
        captured: overall.captured,
        usable: overall.profile_ish,
        skipped: overall.misses,
      },
      warnings,
      data: {
        target: { kind: target.kind, ref: target.ref, url: target.url },
        foreground: { ok: foreground.ok, via: foreground.via },
        subpages: outcomes,
        snapshots,
        // The comparison set every later identity check runs against (D119,
        // D126, D131). Its size only — the urns themselves are the operator's
        // own identity and receipts go to stdout (§4.1, D3).
        session_urns: sessionUrnsOf(all).length,
        capture: {
          patterns: overall.patterns,
          captured: overall.captured,
          company_ish: overall.profile_ish,
          unmatched_company_ish: overall.unmatched_profile_ish,
          misses: overall.misses,
        },
        tap: tap.stats(),
        artifacts: run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${run.runId} --capability=company.get --subject=${target.vanity}` +
        `   # then npm run sweep -- --run=${run.runId} --want=... to build the FIELD-MAP`,
    };
  },
});

/**
 * The per-sub-page findings, aggregated into one warning each.
 *
 * Aggregated rather than one warning per sub-page because the receipt's warning
 * list is what an operator scans: five `SUBPAGE_NOT_LAID_OUT` rows say the same
 * thing five times, while one row naming which five is actionable. Exported so
 * every branch is provable without a browser.
 */
export function pushSurfaceWarnings(warnings: Warning[], outcomes: readonly SubPageOutcome[]): void {
  const named = (list: readonly SubPageOutcome[]): string => list.map((o) => o.sub).join(", ");

  // Only completed sub-pages are described here, and the `stage === "done"`
  // filters below are what enforce it. There is deliberately no
  // "this one did not finish" warning: a sub-page can only fail by throwing out
  // of the loop, and the runner builds an error receipt from the error alone —
  // a warning added on that path would never reach a receipt at all. The
  // durable record of a halt is the `error` event logged where it happens.
  const noApi = outcomes.filter((o) => o.stage === "done" && !o.api_response);
  if (noApi.length > 0) {
    warnings.push({
      code: "SUBPAGE_NO_API_RESPONSE",
      n: noApi.length,
      field:
        `${named(noApi)} issued no LinkedIn api response inside the wait — their data, if any, ` +
        `is in the document response or the DOM snapshot only`,
    });
  }

  const unsettled = outcomes.filter((o) => o.stage === "done" && !o.layout_settled);
  if (unsettled.length > 0) {
    warnings.push({
      code: "SUBPAGE_NOT_LAID_OUT",
      n: unsettled.length,
      field:
        `${named(unsettled)} never measured taller than the viewport inside the layout window — ` +
        `neither the document nor any inner scroller (D115); lazily-loaded sections will not have fetched`,
    });
  }

  const redirected = outcomes.filter(
    (o) => o.landed_url !== null && !samePage(o.requested_url, o.landed_url),
  );
  if (redirected.length > 0) {
    // The sub-page url form is one of this probe's deliverables. A tab that
    // redirects somewhere else means Tasks 22–25 must not use the url this
    // probe asked for, and it is invisible unless measured.
    warnings.push({
      code: "SUBPAGE_REDIRECTED",
      n: redirected.length,
      field:
        `${named(redirected)} did not stay on the url that was requested — the sub-page url form ` +
        `recorded for this surface must be the landed one, not the asked-for one`,
    });
  }

  const noSnapshot = outcomes.filter((o) => o.stage === "done" && o.snapshot.archived === null);
  if (noSnapshot.length > 0) {
    warnings.push({
      code: "DOM_SNAPSHOT_MISSING",
      n: noSnapshot.length,
      field:
        `${named(noSnapshot)} produced no archived DOM snapshot ` +
        `(${noSnapshot.map((o) => `${o.sub}: ${o.snapshot.failure ?? "unknown"}`).join(", ")}) — ` +
        `there is no content fixture for them`,
    });
  }

  const shell = outcomes.filter((o) => o.snapshot.archived !== null && !o.snapshot.rendered);
  if (shell.length > 0) {
    warnings.push({
      code: "SUBJECT_CONTAINER_NOT_RENDERED",
      n: shell.length,
      field: `${named(shell)} archived a snapshot whose main container never filled — do not write a parser against those fixtures`,
    });
  }

  const unmeasured = outcomes.filter((o) => o.stage === "done" && o.surface === null);
  if (unmeasured.length > 0) {
    warnings.push({
      code: "SURFACE_UNMEASURED",
      n: unmeasured.length,
      field:
        `${named(unmeasured)} would not answer the structural measurement, so this run says nothing ` +
        `about their scroller, tab links or embedded json`,
    });
  }
}

/** Compile-time proof that a `Capture` is all the attribution slice needs, so a
 *  change to the tap's record shape breaks here rather than at run time. */
const _sliceable: (c: Capture) => number = (c) => c.seq;
void _sliceable;

export default capability;
