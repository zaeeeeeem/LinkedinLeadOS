import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse } from "../../core/challenge/classify.js";
import type { ChallengeDetection } from "../../core/challenge/classify.js";
import { CHALLENGE_PRECEDENCE } from "../../core/challenge/classify.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import { captureDomSnapshot } from "../profile.capture/snapshot.js";
import type { DomSnapshotResult } from "../profile.capture/snapshot.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import {
  FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS,
} from "../profile.capture/constants.js";
import type { EndpointRow } from "../profile.capture/patterns.js";
import {
  BROAD_PATTERN_NAME, JOB_PATTERNS, isJobIsh, jobDocumentPattern, jobMarkerCounts,
  summarizeJobCaptures,
} from "./patterns.js";
import { normalizeJobUrl } from "./url.js";
import { checkJobIdentity } from "./identity.js";
import { descriptionVerdict, measureExpander } from "./probe.js";
import type { ExpanderProbe } from "./probe.js";
import { EXPANDER_TIMEOUT_MS, isJobPageRendered } from "./constants.js";

/** How many endpoint rows reach the receipt. Bounded for §4.1's reason: stdout
 *  is an envelope, and the full table is in the archive's sidecars. */
export const RECEIPT_ENDPOINT_CAP = 40;

const args = z
  .object({
    /** A `/jobs/view/<id>` url, a listing url carrying `currentJobId`, a bare
     *  numeric posting id, or `urn:li:fsd_jobPosting:<id>`. */
    url: z.string().min(1),
    /** Scroll passes. Omitted: a randomized 3–6. `0` captures above the fold only. */
    scrolls: z.coerce.number().int().min(0).max(12).optional(),
    captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
    layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
  })
  .strict();

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
  });
}

function worstOf(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((worst, d) =>
    CHALLENGE_PRECEDENCE.indexOf(d.kind) < CHALLENGE_PRECEDENCE.indexOf(worst.kind) ? d : worst,
  );
}

/**
 * `job.capture` — open one job posting, archive everything the page fetches,
 * and measure where `job.get`'s fields live.
 *
 * This is Task 30's instrument. It is the job surface's counterpart to
 * `profile.capture`: one real page load, every response body kept raw (D2), a
 * DOM snapshot archived alongside them, and a receipt that reports what the page
 * actually asked for. **It parses no job field and stores nothing** — a probe's
 * deliverable is the measurement, and a parser written from the same commit as
 * its own evidence is exactly what D152 forbids.
 *
 * What it adds over the profile probe is the description measurement. §7's
 * `jobs.description` is the field `company.jobs` cannot fill from a list card,
 * and whether the detail page's "see more" is a CSS toggle or a fetch decides
 * whether Task 31 can have it passively. That is measured without clicking
 * anything — see `probe.ts`.
 *
 * Every safety rail is `profile.capture`'s, unchanged and for the same reasons:
 * preflight, budget checked then spent before navigation, challenge gates after
 * navigation and before declaring success, human pacing, a randomized dwell, and
 * a `finally` that drains the tap so a throw halfway through still leaves the
 * archive with what was seen.
 */
export const capability = defineCapability({
  name: "job.capture",
  risk: "read-cheap",
  summary: "Open one LinkedIn job posting and archive every response it fetches, raw, with a DOM snapshot.",
  args,
  needsBrowser: true,
  // One page load and no `profile_open`: a posting is not a profile view, and
  // §8's spend kinds are a closed set (D262). The daily blast-radius guard is
  // the capability's own sub-cap, which it has by fallback (D162).
  cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
  run: async ({ run, args: a, browser, budget }) => {
    const { tab, tap, cursor, archive } = browser;

    // Before anything is opened or spent. A typo costs nothing.
    const target = normalizeJobUrl(a.url);
    const warnings: Warning[] = [];

    await budget.check({ kind: "page_load", n: 1 });

    const patterns = [...JOB_PATTERNS, jobDocumentPattern(target.url)];
    for (const pattern of patterns) tap.watch(pattern);
    const since = tap.cursor;

    // Spent before the navigation: a crash mid-load must leave the ledger
    // over-counting, never under-counting (§8).
    await budget.spend({ kind: "page_load", n: 1 });

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
    let expander: ExpanderProbe | null = null;
    try {
      checkpointState.phase = "post-navigation-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });

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

      // The snapshot goes first, before the measurement that describes it:
      // raw-first is not conditional (D2), and evidence on disk outranks a
      // measurement about it. The verdict below therefore describes the page at
      // or just after the archived instant, which a reviewer can re-check
      // offline against the snapshot itself.
      checkpointState.phase = "snapshot";
      snapshot = await captureDomSnapshot({
        tab, archive, targetUrl: target.url, timeoutMs: SNAPSHOT_TIMEOUT_MS,
      });
      run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
        phase: "capture",
        item_ref: target.ref,
        ...(snapshot.archived === null ? { level: "warn" as const } : {}),
        detail: {
          kind: "dom-snapshot",
          file: snapshot.archived?.file ?? null,
          bytes: snapshot.archived?.bytes ?? 0,
          container: snapshot.probe?.container ?? null,
          failure: snapshot.failure,
        },
      });

      checkpointState.phase = "measure-description";
      expander = await measureExpander(tab, EXPANDER_TIMEOUT_MS);

      checkpointState.phase = "pre-success-gate";
      await assertNoChallenge({ tab, run, state: checkpointState });
    } finally {
      // Every body already on the wire is archived before this returns, on the
      // throwing paths too — the whole value of a spent page load is what it
      // left on disk (D2).
      await tap.drain();
    }

    const summary = summarizeJobCaptures(tap.captures(), tap.misses(), patterns);

    // The status gate, over what the page fetched rather than over the page
    // itself (D61).
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
          `nothing on the page ever measured taller than the viewport within the layout ` +
          `window (${reading.layout.waitedMs}ms, ${reading.layout.polls} polls) — neither the ` +
          `document nor any inner scroller (D115); lazily-loaded sections will not have fetched`,
      });
    }

    // The snapshot's three distinct outcomes, one code each: the page would not
    // answer, the archive would not take the answer, or the page answered with
    // a shell.
    if (snapshot === null || snapshot.failure === "probe-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_FAILED",
        n: 1,
        field:
          `the rendered-DOM snapshot could not be read from the page, so this run has no ` +
          `content fixture: ${snapshot?.detail ?? "the read was never reached"}`,
      });
    } else if (snapshot.failure === "archive-failed") {
      warnings.push({
        code: "DOM_SNAPSHOT_NOT_ARCHIVED",
        n: 1,
        field:
          `the snapshot was read from the page but could not be written to the raw archive, ` +
          `so nothing may parse it (D2): ${snapshot.detail ?? "unknown"}`,
      });
    } else if (snapshot.probe !== null && !isJobPageRendered(snapshot.probe.container)) {
      warnings.push({
        code: "JOB_CONTAINER_NOT_RENDERED",
        n: 1,
        field:
          `the snapshot is archived but the posting's main container carries only ` +
          `${snapshot.probe.container.textChars} chars of text ` +
          `(selector ${snapshot.probe.container.selector ?? "not found"}) — ` +
          `do not build a field map from this snapshot`,
      });
    }

    // Identity. `sessionUrnsOf` is the one implementation of "these urns are the
    // operator's own" and is never re-derived here (D119, D126).
    const sessionUrns = sessionUrnsOf(tap.captures());
    const identity = checkJobIdentity({
      captures: tap.captures(),
      target,
      snapshotHtml: snapshot?.probe?.html ?? null,
      sessionUrns,
    });

    if (identity.subjectBodies === 0 && !identity.subjectInSnapshot) {
      // The capture is of some other page. Loud, because promoting it would
      // file a stranger's posting under the id the operator asked for.
      warnings.push({
        code: "JOB_SUBJECT_NOT_SERVED",
        n: 1,
        field:
          `no captured body and no DOM snapshot names posting ${target.id} — this run did not ` +
          `capture the job that was requested, and nothing from it may be promoted as that job`,
      });
    }
    if (identity.sessionUrns === 0) {
      // Without the session's own urns the "is this the operator" check has
      // nothing to compare against, so its `false` answers prove nothing.
      warnings.push({
        code: "SESSION_IDENTITY_UNKNOWN",
        n: 1,
        field:
          `no /voyager/api/me body was captured, so the session's own urns are unknown and ` +
          `the identity checks on this run could not actually run (D119)`,
      });
    }
    if (!identity.companyResolved) {
      warnings.push({
        code: "COMPANY_URN_UNRESOLVED",
        n: identity.companyCandidates,
        field:
          `${identity.companyCandidates} distinct company urns appear in the bodies naming this ` +
          `posting, so the hiring company cannot be resolved by agreement — Task 31 must address ` +
          `it by a path from the field map, never by a sweep`,
      });
    }

    const verdict = descriptionVerdict(expander);
    if (expander === null) {
      warnings.push({
        code: "DESCRIPTION_NOT_MEASURED",
        n: 1,
        field:
          "the description-truncation measurement did not run, so this probe cannot say whether " +
          "the full description is in the snapshot or behind a fetch",
      });
    } else if (verdict === "unknown") {
      warnings.push({
        code: "DESCRIPTION_SOURCE_UNKNOWN",
        n: 1,
        field:
          `the measurement was inconclusive (${expander.seeMoreControls} see-more controls, ` +
          `${expander.clampedBlocks} clamped blocks, walk truncated: ${expander.truncated}) — ` +
          "do not read this as 'no fetch'",
      });
    }

    if (summary.profile_ish === 0) {
      warnings.push({
        code: "NO_JOB_PAYLOAD",
        n: 1,
        field: `${summary.captured} linkedin api responses archived, none carrying job-posting data`,
      });
    }
    if (summary.unmatched_profile_ish > 0) {
      warnings.push({
        code: "PATTERN_MISMATCH",
        n: summary.unmatched_profile_ish,
        field: "job payloads arrived on endpoints no specific pattern matched — see data.capture.endpoints",
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
        "JOB_NO_CAPTURE",
        "the job page loaded but no LinkedIn api response was archived",
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
              // The job surface's own scroller measurement. Never assumed to be
              // the profile's `main#workspace` (D115) — measured here.
              viewport: reading.viewport,
              layout: reading.layout,
            }
          : null,
        snapshot: {
          archived: snapshot?.archived?.file ?? null,
          bytes: snapshot?.archived?.bytes ?? 0,
          rendered: snapshot?.probe === null || snapshot?.probe === undefined
            ? false
            : isJobPageRendered(snapshot.probe.container),
          failure: snapshot?.failure ?? null,
          container: snapshot?.probe?.container ?? null,
          html_chars: snapshot?.probe?.htmlChars ?? 0,
          page_text_chars: snapshot?.probe?.textChars ?? 0,
        },
        description: {
          verdict,
          see_more_controls: expander?.seeMoreControls ?? null,
          clamped_blocks: expander?.clampedBlocks ?? null,
          // Sizes and geometry, never the text itself.
          largest_block: expander?.largest ?? null,
          elements_walked: expander?.elementsWalked ?? null,
          walk_truncated: expander?.truncated ?? null,
        },
        identity,
        capture: {
          patterns: summary.patterns,
          captured: summary.captured,
          job_ish: summary.profile_ish,
          unmatched_job_ish: summary.unmatched_profile_ish,
          misses: summary.misses,
          markers: jobMarkerCounts(tap.captures().filter((c) => isJobIsh(c.body)).map((c) => c.body)),
          endpoints: shown,
          endpoints_omitted: summary.endpoints.length - shown.length,
        },
        tap: tap.stats(),
        artifacts: run.artifacts(),
      },
      next:
        `npm run fixtures:promote -- --run=${run.runId} --capability=job.get` +
        `   # then read fixtures/job.get/FIELD-MAP.md`,
    };
  },
});

/** Which endpoint rows are worth stdout: the ones carrying job data and the ones
 *  nothing predicted — together, the whole pattern-vs-reality answer. */
function receiptEndpoints(rows: EndpointRow[]): EndpointRow[] {
  return rows.filter((r) => r.profile_ish || r.unpredicted).slice(0, RECEIPT_ENDPOINT_CAP);
}

export default capability;
