import type { CapabilityContext } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import { summarizeCaptures } from "../profile.capture/patterns.js";
import type { CaptureSummary } from "../profile.capture/patterns.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import type { ReadResult } from "../profile.capture/read.js";
import { waitForAny } from "../../core/tap/ready.js";
import { captureDomSnapshot } from "../profile.capture/snapshot.js";
import type { DomSnapshotResult } from "../profile.capture/snapshot.js";
import { sessionUrnsOf, sessionVanitiesOf } from "../profile.capture/identity.js";
import {
  FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS,
} from "../profile.capture/constants.js";
import { urnInventory } from "../activity.capture/patterns.js";
import type { UrnInventory } from "../activity.capture/patterns.js";
import {
  BROAD_PATTERN_NAME, FEED_DOCUMENT_NAME, FEED_PATTERNS, feedDocumentPattern, isFeedIsh,
} from "./patterns.js";
import { FEED_URL, MAX_INVENTORIED_BODIES } from "./constants.js";

/**
 * One metered read of the operator's own `/feed/`, archived raw.
 *
 * It is `activity.capture`'s shape, deliberately — same scroller measurement,
 * same human pacing, same DOM snapshot, same raw-first archive, same two
 * challenge gates, same readiness gate — with two differences that follow from
 * D325 and are the whole reason this is a separate function rather than a call
 * into that capability:
 *
 * 1. **The read is bounded and never bottom-seeking.** A feed does not end, so
 *    `untilBottom` (D320) is not passed and cannot be: it would mean "scroll to
 *    the ceiling" every single time. The caller passes a fixed pass count
 *    derived from `--limit`, and what the read did not reach is reported as
 *    partial rather than as the whole feed.
 * 2. **There is no subject.** `normalizeActivityUrl` refuses `/feed/`, and it
 *    should: every other surface in that family belongs to one person. Here the
 *    session's own identity is resolved to *tag* the operator's items, not to
 *    find a subject, and it is returned rather than acted on.
 *
 * This function parses nothing. Whether the page's fields came from a captured
 * body or only from the rendered DOM is a question its archive answers and this
 * code does not presume — which is the condition attached to the D325 grant.
 */

export type FeedCaptureResult = {
  snapshot: DomSnapshotResult | null;
  reading: ReadResult | null;
  summary: CaptureSummary;
  /** The operator's own urns and vanities, for tagging their own items. */
  sessionUrns: string[];
  sessionVanities: string[];
  /** The urn sweep over the captured JSON bodies — the measurement that decides
   *  whether the DOM exception is needed at all. */
  bodySweep: {
    inventoried: number;
    notInventoried: number;
    inventory: UrnInventory;
  };
  warnings: Warning[];
  foreground: { ok: boolean; via: string | null };
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

/**
 * How much of the feed was left below the last pass, in pixels.
 *
 * Reads `travelled` — where the scroller ended up — and never `scrolled`, which
 * is distance dispatched and counts a pass back up as progress.
 * `readLikeAHuman` takes a back-pass a quarter of the time, so 600 down, 300 up,
 * 300 down is 1200px of `scrolled` at position 600, and the wrong one of these
 * reports a 900px page as fully read from halfway down. Same function and same
 * reasoning as `activity.capture`'s `feedShortfall`; kept here because on this
 * surface a shortfall is the *expected* outcome rather than a warning sign, and
 * the two will not stay the same number.
 */
export function unreadBelow(
  reading: { travelled: number; scrollable: number | null } | null,
): number {
  if (reading === null || reading.scrollable === null) return 0;
  return Math.max(0, reading.scrollable - reading.travelled);
}

export async function captureFeed(
  ctx: CapabilityContext<{ captureTimeoutMs?: number; layoutTimeoutMs?: number }, true>,
  o: { passes: number },
): Promise<FeedCaptureResult> {
  const { run, args: a, browser, budget } = ctx;
  const { tab, tap, cursor, archive } = browser;
  const warnings: Warning[] = [];

  // Checked before it is spent, so a run refused by the ledger has not also
  // opened a page. No profile open and no search page: the feed is one page of
  // the operator's own, and a spend of either kind under this name would mean
  // this reader is doing something it was not built to do.
  await budget.check({ kind: "page_load", n: 1 });

  const patterns = [...FEED_PATTERNS, feedDocumentPattern()];
  const releaseWatches = patterns.map((pattern) => tap.watch(pattern));
  const since = tap.cursor;

  // Spent before the navigation, not after: a crash mid-load must leave the
  // ledger over-counting, never under-counting (§8).
  await budget.spend({ kind: "page_load", n: 1 });

  // A background tab is timer-clamped and never fires IntersectionObserver, and
  // a feed is nothing but lazily-rendered cards.
  const foreground = await tab.ensureForeground();
  run.log("render.wait", {
    phase: "capture",
    detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
  });
  if (!foreground.ok) {
    warnings.push({
      code: "TAB_NOT_FOREGROUND",
      n: 1,
      field: "the worker tab still reports itself hidden; feed cards may not have loaded",
    });
  }

  const checkpointState = { target: { url: FEED_URL }, phase: "navigate" as string };
  run.log("nav.start", { phase: "capture", item_ref: "feed", detail: { url: FEED_URL } });
  const navStarted = Date.now();
  await tab.navigate(FEED_URL);
  run.log("nav.done", { phase: "capture", item_ref: "feed", duration_ms: Date.now() - navStarted });

  let reading: ReadResult | null = null;
  let snapshot: DomSnapshotResult | null = null;
  try {
    checkpointState.phase = "post-navigation-gate";
    await assertNoChallenge({ tab, run, state: checkpointState });

    // Either the API or this surface's own document. Waiting on the API alone
    // threw away three runs on 2026-08-10 that held a fully populated document
    // with the page load already spent (D321).
    checkpointState.phase = "await-first-capture";
    await waitForAny(tap, [BROAD_PATTERN_NAME, FEED_DOCUMENT_NAME], {
      since,
      timeoutMs: a.captureTimeoutMs ?? FIRST_CAPTURE_TIMEOUT_MS,
    });

    checkpointState.phase = "read";
    // `passes` explicitly, and `untilBottom` deliberately absent (D325).
    reading = await readLikeAHuman({
      tab,
      cursor,
      passes: o.passes,
      ...(a.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: a.layoutTimeoutMs }),
    });
    run.log("render.wait", {
      phase: "capture",
      detail: {
        layout_settled: reading.layout.settled,
        layout_waited_ms: reading.layout.waitedMs,
        layout_polls: reading.layout.polls,
        passes: reading.passes,
        notches: reading.notches,
        scrolled: reading.scrolled,
        paused_ms: reading.pausedMs,
        // Which element actually scrolls, measured rather than assumed. D115 is
        // the standing proof that guessing this wrong captures an empty page.
        scroller: reading.viewport?.scroller ?? null,
        scroller_candidates: reading.viewport?.scrollerCandidates ?? null,
      },
    });

    // Late fetches triggered by the last scroll. Passive: nothing is requested
    // and nothing is spent — only time.
    await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

    checkpointState.phase = "snapshot";
    snapshot = await captureDomSnapshot({
      tab, archive, targetUrl: FEED_URL, timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
      phase: "capture",
      item_ref: "feed",
      ...(snapshot.archived === null ? { level: "warn" as const } : {}),
      detail: {
        kind: "dom-snapshot",
        file: snapshot.archived?.file ?? null,
        bytes: snapshot.archived?.bytes ?? 0,
        rendered: snapshot.rendered,
        container: snapshot.probe?.container ?? null,
        failure: snapshot.failure,
      },
    });

    checkpointState.phase = "pre-success-gate";
    await assertNoChallenge({ tab, run, state: checkpointState });
  } finally {
    // Raw-first is not conditional (D2). Every body already on the wire is
    // archived before this function returns, on the throwing paths too.
    await tap.drain();
    // Only after the drain: releasing a watch stops bodies being fetched for it.
    for (const release of releaseWatches) release();
  }

  const captures = tap.captures();
  const summary = summarizeCaptures(captures, tap.misses(), patterns, { isRelevant: isFeedIsh });

  // The status gate, over what the page fetched rather than over the page.
  const detections: ChallengeDetection[] = [];
  for (const capture of captures) {
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
    // D111: a status-derived `unrecognized` on one subresource is reported and
    // left to the operator, not treated as a halt.
    warnings.push({
      code: "RESPONSE_STATUS_UNRECOGNIZED",
      n: detections.length,
      field: detections.map((d) => d.detail).join("; "),
    });
  }

  if (reading !== null && !reading.layout.settled) {
    warnings.push({
      code: "PAGE_NOT_LAID_OUT",
      n: 1,
      field:
        `nothing on the page ever measured taller than the viewport within the layout window ` +
        `(${reading.layout.waitedMs}ms, ${reading.layout.polls} polls) — neither the document ` +
        `nor any inner scroller (D115); feed cards will not have fetched`,
    });
  }

  // The DOM snapshot's three distinct outcomes, each with its own code because
  // each sends the operator somewhere different.
  if (snapshot === null || snapshot.failure === "probe-failed") {
    warnings.push({
      code: "DOM_SNAPSHOT_FAILED",
      n: 1,
      field:
        `the rendered-DOM snapshot could not be read from the page, so there is no content ` +
        `fixture: ${snapshot?.detail ?? "the read was never reached"}`,
    });
  } else if (snapshot.failure === "archive-failed") {
    warnings.push({
      code: "DOM_SNAPSHOT_NOT_ARCHIVED",
      n: 1,
      field:
        `the snapshot was read from the page but could not be written to the raw archive, so ` +
        `nothing may parse it (D2): ${snapshot.detail ?? "unknown"}`,
    });
  } else if (!snapshot.rendered) {
    const c = snapshot.probe?.container;
    warnings.push({
      code: "FEED_CONTAINER_NOT_RENDERED",
      n: 1,
      field:
        `the snapshot is archived but the page's main container did not render ` +
        `(selector ${c?.selector === null || c === undefined ? "not found" : c.selector}, ` +
        `${c?.textChars ?? 0} chars of text, ${c?.sections ?? 0} sections)`,
    });
  }

  // Identity. `sessionUrnsOf` is the one implementation of "who is the operator"
  // (D133) — never re-derived here. On this surface it tags the operator's own
  // items rather than finding a subject (D325), so an empty set is a warning
  // about tagging, not about the whole read.
  const sessionUrns = sessionUrnsOf(captures);
  const sessionVanities = sessionVanitiesOf(captures);
  if (sessionUrns.length === 0 && sessionVanities.length === 0) {
    warnings.push({
      code: "SESSION_IDENTITY_UNAVAILABLE",
      n: 1,
      field:
        "neither a /voyager/api/me body nor a com.linkedin.voyager.common.Me document island " +
        "was captured (D322), so the operator's own feed items cannot be tagged as theirs",
    });
  }

  // Bounded on purpose: a feed page can archive dozens of megabyte bodies. What
  // was skipped is reported, not dropped.
  const relevant = captures.filter((c) => isFeedIsh(c.body));
  const inventoried = relevant.slice(0, MAX_INVENTORIED_BODIES);
  const inventory = urnInventory(inventoried.map((c) => c.body).join("\n"));

  if (summary.profile_ish === 0) {
    // The measurement D325 asked for, stated on the receipt. Not a failure: it
    // is the finding that the DOM exception is the only source available here.
    warnings.push({
      code: "NO_FEED_PAYLOAD",
      n: 1,
      field:
        `${summary.captured} linkedin api responses archived, none carrying feed-item data — ` +
        `the DOM snapshot is the only source on this surface (D325's fallback is in use)`,
    });
  }
  if (summary.unmatched_profile_ish > 0) {
    warnings.push({
      code: "PATTERN_MISMATCH",
      n: summary.unmatched_profile_ish,
      field: "feed payloads arrived on endpoints no specific pattern matched — see data.capture.endpoints",
    });
  }
  if (summary.misses > 0) {
    warnings.push({
      code: "CAPTURE_MISSES",
      n: summary.misses,
      field: "watched responses seen but not delivered — see capture.miss events",
    });
  }
  if (summary.captured === 0) {
    throw transient(
      "FEED_NO_CAPTURE",
      "the feed page loaded but no LinkedIn response was archived",
      `run=${run.runId}`,
    );
  }

  return {
    snapshot,
    reading,
    summary,
    sessionUrns,
    sessionVanities,
    bodySweep: {
      inventoried: inventoried.length,
      notInventoried: relevant.length - inventoried.length,
      inventory,
    },
    warnings,
    foreground: { ok: foreground.ok, via: foreground.via },
  };
}
