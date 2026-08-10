import type { CapabilityContext } from "../../cli/types.js";
import type { Warning } from "../../core/run/receipt.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { classifyResponse, CHALLENGE_PRECEDENCE, type ChallengeDetection } from "../../core/challenge/classify.js";
import { waitForAny } from "../../core/tap/ready.js";
import { captureDomSnapshot, type DomSnapshotResult } from "../profile.capture/snapshot.js";
import { readLikeAHuman, type ReadResult } from "../profile.capture/read.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { summarizeCaptures, type CaptureSummary, type TieredPattern } from "../profile.capture/patterns.js";
import {
  FIRST_CAPTURE_TIMEOUT_MS, SETTLE_MS_MAX, SETTLE_MS_MIN, SNAPSHOT_TIMEOUT_MS,
} from "../profile.capture/constants.js";
import {
  carriesInboxPayload, inboxDocumentPattern, INBOX_DOCUMENT_NAME, INBOX_PATTERNS,
} from "./patterns.js";

export type InboxPayloadRef = { file: string; bytes: number };

export type InboxCaptureResult = {
  payloads: InboxPayloadRef[];
  snapshot: DomSnapshotResult | null;
  reading: ReadResult | null;
  summary: CaptureSummary;
  sessionUrns: string[];
  warnings: Warning[];
  foreground: { ok: boolean; via: string | null };
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
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
 * One read-only, metered messaging navigation. It performs no click, send,
 * reaction, archive or mark action. Navigating a thread can still mark it read;
 * that accepted LinkedIn side effect is reported by inbox.thread.
 */
export async function captureInbox(
  ctx: CapabilityContext<{ captureTimeoutMs?: number; layoutTimeoutMs?: number }, true>,
  options: { url: string; passes: number; itemRef: "list" | "thread" },
): Promise<InboxCaptureResult> {
  const { run, args, browser, budget } = ctx;
  const { tab, tap, cursor, archive } = browser;
  const warnings: Warning[] = [];

  await budget.check({ kind: "page_load", n: 1 });
  const documentWatch = inboxDocumentPattern();
  const patterns: TieredPattern[] = [...INBOX_PATTERNS, {
    ...documentWatch,
    match: (url: string) => {
      try {
        const expected = new URL(options.url);
        const actual = new URL(url);
        return actual.hostname.endsWith("linkedin.com") && actual.pathname === expected.pathname;
      } catch { return false; }
    },
  }];
  await budget.spend({ kind: "page_load", n: 1 });
  const releaseWatches: Array<() => void> = [];
  let since = tap.cursor;
  let foreground: Awaited<ReturnType<typeof tab.ensureForeground>> | null = null;
  const checkpoint = { target: { kind: options.itemRef }, phase: "navigate" as string };
  let reading: ReadResult | null = null;
  let snapshot: DomSnapshotResult | null = null;
  try {
    for (const pattern of patterns) releaseWatches.push(tap.watch(pattern));
    since = tap.cursor;
    foreground = await tab.ensureForeground();
    run.log("render.wait", {
      phase: "capture",
      detail: { via: foreground.via, hidden: foreground.state?.hidden ?? null },
    });
    if (!foreground.ok) warnings.push({
      code: "TAB_NOT_FOREGROUND", n: 1,
      field: "the worker tab still reports itself hidden; messaging rows may not have loaded",
    });

    run.log("nav.start", { phase: "capture", item_ref: options.itemRef });
    const started = Date.now();
    await tab.navigate(options.url);
    run.log("nav.done", { phase: "capture", item_ref: options.itemRef, duration_ms: Date.now() - started });

    checkpoint.phase = "post-navigation-gate";
    await assertNoChallenge({ tab, run, state: checkpoint });
    checkpoint.phase = "await-first-capture";
    await waitForAny(tap, ["linkedin-api", INBOX_DOCUMENT_NAME], {
      since,
      timeoutMs: args.captureTimeoutMs ?? FIRST_CAPTURE_TIMEOUT_MS,
    });

    checkpoint.phase = "read";
    reading = await readLikeAHuman({
      tab,
      cursor,
      passes: options.passes,
      ...(args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: args.layoutTimeoutMs }),
    });
    run.log("render.wait", {
      phase: "capture",
      detail: {
        layout_settled: reading.layout.settled,
        layout_waited_ms: reading.layout.waitedMs,
        passes: reading.passes,
        notches: reading.notches,
        scroller: reading.viewport?.scroller ?? null,
        scroller_candidates: reading.viewport?.scrollerCandidates ?? null,
      },
    });
    await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

    checkpoint.phase = "snapshot";
    snapshot = await captureDomSnapshot({
      tab, archive, targetUrl: options.url, timeoutMs: SNAPSHOT_TIMEOUT_MS,
    });
    run.log(snapshot.archived === null ? "capture.miss" : "capture.hit", {
      phase: "capture",
      item_ref: options.itemRef,
      ...(snapshot.archived === null ? { level: "warn" as const } : {}),
      detail: {
        kind: "dom-snapshot",
        file: snapshot.archived?.file ?? null,
        bytes: snapshot.archived?.bytes ?? 0,
        rendered: snapshot.rendered,
        failure: snapshot.failure,
      },
    });
    checkpoint.phase = "pre-success-gate";
    await assertNoChallenge({ tab, run, state: checkpoint });
  } finally {
    await tap.drain();
    for (const release of releaseWatches) release();
  }

  const captures = tap.captures();
  const summary = summarizeCaptures(captures, tap.misses(), patterns, {
    isRelevant: carriesInboxPayload,
  });
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
    field: "one or more messaging subresources returned an unrecognized status",
  });
  if (reading !== null && !reading.layout.settled) warnings.push({
    code: "PAGE_NOT_LAID_OUT", n: 1,
    field: `the messaging scroller did not settle after ${reading.layout.polls} measurements`,
  });
  if (snapshot?.archived == null) warnings.push({
    code: "DOM_SNAPSHOT_NOT_ARCHIVED", n: 1,
    field: "the messaging DOM snapshot was not archived; the labeled network body remains usable",
  });
  if (summary.profile_ish === 0) warnings.push({
    code: "NO_INBOX_PAYLOAD", n: 1,
    field: `${summary.captured} responses were archived and none was a labeled inbox payload`,
  });
  if (summary.unmatched_profile_ish > 0) warnings.push({
    code: "PATTERN_MISMATCH", n: summary.unmatched_profile_ish,
    field: "inbox payloads arrived on endpoints no specific pattern matched",
  });
  if (summary.misses > 0) warnings.push({
    code: "CAPTURE_MISSES", n: summary.misses,
    field: "watched messaging responses were seen but not delivered",
  });
  if (summary.captured === 0) throw transient(
    "INBOX_NO_CAPTURE",
    "the messaging page loaded but no LinkedIn response was archived",
    `run=${run.runId}`,
  );

  const sessionUrns = sessionUrnsOf(captures);
  if (sessionUrns.length === 0) warnings.push({
    code: "SESSION_IDENTITY_UNAVAILABLE", n: 1,
    field: "the session identity could not be resolved, so sender direction remains unknown",
  });
  const payloads = captures
    .filter((capture) => carriesInboxPayload(capture.body, capture.url))
    .map((capture) => ({ file: capture.archived.file, bytes: capture.bytes }));

  return {
    payloads, snapshot, reading, summary, sessionUrns, warnings,
    foreground: { ok: foreground?.ok ?? false, via: foreground?.via ?? null },
  };
}
