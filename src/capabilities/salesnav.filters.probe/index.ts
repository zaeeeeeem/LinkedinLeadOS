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
import type { Capture } from "../../core/tap/network-tap.js";
import { SETTLE_MS_MAX, SETTLE_MS_MIN } from "../profile.capture/constants.js";
import { documentPattern } from "../profile.capture/patterns.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import { bodyDigest, compareQueryEcho, FilterProbeParseError, parseSearchFilterMetadata, parseSearchPaging, queryDigest, requestQuery } from "./parse.js";

const SEARCH_PATTERN = "salesapi-lead-search";
const CATALOG_PATTERN = "filter-probe-layout";
const DOCUMENT_PATTERN = "filter-probe-document";
const CAPTURE_TIMEOUT_MS = 60_000;

const args = z.object({
  spec: z.string().min(1),
  publicVocabPath: z.string().min(1).optional(),
  privateVocabPath: z.string().min(1).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
}).strict();

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
  if (cause instanceof FilterProbeParseError) return drift(cause.code, cause.message);
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
    code: "FILTER_PROBE_FAILED",
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

export function selectSearchCapture(captures: readonly Capture[], expectedQuery: string): Capture {
  const named = captures.filter((capture) => exactPath(capture.url, "/salesApiLeadSearch"));
  if (named.length === 0) {
    throw drift(
      "FILTER_PROBE_SEARCH_BODY_MISSING",
      "the built-url navigation issued no captured salesApiLeadSearch response",
      `captured=${captures.length}`,
    );
  }
  const distinct = new Set(named.map((capture) => queryDigest(requestQuery(capture.url))));
  if (distinct.size > 1) {
    throw drift(
      "FILTER_PROBE_REQUEST_AMBIGUOUS",
      "the navigation issued multiple distinct lead-search queries",
      `named=${named.length} distinct_queries=${distinct.size}`,
    );
  }
  const matching = named.filter((capture) => requestQuery(capture.url) === expectedQuery);
  if (matching.length === 0) {
    return named.at(-1)!;
  }
  return matching.at(-1)!;
}

export const capability = defineCapability({
  name: "salesnav.filters.probe",
  risk: "read-metered",
  summary: "Load one provenance-built Sales Navigator Lead URL and archive its request echo and count evidence.",
  args,
  needsBrowser: true,
  cost: () => ({ page_loads: 1, search_pages: 1, profile_opens: 0 }),
  run: async ({ run, args: input, browser, budget }) => {
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
      if (parsed.data.vertical !== "LEAD") {
        throw new Error("Task 42 probes the LEAD vertical only");
      }
      const vocabulary = await loadVocabulary({
        ...(input.publicVocabPath === undefined ? {} : { publicPath: input.publicVocabPath }),
        ...(input.privateVocabPath === undefined ? {} : { privatePath: input.privateVocabPath }),
      });
      const built = buildFilterUrl(parsed.data, loadPinnedFilterCatalog(), vocabulary);

      const releases = [
        ...SALESNAV_PATTERNS.map((pattern) => tap.watch(pattern)),
        tap.watch({ name: CATALOG_PATTERN, match: "salesApiSearchFilterLayout" }),
        tap.watch(documentPattern(built.url, DOCUMENT_PATTERN)),
      ];
      const warnings: Warning[] = [];
      const checkpoint = { kind: "salesnav-filter-probe/v1", stage: "preflight" };
      try {
        await budget.check({ kind: "page_load", n: 1 });
        await budget.check({ kind: "search_page", n: 1 });
        const foreground = await tab.ensureForeground();
        if (!foreground.ok) {
          throw new CapabilityError({
            code: "TAB_NOT_FOREGROUND", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
            message: "the Sales Navigator worker tab could not be kept foreground for the built-url probe",
          });
        }

        checkpoint.stage = "spend";
        run.checkpoint(checkpoint);
        await budget.spend({ kind: "page_load", n: 1 });
        await budget.spend({ kind: "search_page", n: 1 });

        const since = tap.cursor;
        checkpoint.stage = "navigate";
        run.checkpoint(checkpoint);
        run.log("nav.start", { phase: "filter-probe", detail: { vertical: "LEAD", filters: built.filtersCount } });
        await tab.navigate(built.url);
        run.log("nav.done", { phase: "filter-probe", detail: { vertical: "LEAD" } });

        checkpoint.stage = "post-navigation-gate";
        run.checkpoint(checkpoint);
        await assertNoChallenge({ tab, run, state: checkpoint });

        checkpoint.stage = "await-search";
        run.checkpoint(checkpoint);
        await tap.waitFor(SEARCH_PATTERN, { since, timeoutMs: input.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS });
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

        // Only after both the page and every captured response are cleared by
        // the challenge gates may the probe interpret request or response data.
        const search = selectSearchCapture(mine, built.query);
        const capturedQuery = requestQuery(search.url);
        const paging = parseSearchPaging(search.body);
        if (paging.start !== 0) {
          throw drift(
            "FILTER_PROBE_NOT_PAGE_ONE",
            "the built-url probe's named response does not identify itself as page 1",
            `start=${paging.start} count=${paging.count}`,
          );
        }

        const layouts = mine.filter((capture) => exactPath(capture.url, "/salesApiSearchFilterLayout"));
        const catalogMatches = layouts.filter((capture) => bodyDigest(capture.body) === FILTER_CATALOG_PROVENANCE.bodySha256);
        if (layouts.length === 0) {
          warnings.push({ code: "FILTER_CATALOG_NOT_CAPTURED", field: "no filter-layout body arrived on this built-url load", n: 1 });
        } else if (catalogMatches.length === 0) {
          warnings.push({ code: "FILTER_CATALOG_DRIFT", field: "captured filter-layout bodies do not match the pinned catalog hash", n: layouts.length });
        }

        checkpoint.stage = "done";
        run.checkpoint(checkpoint);
        return {
          counts: { requested: built.filtersCount, captured: mine.length, usable: 1, skipped: tap.misses().length },
          warnings,
          data: {
            vertical: "LEAD",
            filters_count: built.filtersCount,
            query: {
              exact: capturedQuery === built.query,
              built_sha256: queryDigest(built.query),
              captured_sha256: queryDigest(capturedQuery),
              echo: compareQueryEcho(built.query, capturedQuery),
            },
            paging,
            search_filter_metadata: parseSearchFilterMetadata(search.body),
            evidence: {
              search_archive_id: search.archived.file,
              catalog_archive_ids: layouts.map((capture) => capture.archived.file),
              catalog_hash_match: catalogMatches.length > 0,
              typeahead_bodies: mine.filter((capture) => exactPath(capture.url, "/salesApiFacetTypeahead")).length,
            },
            interactions: { clicks: 0, keystrokes: 0, wheel_events: 0 },
          },
          next: "Inspect the named archive metadata and body offline; do not infer echo fidelity from the address bar or rendered page.",
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

export default capability;
