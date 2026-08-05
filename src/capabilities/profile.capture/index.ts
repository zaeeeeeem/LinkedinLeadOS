import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import { BROAD_PATTERN_NAME, PROFILE_PATTERNS, summarizeCaptures } from "./patterns.js";
import type { EndpointRow } from "./patterns.js";
import { normalizeProfileUrl } from "./url.js";
import { readLikeAHuman } from "./read.js";
import { FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN } from "./constants.js";

/**
 * How many endpoint rows reach the receipt. The full table is on disk in the raw
 * archive's sidecars; stdout is a bounded envelope (§4.1, D3) and a profile page
 * can issue well over a hundred API calls.
 */
export const RECEIPT_ENDPOINT_CAP = 40;

const args = z
  .object({
    /** A profile url, a bare vanity slug, or a Sales Navigator lead url. */
    url: z.string().min(1),
    /** Scroll passes. Omitted: a randomized 3–6. `0` captures above the fold only. */
    scrolls: z.coerce.number().int().min(0).max(12).optional(),
    /** How long to wait for the page's first LinkedIn api response. Raise it on
     *  a slow connection; the wait itself costs nothing but time. */
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    /** How long to wait for the page to lay out before scrolling it. Raise it on
     *  a slow render; the wait is passive and spends nothing. */
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

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
 * `profile.capture` — open one profile, archive everything the page fetches.
 *
 * This is the discovery capability behind `profile.get` (Task 17): it makes the
 * one real page load, keeps every response body raw (D2), and reports what the
 * page actually asked for so a parser can be written against reality rather than
 * against a remembered endpoint list. It parses nothing and stores nothing.
 *
 * The safety rails are all live, because this spends a real profile view on the
 * one account: preflight, budget checked and then recorded, challenge detection
 * after navigation *and* before declaring success, human pacing for the scroll
 * that triggers LinkedIn's lazy fetches, and a randomized dwell. Whatever
 * happens — challenge, timeout, a throw halfway through — the tap is drained
 * before the error leaves, so the archive keeps what was seen.
 */
export const capability = defineCapability({
  name: "profile.capture",
  risk: "read-cheap",
  summary: "Open one LinkedIn profile and archive every profile response the page fetches, raw.",
  args,
  needsBrowser: true,
  cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 1 }),
  run: async ({ run, args: a, browser, budget }) => {
    const { tab, tap, cursor } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const target = normalizeProfileUrl(a.url);
    const warnings: Warning[] = [];

    // Both limits are consulted before either is recorded, so a run refused by
    // the daily profile cap has not also burned a page load, and vice versa.
    await budget.check({ kind: "page_load", n: 1 });
    await budget.check({ kind: "profile_open", ref: target.ref });

    for (const pattern of PROFILE_PATTERNS) tap.watch(pattern);
    const since = tap.cursor;

    // Spent before the navigation, not after: a crash mid-load must leave the
    // ledger over-counting, never under-counting. The ledger protects the
    // account; the direction it errs in is the whole point (§8).
    await budget.spend({ kind: "page_load", n: 1 });
    await budget.spend({ kind: "profile_open", ref: target.ref });

    // A background tab is timer-clamped and never fires IntersectionObserver, so
    // LinkedIn's lazy sections would never fetch and the capture would be of a
    // page that never finished rendering.
    const foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "capture",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });
    if (!foreground.ok) {
      warnings.push({
        code: "TAB_NOT_FOREGROUND",
        n: 1,
        field: "the worker tab still reports itself hidden; lazy sections may not have loaded",
      });
    }

    const checkpointState = { target, phase: "navigate" as string };
    run.log("nav.start", { phase: "capture", item_ref: target.ref, detail: { kind: target.kind } });
    const navStarted = Date.now();
    await tab.navigate(target.url);
    run.log("nav.done", {
      phase: "capture",
      item_ref: target.ref,
      duration_ms: Date.now() - navStarted,
    });

    let reading: Awaited<ReturnType<typeof readLikeAHuman>> | null = null;
    try {
      // Gate one: what did we actually land on?
      checkpointState.phase = "post-navigation-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });

      // The page is LinkedIn's own; wait for its own first API response rather
      // than for a fixed time. Fails transient, which is what it is.
      checkpointState.phase = "await-first-capture";
      await tap.waitFor(BROAD_PATTERN_NAME, {
        since,
        timeoutMs: a.captureTimeoutMs ?? FIRST_CAPTURE_TIMEOUT_MS,
      });

      checkpointState.phase = "read";
      reading = await readLikeAHuman({
        tab,
        cursor,
        ...(a.scrolls === undefined ? {} : { passes: a.scrolls }),
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
          measured: reading.viewport !== null,
        },
      });

      // Late fetches triggered by the last scroll. Passive: nothing is requested
      // and nothing is spent — only time.
      await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

      // Gate two: nothing may be declared successful without re-checking. A
      // challenge that appears *during* the read is the case this catches.
      checkpointState.phase = "pre-success-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });
    } finally {
      // Raw-first is not conditional (D2). Every body already on the wire is
      // archived before this function returns, on the throwing paths too — the
      // whole value of a spent page load is what it left on disk.
      await tap.drain();
    }

    const summary = summarizeCaptures(tap.captures(), tap.misses());

    // The status gate. `classifyResponse` is deny-list plus status (D61), so it
    // runs over what the page fetched rather than over the page itself.
    const detections: ChallengeDetection[] = [];
    for (const capture of tap.captures()) {
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
      // `unrecognized` from a *status* is D63's "we do not know" — a 403 is
      // "logged out" or "out of network" and the two want opposite responses.
      // For the page we are sitting on that ambiguity is worth a halt; for one
      // subresource among fifty on a page the DOM gate already certified clean,
      // it is not. Reported, and left to the operator. See D111.
      warnings.push({
        code: "RESPONSE_STATUS_UNRECOGNIZED",
        n: detections.length,
        field: detections.map((d) => d.detail).join("; "),
      });
    }

    if (reading !== null && !reading.layout.settled) {
      // The first live run's failure mode, and it was silent: `navigate` resolves
      // on readyState complete, LinkedIn's shell measured exactly one viewport
      // tall, nothing scrolled, no lazy section fetched, and the receipt said ok
      // with `passes: 0` and no warning at all. A page that never laid out has
      // almost certainly not issued the fetches this capability came for.
      warnings.push({
        code: "PAGE_NOT_LAID_OUT",
        n: 1,
        field:
          `the document never grew past the viewport within the layout window ` +
          `(${reading.layout.waitedMs}ms, ${reading.layout.polls} polls); ` +
          `lazily-loaded sections will not have fetched`,
      });
    }

    if (summary.profile_ish === 0) {
      // Not a failure: the archive is the product, and this run produced one.
      // But an operator must never read an ok receipt as "we got the profile"
      // when nothing carrying person data arrived.
      warnings.push({
        code: "NO_PROFILE_PAYLOAD",
        n: 1,
        field: `${summary.captured} linkedin api responses archived, none carrying person data`,
      });
    }
    if (summary.unmatched_profile_ish > 0) {
      // The finding this capability exists to surface: LinkedIn is serving the
      // profile from an endpoint no watched pattern predicted.
      warnings.push({
        code: "PATTERN_MISMATCH",
        n: summary.unmatched_profile_ish,
        field: "profile payloads arrived on endpoints no specific pattern matched — see data.capture.endpoints",
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
      // Unreachable while `waitFor` above succeeded, and kept anyway: a receipt
      // reporting ok with an empty archive is the one outcome that cannot be
      // allowed to happen quietly.
      throw transient(
        "PROFILE_NO_CAPTURE",
        "the profile page loaded but no LinkedIn api response was archived",
        `run=${run.runId}`,
      );
    }

    const shown = receiptEndpoints(summary.endpoints);

    return {
      counts: {
        requested: 1,
        captured: summary.captured,
        usable: summary.profile_ish,
        skipped: summary.misses,
      },
      warnings,
      data: {
        target,
        foreground: { ok: foreground.ok, via: foreground.via },
        reading: reading
          ? {
              passes: reading.passes,
              notches: reading.notches,
              scrolled_px: reading.scrolled,
              paused_ms: reading.pausedMs,
              viewport: reading.viewport,
              layout: reading.layout,
            }
          : null,
        capture: {
          patterns: summary.patterns,
          captured: summary.captured,
          profile_ish: summary.profile_ish,
          unmatched_profile_ish: summary.unmatched_profile_ish,
          misses: summary.misses,
          endpoints: shown,
          endpoints_omitted: summary.endpoints.length - shown.length,
        },
        tap: tap.stats(),
        artifacts: run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${run.runId}` +
        `   # then read fixtures/profile.get/FIELD-MAP.md`,
    };
  },
});

/**
 * Which endpoint rows are worth stdout. The ones carrying person data and the
 * ones nothing predicted are the whole answer to "did the patterns match
 * reality"; the rest is noise the raw archive already holds.
 */
function receiptEndpoints(rows: EndpointRow[]): EndpointRow[] {
  return rows.filter((r) => r.profile_ish || r.unpredicted).slice(0, RECEIPT_ENDPOINT_CAP);
}

export default capability;
