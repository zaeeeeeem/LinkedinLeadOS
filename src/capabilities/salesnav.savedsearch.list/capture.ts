import type { CapabilityContext } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import {
  classifyResponse, CHALLENGE_PRECEDENCE, type ChallengeDetection,
} from "../../core/challenge/classify.js";
import { waitForAny } from "../../core/tap/ready.js";
import { captureDomSnapshot, type DomSnapshotResult } from "../profile.capture/snapshot.js";
import { summarizeCaptures, type CaptureSummary } from "../profile.capture/patterns.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN } from "../profile.capture/constants.js";
import { clickTrustedControl, type TrustedClickReport } from "../salesnav.probe/pager.js";
import { BROAD_PATTERN_NAME } from "../salesnav.probe/patterns.js";
import { SAVED_SEARCHES_CONTROL } from "./control.js";
import {
  SALESNAV_HOME_URL, SAVED_SEARCHES_CAPTURE_TIMEOUT_MS, SAVED_SEARCHES_CONTROL_TIMEOUT_MS,
  SAVED_SEARCHES_DOCUMENT_PATTERN, SAVED_SEARCHES_SNAPSHOT_TIMEOUT_MS,
} from "./constants.js";
import { isSavedSearchIsh, SAVED_SEARCHES_PATTERNS } from "./patterns.js";

export type SavedSearchCaptureArgs = {
  captureTimeoutMs?: number;
};

export type SavedSearchPayloadRef = { file: string; bytes: number; patterns: string[] };

export type SavedSearchCaptureResult = {
  payloads: SavedSearchPayloadRef[];
  snapshot: DomSnapshotResult | null;
  summary: CaptureSummary;
  click: TrustedClickReport;
  warnings: Warning[];
  foreground: { ok: boolean; via: string | null };
};

export type SavedSearchCaptureDeps = {
  gate: typeof assertNoChallenge;
  wait: typeof waitForAny;
  snapshot: typeof captureDomSnapshot;
  click: typeof clickTrustedControl;
};

const defaultDeps: SavedSearchCaptureDeps = {
  gate: assertNoChallenge,
  wait: waitForAny,
  snapshot: captureDomSnapshot,
  click: clickTrustedControl,
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function worstOf(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((worst, current) =>
    CHALLENGE_PRECEDENCE.indexOf(current.kind) < CHALLENGE_PRECEDENCE.indexOf(worst.kind)
      ? current
      : worst,
  );
}

/**
 * Probe-first capture for Task 37. One paid navigation reaches `/sales/`; the
 * granted D408 click opens an overlay on that page and passively captures the
 * request the UI issues. It parses no saved-search field.
 */
export async function captureSavedSearches(
  ctx: CapabilityContext<SavedSearchCaptureArgs, true>,
  deps: SavedSearchCaptureDeps = defaultDeps,
): Promise<SavedSearchCaptureResult> {
  const { run, args, browser, budget } = ctx;
  const { tab, tap, cursor, archive } = browser;
  const warnings: Warning[] = [];

  await budget.check({ kind: "page_load", n: 1 });
  const releases = SAVED_SEARCHES_PATTERNS.map((pattern) => tap.watch(pattern));
  let foreground: Awaited<ReturnType<typeof tab.ensureForeground>> | null = null;
  let snapshot: DomSnapshotResult | null = null;
  let click: TrustedClickReport | null = null;
  const checkpoint = { target: { kind: "saved-searches" }, phase: "navigate" as string };
  let panelSince = tap.cursor;

  try {
    foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "savedsearch.capture",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });
    if (!foreground.ok) warnings.push({
      code: "TAB_NOT_FOREGROUND", n: 1,
      field: "the worker tab still reports itself hidden; the Saved searches panel may not render",
    });

    await budget.spend({ kind: "page_load", n: 1 });
    run.log("nav.start", { phase: "savedsearch.capture", item_ref: "salesnav:home" });
    const started = Date.now();
    await tab.navigate(SALESNAV_HOME_URL);
    run.log("nav.done", {
      phase: "savedsearch.capture", item_ref: "salesnav:home", duration_ms: Date.now() - started,
    });

    checkpoint.phase = "post-navigation-gate";
    await deps.gate({ tab, run, state: checkpoint });
    checkpoint.phase = "await-home";
    await deps.wait(tap, [SAVED_SEARCHES_DOCUMENT_PATTERN, BROAD_PATTERN_NAME], {
      timeoutMs: args.captureTimeoutMs ?? SAVED_SEARCHES_CAPTURE_TIMEOUT_MS,
    });
    await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

    // D408/D409: exact measured selector, anchored accessible name, one match,
    // trusted HumanCursor click, wheel reveal and hit-test refusal.
    panelSince = tap.cursor;
    checkpoint.phase = "click-saved-searches";
    click = await deps.click({
      tab, cursor, spec: SAVED_SEARCHES_CONTROL, timeoutMs: SAVED_SEARCHES_CONTROL_TIMEOUT_MS,
    });
    run.log("nav.done", {
      phase: "savedsearch.click",
      item_ref: "salesnav:saved-searches",
      detail: {
        click: click.kind, control: click.control, tag: click.tag,
        reveal_passes: click.revealPasses,
      },
    });

    checkpoint.phase = "await-panel-response";
    try {
      await deps.wait(tap, ["salesapi-saved-searches", BROAD_PATTERN_NAME], {
        since: panelSince,
        timeoutMs: args.captureTimeoutMs ?? SAVED_SEARCHES_CAPTURE_TIMEOUT_MS,
      });
    } catch (cause) {
      if (!(cause instanceof CapabilityError) || cause.code !== "CAPTURE_TIMEOUT") throw cause;
      warnings.push({
        code: "SAVED_SEARCHES_NO_RESPONSE", n: 1,
        field: "the measured control opened but no watched LinkedIn response arrived inside the capture window",
      });
    }
    await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

    checkpoint.phase = "snapshot";
    snapshot = await deps.snapshot({
      tab, archive, targetUrl: SALESNAV_HOME_URL, timeoutMs: SAVED_SEARCHES_SNAPSHOT_TIMEOUT_MS,
    });
    run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
      phase: "savedsearch.capture",
      item_ref: "salesnav:saved-searches",
      ...(snapshot.archived === null ? { level: "warn" as const } : {}),
      detail: {
        kind: "dom-snapshot", file: snapshot.archived?.file ?? null,
        bytes: snapshot.archived?.bytes ?? 0, rendered: snapshot.rendered,
        failure: snapshot.failure,
      },
    });
    checkpoint.phase = "pre-success-gate";
    await deps.gate({ tab, run, state: checkpoint });
  } finally {
    await tap.drain();
    for (const release of releases) release();
  }

  if (click === null) throw transient(
    "SAVED_SEARCHES_CLICK_NOT_RECORDED",
    "the Saved searches control was not recorded as clicked",
    `run=${run.runId}`,
  );

  const captures = tap.captures().filter((capture) => capture.seq >= panelSince);
  const misses = tap.misses();
  const detections = captures
    .map((capture) => classifyResponse({ status: capture.status, url: capture.url }))
    .filter((detection) => !detection.clean);
  const halting = detections.filter((detection) => detection.kind !== "unrecognized");
  if (halting.length > 0) {
    throw await recordChallenge({
      detection: worstOf(halting), tab, run,
      state: { ...checkpoint, phase: "response-status-gate" },
    });
  }
  if (detections.length > 0) warnings.push({
    code: "RESPONSE_STATUS_UNRECOGNIZED", n: detections.length,
    field: "one or more Saved searches subresources returned an unrecognized status",
  });
  if (snapshot?.archived == null) warnings.push({
    code: "DOM_SNAPSHOT_NOT_ARCHIVED", n: 1,
    field: "the open Saved searches panel has no archived DOM corroboration",
  });

  const summary = summarizeCaptures(captures, misses, SAVED_SEARCHES_PATTERNS, {
    isRelevant: isSavedSearchIsh,
  });
  if (summary.misses > 0) warnings.push({
    code: "CAPTURE_MISSES", n: summary.misses,
    field: "watched Saved searches responses were seen but not delivered",
  });
  if (summary.captured === 0) throw transient(
    "SAVED_SEARCHES_NO_CAPTURE",
    "the Saved searches control opened but no LinkedIn response was archived",
    `run=${run.runId}`,
  );
  if (summary.profile_ish === 0) warnings.push({
    code: "NO_SAVED_SEARCH_PAYLOAD", n: 1,
    field: `${summary.captured} responses after the click were archived and none carried a saved-search marker`,
  });

  const payloads = captures
    .filter((capture) => isSavedSearchIsh(capture.body))
    .map((capture) => ({
      file: capture.archived.file, bytes: capture.bytes, patterns: [...capture.patterns],
    }));
  return {
    payloads, snapshot, summary, click, warnings,
    foreground: { ok: foreground?.ok ?? false, via: foreground?.via ?? null },
  };
}
