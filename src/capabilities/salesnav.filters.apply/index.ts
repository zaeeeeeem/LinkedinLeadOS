import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import { CHALLENGE_PRECEDENCE, classifyResponse, type ChallengeDetection } from "../../core/challenge/classify.js";
import { assertNoChallenge, recordChallenge } from "../../core/challenge/detect.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import {
  FILTER_CATALOG_PROVENANCE,
  FilterBuildError,
  VocabularyError,
  buildFilterUrl,
  filterSpecSchema,
  loadPinnedFilterCatalog,
  loadVocabulary,
} from "../../core/salesnav-query/index.js";
import { getStore, insertSearch, type SearchInput, type StoreClient } from "../../core/store/index.js";
import type { Capture } from "../../core/tap/network-tap.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN } from "../profile.capture/constants.js";
import { documentPattern } from "../profile.capture/patterns.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import {
  QueryEchoError,
  applyVerdict,
  bodyDigest,
  parseApplyPaging,
  parseApplySessionId,
  queryDigest,
  requestQuery,
  verdictWarnings,
} from "./parse.js";

const CATALOG_PATTERN = "filter-apply-layout";
const DOCUMENT_PATTERN = "filter-apply-document";
const CAPTURE_TIMEOUT_MS = 60_000;

/**
 * The one place the vertical branches. Both endpoints and both routes are
 * measured in M5 archives; nothing else in this capability knows which vertical
 * it is running.
 */
const VERTICALS = {
  LEAD: { route: "people", endpoint: "/salesApiLeadSearch", pattern: "salesapi-lead-search", kind: "sn_leads" },
  ACCOUNT: { route: "company", endpoint: "/salesApiAccountSearch", pattern: "salesapi-account-search", kind: "sn_accounts" },
} as const;

const args = z.object({
  spec: z.string().min(1),
  publicVocabPath: z.string().min(1).optional(),
  privateVocabPath: z.string().min(1).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
}).strict();

export type FilterApplyDeps = {
  store(): StoreClient;
  insertSearch(input: SearchInput, client: StoreClient): Promise<{ search_id: string; rows: 1 }>;
};

const defaults: FilterApplyDeps = {
  store: getStore,
  insertSearch: (input, client) => insertSearch(input, { client }),
};

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

function refusal(cause: unknown): CapabilityError {
  if (cause instanceof CapabilityError) return cause;
  if (cause instanceof QueryEchoError) return drift(`FILTER_APPLY_${cause.code}`, cause.message);
  if (cause instanceof FilterBuildError || cause instanceof VocabularyError) {
    return new CapabilityError({
      code: cause.code,
      exit: cause.code.includes("CATALOG") || cause.code.includes("REGISTRY") || cause.code.includes("PROVENANCE")
        ? EXIT.PARSE_DRIFT
        : EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: cause.message,
    });
  }
  return new CapabilityError({
    code: "FILTER_APPLY_FAILED",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

function worst(detections: ChallengeDetection[]): ChallengeDetection {
  return detections.reduce((left, right) =>
    CHALLENGE_PRECEDENCE.indexOf(left.kind) <= CHALLENGE_PRECEDENCE.indexOf(right.kind) ? left : right);
}

function exactPath(raw: string, suffix: string): boolean {
  try {
    return new URL(raw).pathname.endsWith(suffix);
  } catch {
    return false;
  }
}

/**
 * The named search response for this navigation.
 *
 * Two distinct queries on one navigation is drift, not a choice: it would mean
 * the page searched something we did not ask for and we would have no principled
 * way to say which execution the count belongs to. When the captured query does
 * not match the built one the capture is still returned — that *is* the finding,
 * and the verdict reports it as rewritten or dropped.
 */
export function selectSearchCapture(captures: readonly Capture[], endpoint: string, expectedQuery: string): Capture {
  const named = captures.filter((capture) => exactPath(capture.url, endpoint));
  if (named.length === 0) {
    throw drift(
      "FILTER_APPLY_SEARCH_BODY_MISSING",
      `the built-url navigation issued no captured ${endpoint.slice(1)} response`,
      `captured=${captures.length}`,
    );
  }
  const distinct = new Set(named.map((capture) => queryDigest(requestQuery(capture.url))));
  if (distinct.size > 1) {
    throw drift(
      "FILTER_APPLY_REQUEST_AMBIGUOUS",
      "the navigation issued multiple distinct search queries",
      `named=${named.length} distinct_queries=${distinct.size}`,
    );
  }
  const matching = named.filter((capture) => requestQuery(capture.url) === expectedQuery);
  return (matching.at(-1) ?? named.at(-1))!;
}

export function createFilterApplyCapability(deps: FilterApplyDeps = defaults) {
  return defineCapability({
    name: "salesnav.filters.apply",
    risk: "read-metered",
    summary: "Navigate one provenance-built Sales Navigator search URL and report, from captured bodies only, which filters were honored and how large the audience is.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 1, profile_opens: 0 }),
    run: async (ctx) => {
      const { run, args: input, browser, budget } = ctx;
      const { tab, tap, cursor } = browser;
      try {
        let rawSpec: unknown;
        try {
          rawSpec = JSON.parse(input.spec);
        } catch {
          throw new Error("--spec must be valid JSON");
        }
        const parsed = filterSpecSchema.safeParse(rawSpec);
        if (!parsed.success) {
          throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
        }
        const spec = parsed.data;
        const vertical = VERTICALS[spec.vertical];
        const vocabulary = await loadVocabulary({
          ...(input.publicVocabPath === undefined ? {} : { publicPath: input.publicVocabPath }),
          ...(input.privateVocabPath === undefined ? {} : { privatePath: input.privateVocabPath }),
        });
        // The builder refuses every unproven id here, before a single budget
        // call — a bad spec must cost nothing on the scarcest budget there is.
        const built = buildFilterUrl(spec, loadPinnedFilterCatalog(), vocabulary);

        const releases = [
          ...SALESNAV_PATTERNS.map((pattern) => tap.watch(pattern)),
          tap.watch({ name: CATALOG_PATTERN, match: "salesApiSearchFilterLayout" }),
          tap.watch(documentPattern(built.url, DOCUMENT_PATTERN)),
        ];
        const warnings: Warning[] = [];
        const checkpoint = { kind: "salesnav-filter-apply/v1", stage: "preflight" };
        try {
          await budget.check({ kind: "page_load", n: 1 });
          await budget.check({ kind: "search_page", n: 1 });
          const foreground = await tab.ensureForeground();
          if (!foreground.ok) {
            throw new CapabilityError({
              code: "TAB_NOT_FOREGROUND", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
              message: "the Sales Navigator worker tab could not be kept foreground for the apply navigation",
            });
          }

          checkpoint.stage = "spend";
          run.checkpoint(checkpoint);
          await budget.spend({ kind: "page_load", n: 1 });
          await budget.spend({ kind: "search_page", n: 1 });

          const since = tap.cursor;
          checkpoint.stage = "navigate";
          run.checkpoint(checkpoint);
          run.log("nav.start", { phase: "filter-apply", detail: { vertical: spec.vertical, filters: built.filtersCount } });
          await tab.navigate(built.url);
          run.log("nav.done", { phase: "filter-apply", detail: { vertical: spec.vertical } });

          checkpoint.stage = "post-navigation-gate";
          run.checkpoint(checkpoint);
          await assertNoChallenge({ tab, run, state: checkpoint });

          checkpoint.stage = "await-search";
          run.checkpoint(checkpoint);
          await tap.waitFor(vertical.pattern, { since, timeoutMs: input.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS });
          await cursor.pause(SETTLE_MS_MIN, SETTLE_MS_MAX);

          checkpoint.stage = "pre-success-gate";
          run.checkpoint(checkpoint);
          await assertNoChallenge({ tab, run, state: checkpoint });
          await tap.drain();

          const mine = tap.captures().filter((capture) => capture.seq >= since);
          const responseDetections = mine
            .map((capture) => classifyResponse({ status: capture.status, url: capture.url }))
            .filter((result): result is ChallengeDetection => !result.clean);
          const halting = responseDetections.filter((result) => result.kind !== "unrecognized");
          if (halting.length > 0) {
            throw await recordChallenge({ detection: worst(halting), tab, run, state: checkpoint });
          }
          if (responseDetections.length > 0) {
            warnings.push({
              code: "RESPONSE_STATUS_UNRECOGNIZED",
              field: responseDetections.map((result) => result.detail).join("; "),
              n: responseDetections.length,
            });
          }

          // Only after both gates clear may request or response data be read.
          const search = selectSearchCapture(mine, vertical.endpoint, built.query);
          const capturedQuery = requestQuery(search.url);
          const paging = parseApplyPaging(search.body);
          if (paging.start !== 0) {
            throw drift(
              "FILTER_APPLY_NOT_PAGE_ONE",
              "the apply navigation's named response does not identify itself as page 1",
              `start=${paging.start} count=${paging.count}`,
            );
          }
          // The verdict compares the builder's query with the query the UI
          // actually issued. The landed url is never consulted (D413).
          const verdict = applyVerdict(built.query, capturedQuery);
          warnings.push(...verdictWarnings(verdict));
          const sessionId = parseApplySessionId(search.body);
          if (sessionId === null) {
            warnings.push({ code: "SESSION_ID_ABSENT", field: "metadata.tracking.sessionId", n: 1 });
          }

          const layouts = mine.filter((capture) => exactPath(capture.url, "/salesApiSearchFilterLayout"));
          const catalogMatches = layouts.filter((capture) => bodyDigest(capture.body) === FILTER_CATALOG_PROVENANCE.bodySha256);
          if (layouts.length === 0) {
            warnings.push({ code: "FILTER_CATALOG_NOT_CAPTURED", field: "no filter-layout body arrived on this apply load", n: 1 });
          } else if (catalogMatches.length === 0) {
            warnings.push({ code: "FILTER_CATALOG_DRIFT", field: "captured filter-layout bodies do not match the pinned catalog hash", n: layouts.length });
          }

          // Written only now: apply's row records an execution that happened,
          // with a verdict already proved against the named archive (D454).
          checkpoint.stage = "store";
          run.checkpoint(checkpoint);
          let stored: { table: string; run_ref: string; rows: number } | null = null;
          if (!ctx.flags.noStore) {
            await deps.insertSearch({
              search_id: run.runId,
              kind: vertical.kind,
              filter_url: built.url,
              filter_json: {
                vertical: spec.vertical,
                filters_count: built.filtersCount,
                verdict: {
                  audience_clean: verdict.audience_clean,
                  clean: verdict.clean,
                  exact: verdict.exact,
                  filters: verdict.filters,
                  injected_filter_types: verdict.injected_filter_types,
                  recent_search: verdict.recent_search,
                },
                paging,
                session_id: sessionId,
                evidence: { search_archive_id: search.archived.file, run_id: run.runId },
              },
            }, deps.store());
            stored = { table: "searches", run_ref: run.runId, rows: 1 };
            run.log("store.write", {
              phase: "salesnav.filters.apply",
              detail: { table: "searches", inserted: 1, search_results: 0 },
            });
          }

          checkpoint.stage = "done";
          run.checkpoint(checkpoint);
          return {
            counts: { requested: built.filtersCount, captured: mine.length, usable: verdict.honored, skipped: verdict.dropped },
            warnings,
            ...(stored === null ? {} : { stored }),
            data: {
              vertical: spec.vertical,
              filters_count: built.filtersCount,
              query: {
                exact: verdict.exact,
                built_sha256: queryDigest(built.query),
                captured_sha256: queryDigest(capturedQuery),
              },
              verdict: {
                audience_clean: verdict.audience_clean,
                clean: verdict.clean,
                honored: verdict.honored,
                rewritten: verdict.rewritten,
                dropped: verdict.dropped,
                injected: verdict.injected,
                filters: verdict.filters,
                injected_filter_types: verdict.injected_filter_types,
                recent_search: verdict.recent_search,
              },
              paging,
              session_id: sessionId,
              evidence: {
                search_archive_id: search.archived.file,
                catalog_archive_ids: layouts.map((capture) => capture.archived.file),
                catalog_hash_match: catalogMatches.length > 0,
              },
              storage: stored === null
                ? { skipped: true, reason: "--no-store" }
                : { skipped: false, table: "searches", search_id: run.runId, search_results: 0 },
              interactions: { clicks: 0, keystrokes: 0, wheel_events: 0 },
            },
            next: verdict.audience_clean
              ? `the audience LinkedIn searched matches the spec; hand this run's built url to salesnav.leads.list, or tighten the spec against paging.total=${paging.total}`
              : "LinkedIn did not search the audience the spec described — read the per-filter verdict before trusting the count",
          };
        } finally {
          await tap.drain();
          for (const release of releases.reverse()) release();
        }
      } catch (cause) {
        throw refusal(cause);
      }
    },
  });
}

export const capability = createFilterApplyCapability();
export default capability;
