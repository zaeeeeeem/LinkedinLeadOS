import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import { BROAD_PATTERN_NAME, PROFILE_PATTERNS, documentPattern, summarizeCaptures } from "./patterns.js";
import type { EndpointRow } from "./patterns.js";
import { normalizeProfileUrl } from "./url.js";
import { readLikeAHuman } from "./read.js";
import { captureDomSnapshot } from "./snapshot.js";
import type { DomSnapshotResult } from "./snapshot.js";
import { checkIdentity } from "./identity.js";
import {
  FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS,
} from "./constants.js";

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
    const { tab, tap, cursor, archive } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const target = normalizeProfileUrl(a.url);
    const warnings: Warning[] = [];

    // Both limits are consulted before either is recorded, so a run refused by
    // the daily profile cap has not also burned a page load, and vice versa.
    await budget.check({ kind: "page_load", n: 1 });
    await budget.check({ kind: "profile_open", ref: target.ref });

    // The document response for this exact target, alongside the API patterns.
    // `/in/<vanity>` is a page rather than an API path, so no broad pattern can
    // reach it and D116's question — is the profile payload server-rendered into
    // the navigation response — is unanswerable without naming it (D120).
    const patterns = [...PROFILE_PATTERNS, documentPattern(target.url)];
    for (const pattern of patterns) tap.watch(pattern);
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
    let snapshot: DomSnapshotResult | null = null;
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

      // The rendered DOM, after everything that was going to render has. This
      // is the profile's *content* (D123) — the one place a data field may be
      // read off the DOM, because no Voyager endpoint carries it on a cold load
      // (D121). Archived raw like any body, parsed offline, never here.
      checkpointState.phase = "snapshot";
      snapshot = await captureDomSnapshot({
        tab, archive, targetUrl: target.url, timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
      // A snapshot that never reached disk is a `capture.miss`, not a hit with a
      // null filename: `log:why` groups by event name, and a lost body counted
      // as a hit is the silent loss the tap was fixed for (D52).
      run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
        phase: "capture",
        item_ref: target.ref,
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

    const summary = summarizeCaptures(tap.captures(), tap.misses(), patterns);

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
          `nothing on the page ever measured taller than the viewport within the layout ` +
          `window (${reading.layout.waitedMs}ms, ${reading.layout.polls} polls) — neither the ` +
          `document nor any inner scroller (D115); lazily-loaded sections will not have fetched`,
      });
    }

    // The DOM snapshot's three distinct outcomes, each with its own code because
    // each sends the operator somewhere different: the page would not answer,
    // the archive would not take the answer, or the page answered with a shell.
    if (snapshot === null || snapshot.failure === "probe-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_FAILED",
        n: 1,
        field:
          `the rendered-DOM snapshot could not be read from the page, so this run has no ` +
          `content fixture (D123): ${snapshot?.detail ?? "the read was never reached"}`,
      });
    } else if (snapshot.failure === "archive-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_NOT_ARCHIVED",
        n: 1,
        field:
          `the snapshot was read from the page but could not be written to the raw archive, ` +
          `so nothing may parse it (D2): ${snapshot.detail ?? "unknown"}`,
      });
    } else if (!snapshot.rendered) {
      const c = snapshot.probe?.container;
      warnings.push({
        code: "SUBJECT_CONTAINER_NOT_RENDERED",
        n: 1,
        field:
          `the snapshot is archived but the subject's main container did not render ` +
          `(selector ${c?.selector === null || c === undefined ? "not found" : c.selector}, ` +
          `${c?.textChars ?? 0} chars of text, ${c?.sections ?? 0} sections) — ` +
          `do not write a parser against this fixture`,
      });
    } else if (snapshot.probe !== null && snapshot.probe.container.sidebarsInside > 0) {
      // Container scoping is the whole reason the DOM is usable where the RSC
      // flight tree was not (D123). A sidebar *inside* the container means a
      // parser scoped to it can still read a "people also viewed" stranger.
      warnings.push({
        code: "SUBJECT_CONTAINER_NOT_SCOPED",
        n: snapshot.probe.container.sidebarsInside,
        field:
          `the subject's container holds sidebar elements, so scoping to it does not ` +
          `by itself exclude "people also viewed" suggestions (D121, D123)`,
      });
    }

    // Identity: the other half of D123's split. Content without a subject urn is
    // content that cannot be keyed, deduped, or aged — a first-class outcome.
    const identity = checkIdentity(tap.captures());
    if (identity.bodies === 0) {
      warnings.push({
        code: "IDENTITY_BODY_ABSENT",
        n: 1,
        field:
          "no voyagerIdentityDashProfiles response was captured, so this run has no subject " +
          "urn to key the profile on (D123)",
      });
    } else if (!identity.found) {
      warnings.push({
        code: "IDENTITY_URN_ABSENT",
        n: identity.bodies,
        field:
          `${identity.bodies} voyagerIdentityDashProfiles body/bodies were captured but none ` +
          `carried a subject urn at identityDashProfilesByMemberIdentity — the endpoint moved (D121)`,
      });
    } else if (identity.isSession) {
      warnings.push({
        code: "IDENTITY_URN_IS_SESSION",
        n: 1,
        field:
          `the urn at ${identity.path} is the logged-in operator's own, not the subject's — ` +
          `a parser keyed on it returns this account for every prospect (D119)`,
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
        snapshot: {
          archived: snapshot?.archived?.file ?? null,
          bytes: snapshot?.archived?.bytes ?? 0,
          rendered: snapshot?.rendered ?? false,
          failure: snapshot?.failure ?? null,
          container: snapshot?.probe?.container ?? null,
          html_chars: snapshot?.probe?.htmlChars ?? 0,
          page_text_chars: snapshot?.probe?.textChars ?? 0,
        },
        identity,
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
