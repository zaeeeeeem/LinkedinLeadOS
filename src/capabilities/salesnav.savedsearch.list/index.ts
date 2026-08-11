import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { captureSavedSearches, type SavedSearchCaptureResult } from "./capture.js";
import { RECEIPT_ENDPOINT_CAP, SALESNAV_HOME_URL } from "./constants.js";

const args = z.object({
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
}).strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;
export type SavedSearchListDeps = {
  capture(ctx: Context): Promise<SavedSearchCaptureResult>;
};
const defaultDeps: SavedSearchListDeps = { capture: captureSavedSearches };

/** Probe-first checkpoint. It deliberately lists no row until a real archived
 * body has fixed the parser paths (D152). */
export function createSavedSearchListCapability(deps: SavedSearchListDeps = defaultDeps) {
  return defineCapability({
    name: "salesnav.savedsearch.list",
    risk: "read-cheap",
    summary: "List the operator's own Sales Navigator saved searches from the UI-issued response.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const captured = await deps.capture(ctx);
      ctx.run.log("parse.miss", {
        phase: "savedsearch.probe",
        level: "warn",
        detail: { labeled_payloads: captured.payloads.length, parser: "withheld-until-real-fixture" },
      });
      return {
        counts: { requested: 0, captured: captured.payloads.length, usable: 0, skipped: 0 },
        warnings: captured.warnings,
        data: {
          source: captured.payloads.length > 0 ? "labeled-body-measured" : "unresolved",
          target: { url: SALESNAV_HOME_URL },
          read: { saved_searches: null },
          click: captured.click,
          storage: { mode: "archive-only-pending-decision" },
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
        next: `npm run fixtures:promote -- --run=${ctx.run.runId} --capability=salesnav.savedsearch.list`,
      };
    },
  });
}

export const capability = createSavedSearchListCapability();
export default capability;

