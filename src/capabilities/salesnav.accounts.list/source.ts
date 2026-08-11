import { createHash } from "node:crypto";
import type { BrowserBundle } from "../../cli/types.js";
import { classifyResponse, CHALLENGE_PRECEDENCE, type ChallengeDetection } from "../../core/challenge/classify.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import type { PageLoad, PageRequest, PagedSource } from "../../core/paged/types.js";
import type { RunContext } from "../../core/run/context.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import type { Capture } from "../../core/tap/network-tap.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN } from "../profile.capture/constants.js";
import { readLikeAHuman } from "../profile.capture/read.js";
import { clickPagerControl, type ClickReport } from "../salesnav.probe/pager.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import { findSearchParam, normalizeSalesNavUrl, type SalesNavTarget } from "../salesnav.probe/url.js";
import { parseSalesNavAccounts, type SalesNavAccountsParseResult } from "./parse.js";

export const ACCOUNT_SEARCH_PATTERN = "salesapi-account-search";
export const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;
export const DEFAULT_LAYOUT_TIMEOUT_MS = 60_000;

export type AccountsCursor = {
  kind: "salesnav-accounts/v1";
  session_id: string;
  page: number;
  start: number;
  count: number;
  arrival: "navigate" | "click";
  click?: { control: string | null; reveal_passes: number };
};

export type AccountsPageData = {
  parsed: SalesNavAccountsParseResult;
  warnings: Warning[];
  click: ClickReport | null;
};

export type AccountsSourceOptions = {
  browser: BrowserBundle;
  run: Pick<RunContext, "runId" | "log" | "checkpoint" | "lastCheckpoint">;
  target: SalesNavTarget;
  captureTimeoutMs?: number;
  layoutTimeoutMs?: number;
  scrolls?: number;
  sessionUrns: () => readonly string[];
};

export type AccountsSourceRuntime = {
  gate(options: Parameters<typeof assertNoChallenge>[0]): ReturnType<typeof assertNoChallenge>;
  read(options: Parameters<typeof readLikeAHuman>[0]): ReturnType<typeof readLikeAHuman>;
  click(options: Parameters<typeof clickPagerControl>[0]): ReturnType<typeof clickPagerControl>;
};

const runtimeDefaults: AccountsSourceRuntime = {
  gate: assertNoChallenge,
  read: readLikeAHuman,
  click: clickPagerControl,
};

function refusal(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function drift(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  });
}

function cursorOf(value: unknown): AccountsCursor | null {
  if (value === null || typeof value !== "object") return null;
  const row = value as Partial<AccountsCursor>;
  if (row.kind !== "salesnav-accounts/v1" || typeof row.session_id !== "string" || row.session_id === "") return null;
  if (!Number.isInteger(row.page) || !Number.isInteger(row.start) || !Number.isInteger(row.count)) return null;
  return row as AccountsCursor;
}

function fingerprint(rows: SalesNavAccountsParseResult["rows"]): string {
  return createHash("sha256").update(rows.map((row) => row.company_urn).join("\n")).digest("hex");
}

export const accountsFingerprint = fingerprint;

function challengeState(run: AccountsSourceOptions["run"], page: number, stage: string): Record<string, unknown> {
  const existing = run.lastCheckpoint<unknown>();
  const base = existing !== null && typeof existing === "object" && !Array.isArray(existing)
    ? existing as Record<string, unknown>
    : {};
  return { ...base, salesnav_accounts: { page, stage } };
}

function ordinaryWarnings(parsed: SalesNavAccountsParseResult): Warning[] {
  return parsed.warnings.map(({ code, field, n }) => ({ code, field, n }));
}

type SelectedPage = { captures: Capture[]; parsed: SalesNavAccountsParseResult };

/**
 * Resolves the named account-search response for one requested page. Multiple
 * retries are accepted only when their parsed identities agree; offset alone
 * is not enough to call two bodies the same page.
 */
export function selectAccountPage(captures: readonly Capture[], page: number, sessionUrns: readonly string[]): SelectedPage {
  const candidates = captures.filter((capture) => capture.patterns.includes(ACCOUNT_SEARCH_PATTERN));
  const decoded = candidates.map((capture) => ({ capture, parsed: parseSalesNavAccounts(capture.body, { refusedUrns: sessionUrns }) }));
  if (decoded.length > 0 && decoded.every((entry) => entry.parsed.paging === null)) {
    throw drift(
      "SALESNAV_PAGING_PARSE_DRIFT",
      "named account-search bodies no longer carry the paging fields needed to prove which page arrived",
      `requested_page=${page} named_bodies=${candidates.length}`,
    );
  }
  const parsed = decoded.filter((entry) => entry.parsed.paging?.page === page);
  if (parsed.length === 0) {
    if (page === 1 && candidates.length > 0) {
      throw drift(
        "SALESNAV_PAGE_OFFSET_UNEXPECTED",
        "the initial named account-search body did not identify itself as page 1",
        `requested_page=${page} named_bodies=${candidates.length}`,
      );
    }
    throw refusal(
      page > 1 ? "PAGE_DID_NOT_ADVANCE" : "SALESNAV_PAGE_BODY_MISSING",
      page > 1
        ? `the pager action did not produce an account-search body whose offset says page ${page}`
        : "the initial navigation produced no account-search body whose offset says page 1",
      `requested_page=${page} named_bodies=${candidates.length}`,
    );
  }
  const identities = new Set(parsed.map((entry) => fingerprint(entry.parsed.rows)));
  if (identities.size !== 1) {
    throw refusal(
      "SALESNAV_PAGE_AMBIGUOUS",
      "more than one account-search body claimed the requested page and their row identities disagreed",
      `requested_page=${page} bodies=${parsed.length}`,
    );
  }
  return { captures: parsed.map((entry) => entry.capture), parsed: parsed.at(-1)!.parsed };
}

function worst(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((a, b) =>
    CHALLENGE_PRECEDENCE.indexOf(a.kind) <= CHALLENGE_PRECEDENCE.indexOf(b.kind) ? a : b);
}

async function responseWarnings(
  captures: readonly Capture[],
  o: Pick<AccountsSourceOptions, "browser" | "run">,
  page: number,
): Promise<Warning[]> {
  const detections = captures.map((capture) => classifyResponse({ status: capture.status, url: capture.url }))
    .filter((verdict): verdict is ChallengeDetection => !verdict.clean);
  const halting = detections.filter((detection) => detection.kind !== "unrecognized");
  if (halting.length > 0) {
    throw await recordChallenge({
      detection: worst(halting),
      tab: o.browser.tab,
      run: o.run,
      state: challengeState(o.run, page, "response-status-gate"),
    });
  }
  return detections.length === 0 ? [] : [{
    code: "RESPONSE_STATUS_UNRECOGNIZED",
    n: detections.length,
    field: detections.map((detection) => detection.detail).join("; "),
  }];
}

function sessionIdOf(url: string): string | null {
  return findSearchParam(url, "sessionId");
}

/** The live tap-driven source consumed by `runPaged`; it owns no spend or checkpoint. */
export function createAccountsSource(o: AccountsSourceOptions, runtime: AccountsSourceRuntime = runtimeDefaults): PagedSource {
  const { tab, tap, cursor } = o.browser;
  for (const pattern of SALESNAV_PATTERNS) tap.watch(pattern);

  return {
    loadPage: async (request: PageRequest): Promise<PageLoad> => {
      const previous = request.page === 1 ? null : cursorOf(request.cursor);
      if (request.page > 1 && (previous === null || previous.page !== request.page - 1)) {
        throw refusal(
          "SALESNAV_CURSOR_INVALID",
          "the prior page checkpoint does not carry a readable Sales Navigator cursor",
          `requested_page=${request.page}`,
        );
      }

      const foreground = await tab.ensureForeground();
      if (!foreground.ok) {
        throw refusal("TAB_NOT_FOREGROUND", "the Sales Navigator tab could not be kept foreground for a page turn");
      }

      const since = tap.cursor;
      let click: ClickReport | null = null;
      if (request.page === 1) {
        await tab.navigate(o.target.url);
      } else {
        const currentUrl = await tab.currentUrl();
        let current;
        try { current = normalizeSalesNavUrl(currentUrl); } catch { current = null; }
        const currentSession = sessionIdOf(currentUrl);
        if (current === null || current.vertical !== "company" || currentSession !== previous!.session_id) {
          throw refusal(
            "SALESNAV_SESSION_CHANGED",
            "the tab no longer carries the result-set session from the prior proved page; resuming it would join two searches",
            `requested_page=${request.page}`,
          );
        }
        if (current.page !== null && current.page !== previous!.page) {
          throw refusal(
            "SALESNAV_PAGER_POSITION_CHANGED",
            "the tab is not resting on the prior proved page, so Next would not have a resolved destination",
            `expected_page=${previous!.page} actual_page=${current.page}`,
          );
        }
        click = await runtime.click({ tab, cursor, direction: "next" });
        o.run.log("nav.done", {
          phase: `page-${request.page}`,
          detail: { arrival: "click", control: click.control, reveal_passes: click.revealPasses },
        });
      }

      await runtime.gate({
        tab,
        run: o.run,
        state: challengeState(o.run, request.page, "post-navigation-gate"),
      });
      await tap.waitFor(ACCOUNT_SEARCH_PATTERN, {
        since,
        timeoutMs: o.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS,
      });
      const reading = await runtime.read({
        tab,
        cursor,
        ...(o.scrolls === undefined ? {} : { passes: o.scrolls }),
        layoutTimeoutMs: o.layoutTimeoutMs ?? DEFAULT_LAYOUT_TIMEOUT_MS,
      });
      o.run.log("render.wait", {
        phase: `page-${request.page}`,
        detail: { layout_settled: reading.layout.settled, passes: reading.passes, scrolled: reading.scrolled },
      });
      await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);
      await runtime.gate({
        tab,
        run: o.run,
        state: challengeState(o.run, request.page, "pre-parse-gate"),
      });
      await tap.drain();

      const mine = tap.captures().filter((capture) => capture.seq >= since);
      const selected = selectAccountPage(mine, request.page, o.sessionUrns());
      const paging = selected.parsed.paging!;
      if (previous !== null && paging.start <= previous.start) {
        throw refusal(
          "PAGE_DID_NOT_ADVANCE",
          `the account-search body offset did not advance from page ${previous.page} to page ${request.page}`,
          `previous_start=${previous.start} arrived_start=${paging.start}`,
        );
      }

      const landedUrl = await tab.currentUrl();
      const sessionId = sessionIdOf(landedUrl) ?? selected.captures.map((capture) => sessionIdOf(capture.url)).find((id) => id !== null) ?? null;
      if (sessionId === null) {
        throw refusal("SALESNAV_SESSION_ID_UNAVAILABLE", "the arrived page carried no Sales Navigator session id, so its result set cannot be pinned");
      }
      const expectedSession = previous?.session_id ?? o.target.sessionId;
      if (expectedSession !== null && expectedSession !== sessionId) {
        throw refusal(
          "SALESNAV_SESSION_CHANGED",
          "the arrived page belongs to a different Sales Navigator result-set session",
          `requested_page=${request.page}`,
        );
      }

      const warnings = [
        ...(await responseWarnings(mine, o, request.page)),
        ...ordinaryWarnings(selected.parsed),
      ];
      for (const warning of warnings) {
        o.run.log("parse.miss", { level: "warn", phase: `page-${request.page}`, detail: warning });
      }
      o.run.log("parse.ok", {
        phase: `page-${request.page}`,
        detail: { page: request.page, inspected: selected.parsed.inspected, usable: selected.parsed.rows.length, refused: selected.parsed.refused },
      });

      const next: AccountsCursor = {
        kind: "salesnav-accounts/v1",
        session_id: sessionId,
        page: request.page,
        start: paging.start,
        count: paging.count,
        arrival: request.page === 1 ? "navigate" : "click",
        ...(click === null ? {} : { click: { control: click.control, reveal_passes: click.revealPasses } }),
      };
      return {
        archived: selected.captures.map((capture) => capture.archived),
        items: selected.parsed.rows.length,
        hasMore: paging.start + paging.count < paging.total,
        cursor: next,
        fingerprint: fingerprint(selected.parsed.rows),
        data: { parsed: selected.parsed, warnings, click } satisfies AccountsPageData,
      };
    },
  };
}
