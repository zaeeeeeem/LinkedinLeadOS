import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse, CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { documentPattern, summarizeCaptures, type EndpointRow } from "../profile.capture/patterns.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import { captureDomSnapshot, type SnapshotContainer } from "../profile.capture/snapshot.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS } from "../profile.capture/constants.js";
import {
  BROAD_PATTERN_NAME, documentPatternName, isSalesNavIsh, looksLikeUpsell, SALESNAV_PATTERNS,
} from "./patterns.js";
import {
  PROBE_MAX_PAGE_LOADS, PROBE_MAX_SEARCH_PAGES, RECEIPT_ENDPOINTS_PER_SURFACE,
  SURFACE_API_TIMEOUT_MS, SURFACE_TIMEOUT_MS,
} from "./constants.js";
import {
  DEFAULT_ACCOUNTS_SEARCH_URL, DEFAULT_LEADS_SEARCH_URL, isSearchPage, normalizeSalesNavUrl,
  parseSurfaces, SALESNAV_HOME_URL, searchPageUrl, type SalesNavSurface, type SalesNavTarget,
} from "./url.js";
import { interpretSurface, paginationVerdict, surfaceExpression, type PaginationVerdict, type SurfaceReport } from "./surface.js";
import { clickPagerControl, pagingFromCaptures, type ClickReport, type PagingEvidence } from "./pager.js";

const args = z
  .object({
    /** The leads search to probe. Omitted: LinkedIn's own unfiltered
     *  `/sales/search/people` tab — never a synthesized filter url (M6 owns
     *  filter building, and a probe of an invented query measures a page the
     *  product does not itself produce). */
    url: z.string().min(1).optional(),
    /** The accounts search to probe. Omitted: `/sales/search/company`. */
    accountsUrl: z.string().min(1).optional(),
    /**
     * Which surfaces to load, comma-separated. Omitted: all four.
     *
     * Validated here, in the schema, rather than only inside `run`: the runner
     * checks args before it estimates cost, opens a tab or takes the lease, so
     * a typo costs nothing. On this surface a typo would otherwise cost a
     * metered search page — the scarcest budget in the system.
     */
    surfaces: z.string().optional().superRefine((raw, ctx) => {
      try {
        parseSurfaces(raw);
      } catch (cause) {
        ctx.addIssue({ code: "custom", message: cause instanceof Error ? cause.message : String(cause) });
      }
    }),
    /** Scroll passes per surface. Omitted: `profile.capture`'s randomized 3–6. */
    scrolls: z.coerce.number().int().min(0).max(12).optional(),
    /** How long to wait for a surface's first LinkedIn response. */
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    /** How long to wait for a surface to lay out before scrolling it. */
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

/** How far one surface got. Written *before* each stage is attempted, so a
 *  throw leaves a record naming where it died rather than an absent one. */
export type SurfaceStage =
  | "navigate" | "click-next" | "post-navigation-gate" | "await-api" | "read" | "snapshot" | "measure"
  | "seat-gate" | "pre-success-gate" | "done" | "skipped";

/** How a surface was reached. `click` exists only since D400 and only for a
 *  pager control; see `pager.ts` for what that grant does and does not cover. */
export type SurfaceArrival = "navigate" | "click";

export type SurfaceOutcome = {
  surface: SalesNavSurface;
  requested_url: string;
  /** `location.href` at the moment of the measurement — a redirect measured
   *  rather than assumed away. `null` when the surface could not be read. */
  landed_url: string | null;
  stage: SurfaceStage;
  /** Why this surface was never loaded, when it was not. The `leads2` skip is
   *  the designed one: page 2 is not spent unless page 1 proved the UI itself
   *  offers a page-2 url. */
  skipped_reason: string | null;
  page_load_spent: boolean;
  search_page_spent: boolean;
  /** False when the broad net answered nothing inside the timeout. A finding,
   *  not a failure: the document response and the snapshot still landed. */
  api_response: boolean;
  captured: number;
  /** How this surface was reached (D400). */
  arrival: SurfaceArrival;
  /** What was clicked to reach it, when it was reached by clicking. */
  click: ClickReport | null;
  /**
   * `paging.start` / `paging.count` from a body captured on this surface.
   *
   * The arrival check for a clicked page, and the **only** body read this
   * capability performs: two integers, no row and no urn (D400 clause 6). A
   * pager's own label can advance on a re-render that changed no rows, so the
   * button is not evidence that a page turned.
   */
  paging: PagingEvidence | null;
  /** Bodies carrying Sales-Nav-family data (`isSalesNavIsh`). */
  salesnav_ish: number;
  /**
   * The same count with this surface's **own document response excluded**.
   *
   * The source verdict turns on this rather than on `salesnav_ish`. A
   * server-rendered document carrying `/sales/lead/` links in its markup is
   * `isSalesNavIsh`, and counting it would report "the rows are in a labeled
   * body" for a page whose rows are in fact markup — the exact reading that
   * would skip the `[DECISION NEEDED]` to extend CLAUDE.md's DOM exception
   * list. Embedded structured JSON in a document is readable under D117, but
   * that is a claim only the offline sweep can make; this count refuses to make
   * it on a live receipt.
   */
  salesnav_ish_api: number;
  /** Sales-Nav-carrying bodies that no `specific` pattern predicted. */
  unmatched_salesnav_ish: number;
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
  surface_report: SurfaceReport | null;
  /** How this surface offers page 2, when it is a results page. */
  pagination: PaginationVerdict | null;
  endpoints: EndpointRow[];
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
  });
}

/**
 * The seat check's refusal.
 *
 * Deliberately **not** a challenge (exit 2): a missing Sales Navigator seat is a
 * product state, not a defence, and nothing about it is solved by a screenshot
 * and a retry. It is the operator's decision — acquire a seat, or pivot M5 to
 * the classic search family (plan README precondition 1) — so it halts and
 * notifies with the evidence that produced the verdict.
 */
export function noSeatError(evidence: string): CapabilityError {
  return new CapabilityError({
    code: "SALESNAV_NO_SEAT",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      "/sales/ did not render the Sales Navigator app — this account appears to have no active seat. " +
      "[DECISION NEEDED] acquire a seat or pivot M5 to the classic search family; M5 as written cannot run. " +
      "Nothing further was loaded and nothing was retried.",
    evidence,
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
 * Whether this surface issued a LinkedIn response inside the window.
 *
 * A **timeout** is the finding (D172): the document response and the DOM
 * snapshot are collected either way, and "this surface fetches nothing" is one
 * of the answers the probe exists to return — on this surface it is the answer
 * that decides the whole milestone's parsing strategy.
 *
 * Every other rejection is re-thrown unchanged. `TAP_UNKNOWN_PATTERN` and
 * `TAP_STOPPED` are fatal and are bugs in this repo; swallowing one would put
 * "this surface issues no api calls" on the receipt, which sends an operator to
 * LinkedIn over a defect in here (D17).
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

/**
 * The seat verdict for the `/sales/` load, from three independent signals.
 *
 * Pure so every branch is provable without a browser, and conservative in one
 * direction only: a surface that could not be measured at all is **not** called
 * seatless. An unmeasurable page is a different failure and gets a different
 * warning; calling it "no seat" would send the operator to buy something they
 * may already own.
 */
export function seatVerdict(
  report: SurfaceReport | null,
  bodies: readonly string[],
): { hasSeat: boolean | null; evidence: string } {
  if (report === null) return { hasSeat: null, evidence: "the /sales/ surface could not be measured" };
  const upsellBody = bodies.some((body) => looksLikeUpsell(body));
  if (report.seat.redirectedOffSales) {
    return { hasSeat: false, evidence: `/sales/ redirected to ${report.url}` };
  }
  if (report.seat.upsell || upsellBody) {
    return {
      hasSeat: false,
      evidence: `upsell markers present (dom=${report.seat.upsell}, body=${upsellBody})`,
    };
  }
  if (report.seat.appShell) return { hasSeat: true, evidence: "sales navigator app shell rendered" };
  return {
    hasSeat: null,
    evidence: "no app shell and no upsell markers — /sales/ rendered something neither measurement recognises",
  };
}

/**
 * Whether page 2 may be spent, and by which means, given page 1's measurement.
 *
 * The gate that keeps this probe inside M5 CONTEXT rule 4. Two ways in, and the
 * page decides which — never the flag:
 *
 * - `url` — page 1's own pager offered an href carrying `page=N`. Navigating it
 *   is the page's own navigation, allowed like any cold load. Sales Navigator
 *   does not do this (D352); the branch stays because a build that starts to
 *   would be a navigation, not a click, and should be taken as one.
 * - `click` — the pager expresses itself in buttons. **Granted by D400** on
 *   2026-08-11, bounded by every clause in `pager.ts`. Before that grant this
 *   was the refusal branch, and the refusal is what produced the decision.
 *
 * A page that rendered no pager is still refused, unspent: there is no page 2 to
 * reach, and a probe that spends one to find that out has measured nothing.
 */
export function mayLoadPageTwo(
  page1: SurfaceOutcome | undefined,
): { ok: false; mode: null; reason: string } | { ok: true; mode: SurfaceArrival; reason: string } {
  if (page1 === undefined || page1.stage !== "done") {
    return { ok: false, mode: null, reason: "page 1 did not complete, so nothing measured how the ui reaches page 2" };
  }
  if (page1.pagination === "none") {
    return {
      ok: false,
      mode: null,
      reason: "page 1 rendered no pager — this search has one page of results, or it never rendered",
    };
  }
  if (page1.pagination === "url") {
    return { ok: true, mode: "navigate", reason: "page 1's own pager offers an href carrying page=N" };
  }
  return {
    ok: true,
    mode: "click",
    reason: "page 1's pager is buttons only; page 2 is reached by clicking next, per the D400 grant",
  };
}

/**
 * `salesnav.probe` — load the Sales Navigator search surfaces and archive
 * everything, so Task 38's parsers are written against measurement instead of
 * memory.
 *
 * It parses nothing, stores nothing, resolves no identity and clicks nothing.
 * Its whole product is what it leaves on disk plus what the receipt says about
 * it — above all the two verdicts M5 forks on: **where the result-row fields
 * live** (labeled body vs DOM only) and **how the real UI reaches page 2**.
 *
 * The safety rails are the ones `profile.capture` and `company.probe` proved,
 * per surface: budget checked before it is spent and spent before the
 * navigation, challenge gates after navigation *and* before declaring a surface
 * done, human pacing for the scroll, a randomized dwell, and `tap.drain()` in a
 * `finally` covering the whole loop — so a throw on surface three still leaves
 * surfaces one and two fully archived. Sales Navigator is the most defended
 * surface this account will ever touch (M5 CONTEXT rule 3), which is an
 * argument for reusing those rails rather than trimming them.
 */
export const capability = defineCapability({
  name: "salesnav.probe",
  risk: "read-cheap",
  summary: "Load the Sales Navigator search surfaces and archive every response and DOM snapshot, raw, for offline field mapping.",
  args,
  needsBrowser: true,
  cost: (a) => {
    const surfaces = parseSurfaces(a.surfaces);
    return {
      page_loads: surfaces.length,
      // Costed as if page 2 will be loaded. It may be skipped once page 1 is
      // measured, and an estimate that under-states is the one direction a
      // budget estimate must never take (§8).
      search_pages: surfaces.filter(isSearchPage).length,
      profile_opens: 0,
    };
  },
  run: async ({ run, args: a, browser, budget }) => {
    const { tab, tap, cursor, archive } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const surfaces = parseSurfaces(a.surfaces);
    const leads = normalizeSalesNavUrl(a.url ?? DEFAULT_LEADS_SEARCH_URL);
    const accounts = normalizeSalesNavUrl(a.accountsUrl ?? DEFAULT_ACCOUNTS_SEARCH_URL);
    const warnings: Warning[] = [];

    const searchPages = surfaces.filter(isSearchPage).length;
    if (surfaces.length > PROBE_MAX_PAGE_LOADS || searchPages > PROBE_MAX_SEARCH_PAGES) {
      // Unreachable while there are four surfaces, and kept because the ceiling
      // is the task's stated spend discipline rather than an artifact of the
      // list — the next surface added must not raise it silently.
      throw new CapabilityError({
        code: "PROBE_BUDGET_EXCEEDED",
        exit: EXIT.BUDGET,
        action: "HALT_AND_NOTIFY",
        retryable: false,
        message:
          `this probe may load at most ${PROBE_MAX_PAGE_LOADS} pages and ${PROBE_MAX_SEARCH_PAGES} search pages; ` +
          `${surfaces.length} pages and ${searchPages} search pages were asked for`,
      });
    }

    // The whole invocation's spend, cleared before the first page is loaded.
    //
    // The runner's preflight has already checked this same total against
    // `cost()` and is the primary gate; this is a second, in-capability guard
    // for a *direct* caller — the composition Tasks 39/40 will use. Such a
    // caller gets no preflight, and without this the probe would refuse
    // mid-way with two or three metered search pages already spent on a
    // measurement nobody can use.
    await budget.check({ kind: "page_load", n: surfaces.length });
    if (searchPages > 0) await budget.check({ kind: "search_page", n: searchPages });

    const urlFor = (surface: SalesNavSurface): string => {
      switch (surface) {
        case "home": return SALESNAV_HOME_URL;
        case "leads": return leads.url;
        // Rendered here and navigated only if page 1 says the ui offers it.
        case "leads2": return searchPageUrl(leads, 2);
        case "accounts": return accounts.url;
      }
    };
    const targetFor = (surface: SalesNavSurface): SalesNavTarget | null =>
      surface === "home" ? null : surface === "accounts" ? accounts : leads;

    // One watch per surface document, named apart, plus the api patterns. A
    // `/sales/search/people` url is a page rather than an api path, so no broad
    // net reaches it and the document has to be named (D120).
    const patterns = [
      ...SALESNAV_PATTERNS,
      ...surfaces.map((s) => documentPattern(urlFor(s), documentPatternName(s))),
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

    const outcomes: SurfaceOutcome[] = [];
    const checkpointState = { surface: surfaces[0] ?? null, phase: "navigate" as string };
    let seat: { hasSeat: boolean | null; evidence: string } | null = null;

    try {
      for (const surface of surfaces) {
        const requestedUrl = urlFor(surface);
        // Pushed before anything is attempted. Every field below is written the
        // moment it becomes true, never after the loop — a receipt assembled at
        // the end describes only the runs that reached the end.
        const outcome: SurfaceOutcome = {
          surface,
          requested_url: requestedUrl,
          landed_url: null,
          stage: "navigate",
          skipped_reason: null,
          page_load_spent: false,
          search_page_spent: false,
          api_response: false,
          captured: 0,
          arrival: "navigate",
          click: null,
          paging: null,
          salesnav_ish: 0,
          salesnav_ish_api: 0,
          unmatched_salesnav_ish: 0,
          misses: 0,
          layout_settled: false,
          scroll_passes: 0,
          scrolled_px: 0,
          snapshot: { archived: null, bytes: 0, rendered: false, failure: null, container: null },
          surface_report: null,
          pagination: null,
          endpoints: [],
        };
        outcomes.push(outcome);
        checkpointState.surface = surface;
        checkpointState.phase = "navigate";

        // The one surface whose load is conditional on a measurement, and the
        // only one that may be reached by a click (D400).
        if (surface === "leads2") {
          const gate = mayLoadPageTwo(outcomes.find((o) => o.surface === "leads"));
          if (!gate.ok) {
            outcome.stage = "skipped";
            outcome.skipped_reason = gate.reason;
            continue;
          }
          outcome.arrival = gate.mode;
        }

        // Checked again per load: the ledger is shared, and another run may have
        // spent the day's remainder since the batch check above.
        await budget.check({ kind: "page_load", n: 1 });
        if (isSearchPage(surface)) await budget.check({ kind: "search_page", n: 1 });
        // Spent before the navigation, not after: a crash mid-load must leave
        // the ledger over-counting, never under-counting (§8, and the Task 35
        // paged contract this surface's readers will run under).
        await budget.spend({ kind: "page_load", n: 1 });
        outcome.page_load_spent = true;
        if (isSearchPage(surface)) {
          await budget.spend({ kind: "search_page", n: 1 });
          outcome.search_page_spent = true;
        }

        const since = tap.cursor;
        const missesBefore = tap.misses().length;
        const itemRef = targetFor(surface)?.ref ?? "salesnav:home";
        run.log("nav.start", {
          phase: "probe",
          item_ref: `${itemRef}#${surface}`,
          detail: { arrival: outcome.arrival },
        });
        const navStarted = Date.now();
        if (outcome.arrival === "click") {
          // The one click this toolkit performs. Everything that bounds it is
          // in `pager.ts`, which refuses rather than improvises: no match, two
          // matches, a disabled control or one that will not come into view all
          // raise here, after the page was spent and before anything is
          // claimed. The spend is already committed either way (§8).
          outcome.stage = "click-next";
          checkpointState.phase = "click-next";
          outcome.click = await clickPagerControl({ tab, cursor, direction: "next", timeoutMs: SURFACE_TIMEOUT_MS });
        } else {
          await tab.navigate(requestedUrl);
        }
        run.log("nav.done", {
          phase: "probe",
          item_ref: `${itemRef}#${surface}`,
          duration_ms: Date.now() - navStarted,
          detail: { arrival: outcome.arrival, control: outcome.click?.control ?? null },
        });

        // Gate one: what did we actually land on? Sales Navigator's challenge
        // markers are unmeasured (M5 CONTEXT rule 3) — expect `unrecognized`
        // halts here and record the marker rather than weakening the gate.
        outcome.stage = "post-navigation-gate";
        checkpointState.phase = "post-navigation-gate";
        await assertNoChallenge({ tab, run, state: checkpointState });

        outcome.stage = "await-api";
        checkpointState.phase = "await-api";
        outcome.api_response = await awaitFirstApiResponse(tap, {
          since,
          timeoutMs: a.captureTimeoutMs ?? SURFACE_API_TIMEOUT_MS,
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
          item_ref: `${itemRef}#${surface}`,
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
          item_ref: `${itemRef}#${surface}`,
          ...(snapshot.archived === null ? { level: "warn" as const } : {}),
          detail: { kind: "dom-snapshot", ...outcome.snapshot },
        });

        outcome.stage = "measure";
        checkpointState.phase = "measure";
        let report: SurfaceReport | null = null;
        try {
          report = interpretSurface(await tab.evaluate<unknown>(surfaceExpression(), SURFACE_TIMEOUT_MS));
        } catch {
          // The page load is already spent and the snapshot is already on disk;
          // a failed measurement must degrade the receipt, never discard them.
          report = null;
        }
        outcome.surface_report = report;
        outcome.landed_url = report?.url ?? null;
        outcome.pagination = report === null || surface === "home"
          ? null
          : paginationVerdict(report.pager);

        // Gate two, and only on `/sales/`: does this account have a seat?
        //
        // First, cheap and honest (Task 36). It runs before any metered search
        // page is spent, and a seatless account ends the task here rather than
        // being worked around.
        if (surface === "home") {
          outcome.stage = "seat-gate";
          checkpointState.phase = "seat-gate";
          await tap.drain();
          seat = seatVerdict(report, tap.captures().filter((c) => c.seq >= since).map((c) => c.body));
          // Logged as a parse outcome rather than through a new event kind: the
          // seat check *is* an interpretation of a page into a verdict, and the
          // `ok`/`miss` pair maps exactly onto determined/undetermined. Widening
          // the core event vocabulary for one capability would be the larger
          // change, and `log:why` reads these two already.
          run.log(seat.hasSeat === true ? "parse.ok" : "parse.miss", {
            phase: "probe",
            item_ref: itemRef,
            ...(seat.hasSeat === true ? {} : { level: "warn" as const }),
            detail: { check: "salesnav-seat", has_seat: seat.hasSeat, evidence: seat.evidence },
          });
          if (seat.hasSeat === false) {
            outcome.stage = "done";
            throw noSeatError(seat.evidence);
          }
        }

        // Gate three: nothing may be declared done without re-checking. A
        // challenge that appears *during* the read is what this catches.
        outcome.stage = "pre-success-gate";
        checkpointState.phase = "pre-success-gate";
        await assertNoChallenge({ tab, run, state: checkpointState });

        // Drained *before* the slice, not only at the end of the run. A capture
        // enters the tap's list only once its body fetch and archive write have
        // finished, so a body still in flight here would be missing from this
        // surface's rows and — because the next surface's cursor is taken after
        // it lands — counted into the *next* surface's window instead. Task 38
        // reads `surfaces[].endpoints` as "which endpoints does this page
        // fetch"; attribution that can silently move a row to the wrong page is
        // worse than no attribution.
        await tap.drain();

        // `seq` is the tap's own monotonic index, so the slice from this
        // surface's cursor to the tap's current one is exactly what landed while
        // this surface was open.
        const mine = tap.captures().filter((c) => c.seq >= since);
        const myMisses = tap.misses().slice(missesBefore);
        const summary = summarizeCaptures(mine, myMisses, patterns, { isRelevant: isSalesNavIsh });
        outcome.captured = summary.captured;
        outcome.salesnav_ish = summary.profile_ish;
        // This surface's own document response is excluded from both: the
        // source verdict must not be satisfiable by markup, and the arrival
        // check must not be satisfiable by a server-rendered shell.
        const ownDocument = documentPatternName(surface);
        outcome.salesnav_ish_api = summary.endpoints.filter(
          (e) => e.profile_ish && !e.patterns.includes(ownDocument),
        ).length;
        outcome.paging = pagingFromCaptures(mine, ownDocument);
        outcome.unmatched_salesnav_ish = summary.unmatched_profile_ish;
        outcome.misses = summary.misses;
        outcome.endpoints = summary.endpoints
          .filter((e) => e.profile_ish || e.unpredicted)
          .slice(0, RECEIPT_ENDPOINTS_PER_SURFACE);

        outcome.stage = "done";
      }
    } catch (cause) {
      // The one place a mid-probe halt can leave a record. An error receipt is
      // built by the runner from the error alone — a capability's warnings are
      // not on it — so "which surfaces finished and which one died where" exists
      // nowhere unless it is logged here. `log:why` reads this file.
      const failed = outcomes.at(-1);
      if (failed !== undefined) {
        run.log("error", {
          level: "error",
          phase: "probe",
          item_ref: `salesnav#${failed.surface}`,
          detail: {
            code: cause instanceof CapabilityError ? cause.code : "UNCLASSIFIED",
            surface: failed.surface,
            stopped_at: failed.stage,
            page_load_spent: failed.page_load_spent,
            search_page_spent: failed.search_page_spent,
            completed: outcomes.filter((o) => o.stage === "done").map((o) => o.surface),
            not_attempted: surfaces.slice(outcomes.length),
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
    const overall = summarizeCaptures(all, tap.misses(), patterns, { isRelevant: isSalesNavIsh });

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
      // M5 RECORDING: every `unrecognized` Sales Nav verdict gets its marker
      // recorded as a decision, whether or not the classifier is extended.
      warnings.push({
        code: "RESPONSE_STATUS_UNRECOGNIZED",
        n: detections.length,
        field: detections.map((d) => d.detail).join("; "),
      });
    }

    pushSurfaceWarnings(warnings, outcomes, seat);

    if (overall.captured === 0) {
      // A receipt reporting ok with an empty archive is the one outcome that
      // cannot be allowed to happen quietly.
      throw transient(
        "PROBE_NO_CAPTURE",
        `${outcomes.filter((o) => o.stage === "done").length} sales navigator surfaces loaded and no LinkedIn response was archived`,
        `run=${run.runId}`,
      );
    }

    const loaded = outcomes.filter((o) => o.stage === "done");
    const snapshots = outcomes.filter((o) => o.snapshot.archived !== null).length;

    return {
      counts: {
        requested: surfaces.length,
        captured: overall.captured,
        usable: overall.profile_ish,
        skipped: overall.misses,
      },
      warnings,
      data: {
        seat,
        // The two verdicts this task exists to produce, stated as data rather
        // than left to be inferred from the counts below them.
        verdicts: {
          pagination: Object.fromEntries(
            outcomes.filter((o) => o.pagination !== null).map((o) => [o.surface, o.pagination]),
          ),
          rows_in_labeled_body: sourceVerdict(outcomes),
          // How each surface was actually reached, and what the body said about
          // which page arrived. Stated rather than inferred, because "we clicked
          // and something rendered" is not the same claim as "page 2 arrived".
          arrival: Object.fromEntries(
            outcomes.filter((o) => o.stage === "done").map((o) => [o.surface, o.arrival]),
          ),
          paging: Object.fromEntries(
            outcomes.filter((o) => o.paging !== null).map((o) => [o.surface, o.paging]),
          ),
        },
        targets: {
          leads: { ref: leads.ref, vertical: leads.vertical, session_id: leads.sessionId !== null, saved_search: leads.savedSearchId !== null },
          accounts: { ref: accounts.ref, vertical: accounts.vertical, session_id: accounts.sessionId !== null, saved_search: accounts.savedSearchId !== null },
        },
        foreground: { ok: foreground.ok, via: foreground.via },
        surfaces: outcomes,
        snapshots,
        spent: {
          page_loads: outcomes.filter((o) => o.page_load_spent).length,
          search_pages: outcomes.filter((o) => o.search_page_spent).length,
        },
        // The comparison set every later identity check runs against (D119,
        // D126, D131). Its size only — the urns themselves are the operator's
        // own identity and receipts go to stdout (§4.1, D3).
        session_urns: sessionUrnsOf(all).length,
        capture: {
          patterns: overall.patterns,
          captured: overall.captured,
          salesnav_ish: overall.profile_ish,
          unmatched_salesnav_ish: overall.unmatched_profile_ish,
          misses: overall.misses,
        },
        tap: tap.stats(),
        artifacts: run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${run.runId} --capability=salesnav.probe` +
        `   # then npm run sweep -- --run=${run.runId} --want=... to build the FIELD-MAP` +
        (loaded.length === surfaces.length ? "" : "   # note: not every surface loaded — see warnings"),
    };
  },
});

/**
 * Whether the result rows arrived in a labeled body, per results surface.
 *
 * The milestone's fork, reduced to one boolean per surface. `true` means at
 * least one captured body on that surface carried Sales-Nav result markers, so
 * Task 38 parses bodies and M5 needs no DOM exception. `false` means the rows
 * rendered but no body carried them — the reading that raises a `[DECISION
 * NEEDED]` to extend CLAUDE.md's exception list, which is closed at five and
 * does not grow silently.
 */
export function sourceVerdict(outcomes: readonly SurfaceOutcome[]): Record<string, boolean | null> {
  const out: Record<string, boolean | null> = {};
  for (const o of outcomes) {
    if (o.surface === "home" || o.stage !== "done") continue;
    // `null` where nothing rendered: a page with no rows says nothing about
    // where rows live, and recording it as "not in a body" would be a verdict
    // the run did not earn.
    const rendered = (o.surface_report?.rows.leadLinks ?? 0) + (o.surface_report?.rows.accountLinks ?? 0);
    // `salesnav_ish_api`, not `salesnav_ish`: the surface's own document
    // response is `isSalesNavIsh` the moment it server-renders one
    // `/sales/lead/` link into its markup, and counting it here would answer
    // "the rows are in a labeled body" for a page whose rows are markup —
    // skipping the one `[DECISION NEEDED]` this verdict exists to raise.
    out[o.surface] = rendered === 0 ? null : o.salesnav_ish_api > 0;
  }
  return out;
}

/**
 * The per-surface findings, aggregated into one warning each.
 *
 * Aggregated rather than one warning per surface because the receipt's warning
 * list is what an operator scans. Exported so every branch is provable without
 * a browser.
 */
export function pushSurfaceWarnings(
  warnings: Warning[],
  outcomes: readonly SurfaceOutcome[],
  seat: { hasSeat: boolean | null; evidence: string } | null,
): void {
  const named = (list: readonly SurfaceOutcome[]): string => list.map((o) => o.surface).join(", ");
  const done = outcomes.filter((o) => o.stage === "done");
  const results = done.filter((o) => o.surface !== "home");

  if (seat !== null && seat.hasSeat === null) {
    warnings.push({
      code: "SALESNAV_SEAT_UNDETERMINED",
      n: 1,
      field:
        `${seat.evidence} — the probe continued, but nothing here proves the account has a seat; ` +
        `treat every verdict below as provisional`,
    });
  }

  const skipped = outcomes.filter((o) => o.stage === "skipped");
  if (skipped.length > 0) {
    warnings.push({
      code: "SURFACE_NOT_LOADED",
      n: skipped.length,
      field: skipped.map((o) => `${o.surface}: ${o.skipped_reason ?? "unknown"}`).join("; "),
    });
  }

  // The headline. A results page whose rows rendered but whose bodies carried
  // none of them is the reading that blocks Task 38 on an operator decision.
  const domOnly = results.filter((o) => {
    const rendered = (o.surface_report?.rows.leadLinks ?? 0) + (o.surface_report?.rows.accountLinks ?? 0);
    return rendered > 0 && o.salesnav_ish_api === 0;
  });
  if (domOnly.length > 0) {
    warnings.push({
      code: "ROWS_DOM_ONLY",
      n: domOnly.length,
      field:
        `${named(domOnly)} rendered result rows that no captured body carried — ` +
        `[DECISION NEEDED] Task 38 needs the CLAUDE.md DOM exception extended to the sales navigator ` +
        `surface before a parser may read them`,
    });
  }

  const clickOnly = results.filter((o) => o.pagination === "click-only");
  if (clickOnly.length > 0) {
    warnings.push({
      code: "PAGINATION_CLICK_ONLY",
      n: clickOnly.length,
      field:
        `${named(clickOnly)} exposes no pager href carrying page=N, so page 2 is reached by clicking ` +
        `next — allowed since D400 and bounded by it. Recorded, not an alarm: a build that started ` +
        `serving hrefs again would page by navigation instead, and this line is how that shows up`,
    });
  }

  // The arrival check for a clicked page (D400 clause 6). A page whose body
  // reports the same offset as the page before it means the click landed on
  // something that re-rendered rather than advanced — and a fixture promoted
  // from it would be page 1 filed as page 2.
  const clicked = done.filter((o) => o.arrival === "click");
  const notAdvanced = clicked.filter((o) => o.paging === null || o.paging.start === 0);
  if (notAdvanced.length > 0) {
    warnings.push({
      code: "PAGE_DID_NOT_ADVANCE",
      n: notAdvanced.length,
      field:
        `${named(notAdvanced)} was reached by clicking next, but no captured body reports a non-zero ` +
        `paging.start — the page may not have turned. Do not promote a fixture from it as page 2 ` +
        `(the pager's own label is not evidence, D400)`,
    });
  }

  // The arrival check is only as good as the body it read. A `paging` block off
  // some *other* endpoint — a filter layout, a lego module — is not this
  // search's offset, and saying so is the difference between evidence and a
  // coincidence.
  const indirect = done.filter((o) => o.paging?.from === "largest-body");
  if (indirect.length > 0) {
    warnings.push({
      code: "PAGING_SOURCE_INDIRECT",
      n: indirect.length,
      field:
        `${named(indirect)} reported paging offsets from a body that matched no named search endpoint — ` +
        `treat the page number as unconfirmed, and check which endpoint carried it before relying on it`,
    });
  }

  const noRows = results.filter(
    (o) => (o.surface_report?.rows.leadLinks ?? 0) + (o.surface_report?.rows.accountLinks ?? 0) === 0,
  );
  if (noRows.length > 0) {
    warnings.push({
      code: "NO_RESULT_ROWS",
      n: noRows.length,
      field:
        `${named(noRows)} rendered no /sales/lead/ or /sales/company/ links — either the search returned ` +
        `nothing or the page never finished rendering; do not write a parser against those fixtures`,
    });
  }

  const noApi = done.filter((o) => !o.api_response);
  if (noApi.length > 0) {
    warnings.push({
      code: "SURFACE_NO_API_RESPONSE",
      n: noApi.length,
      field:
        `${named(noApi)} issued no LinkedIn response inside the wait — their data, if any, is in the ` +
        `document response or the DOM snapshot only`,
    });
  }

  const unsettled = done.filter((o) => !o.layout_settled);
  if (unsettled.length > 0) {
    warnings.push({
      code: "SURFACE_NOT_LAID_OUT",
      n: unsettled.length,
      field:
        `${named(unsettled)} never measured taller than the viewport inside the layout window — ` +
        `neither the document nor any inner scroller (D115); lazily-loaded rows will not have fetched`,
    });
  }

  const noSnapshot = done.filter((o) => o.snapshot.archived === null);
  if (noSnapshot.length > 0) {
    warnings.push({
      code: "DOM_SNAPSHOT_MISSING",
      n: noSnapshot.length,
      field:
        `${named(noSnapshot)} produced no archived DOM snapshot ` +
        `(${noSnapshot.map((o) => `${o.surface}: ${o.snapshot.failure ?? "unknown"}`).join(", ")}) — ` +
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

  const unmeasured = done.filter((o) => o.surface_report === null);
  if (unmeasured.length > 0) {
    warnings.push({
      code: "SURFACE_UNMEASURED",
      n: unmeasured.length,
      field:
        `${named(unmeasured)} would not answer the structural measurement, so this run says nothing ` +
        `about their scroller, pager or row vocabulary`,
    });
  }

  const unmatched = done.filter((o) => o.unmatched_salesnav_ish > 0);
  if (unmatched.length > 0) {
    // The finding this capability exists to surface, and on a first probe of an
    // unmeasured surface it is the *expected* reading, not an alarm.
    warnings.push({
      code: "PATTERN_MISMATCH",
      n: unmatched.reduce((sum, o) => sum + o.unmatched_salesnav_ish, 0),
      field: "sales navigator payloads arrived on endpoints no specific pattern matched — see data.surfaces[].endpoints",
    });
  }

  const missed = done.filter((o) => o.misses > 0);
  if (missed.length > 0) {
    warnings.push({
      code: "CAPTURE_MISSES",
      n: missed.reduce((sum, o) => sum + o.misses, 0),
      field: "watched responses seen but not delivered — see capture.miss events",
    });
  }
}

export default capability;
