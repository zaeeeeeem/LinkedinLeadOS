import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import type { SearchKind } from "../../core/store/types.js";
import { captureSavedSearches, type SavedSearchCaptureResult } from "./capture.js";
import { RECEIPT_ENDPOINT_CAP, SALESNAV_HOME_URL } from "./constants.js";
import { parseSavedSearches, type ParseSavedSearchesResult } from "./parse.js";

const args = z.object({
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
}).strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;
export type SavedSearchListDeps = {
  capture(ctx: Context): Promise<SavedSearchCaptureResult>;
};
const defaultDeps: SavedSearchListDeps = { capture: captureSavedSearches };

function noPayload(): CapabilityError {
  return new CapabilityError({
    code: "SAVED_SEARCH_LIST_NO_LABELED_PAYLOAD", exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "the Saved searches panel returned no parseable salesApiSavedSearchesV2 body; re-measure the archived response before changing field paths",
  });
}

function kindFor(vertical: "lead" | "account"): SearchKind {
  return vertical === "lead" ? "sn_leads" : "sn_accounts";
}

export function createSavedSearchListCapability(deps: SavedSearchListDeps = defaultDeps) {
  return defineCapability({
    name: "salesnav.savedsearch.list",
    risk: "read-cheap",
    summary: "List the operator's own Sales Navigator saved searches from UI-issued responses.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const captured = await deps.capture(ctx);
      const best = new Map<SearchKind, ParseSavedSearchesResult>();
      for (const payload of captured.payloads) {
        const parsed = parseSavedSearches(
          await ctx.browser.archive.readText(payload.file),
          kindFor(payload.vertical),
        );
        if (!parsed.ok) continue;
        const previous = best.get(kindFor(payload.vertical));
        if (previous === undefined || parsed.searches.length > previous.searches.length) {
          best.set(kindFor(payload.vertical), parsed);
        }
      }
      if (best.size === 0) throw noPayload();

      const parsed = [...best.values()];
      const searches = parsed.flatMap((result) => result.searches);
      const examined = parsed.reduce((sum, result) => sum + result.examined, 0);
      const skipped = examined - searches.length;
      const warnings = [...captured.warnings, ...parsed.flatMap((result) => result.warnings)];
      ctx.run.log("parse.ok", {
        phase: "salesnav.savedsearch.list",
        detail: {
          verticals: best.size, examined, usable: searches.length, skipped,
          labels_emitted: searches.filter((row) => row.label !== null).length,
        },
      });

      return {
        counts: { requested: examined, captured: examined, usable: searches.length, skipped },
        warnings,
        data: {
          source: "sales-api-body",
          target: { url: SALESNAV_HOME_URL },
          read: {
            saved_searches: searches.length,
            lead: searches.filter((row) => row.kind === "sn_leads").length,
            account: searches.filter((row) => row.kind === "sn_accounts").length,
            examined,
          },
          searches,
          clicks: captured.clicks,
          // D363: listing is observational. Task 39/40 mints this immutable
          // identity immediately before its first result-page insert.
          storage: { mode: "deferred-to-first-execution", rows: 0 },
          probe: {
            labeled_payloads: captured.payloads.length,
            captured_after_click: captured.summary.captured,
            unmatched_saved_search_payloads: captured.summary.unmatched_profile_ish,
            patterns: captured.summary.patterns,
            endpoints: captured.summary.endpoints.slice(0, RECEIPT_ENDPOINT_CAP),
          },
          snapshot: captured.snapshot?.archived == null
            ? null
            : receiptPath(`${ctx.run.paths.raw}/${captured.snapshot.archived.file}`),
          artifacts: ctx.run.artifacts(),
        },
        next: searches.length === 0
          ? "Create a Lead or Account saved search in Sales Navigator, then run this capability again."
          : "Pass one returned filter_url to the matching saved-search execution capability; that first execution mints the searches row.",
      };
    },
  });
}

export const capability = createSavedSearchListCapability();
export default capability;
