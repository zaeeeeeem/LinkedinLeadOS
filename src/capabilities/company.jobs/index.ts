import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import { getStore, isStoreConfigured, recordParseDrift, StoreWriteError, upsertJobs,
  type JobsUpsertResult, type StoreClient } from "../../core/store/index.js";
import { capability as companyProbe } from "../company.probe/index.js";
import { normalizeCompanyUrl } from "../company.probe/url.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { parseCompanyJobs, type CompanyCapture, type CompanyJobsWarning } from "./parse.js";

const args = z.object({
  url: z.string().min(1), limit: z.coerce.number().int().min(1).max(100).default(100),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();
type JobsArgs = z.infer<typeof args>; type JobsContext = CapabilityContext<JobsArgs, true>;
type CaptureArgs = Pick<JobsArgs, "url" | "captureTimeoutMs" | "layoutTimeoutMs">;
export type JobsCaptureExecution = { result: CapabilityResult; captures: CompanyCapture[]; sessionUrns: string[] };
export type CompanyJobsDeps = {
  storeConfigured(): boolean; store(): StoreClient;
  upsert(rows: Parameters<typeof upsertJobs>[0], client: StoreClient): Promise<JobsUpsertResult>;
  recordDrift(warnings: readonly CompanyJobsWarning[], o: { client: StoreClient }): Promise<number>;
  capture(ctx: JobsContext, args: CaptureArgs): Promise<JobsCaptureExecution>;
};
const defaults: CompanyJobsDeps = {
  storeConfigured: isStoreConfigured, store: getStore,
  upsert: (rows, client) => upsertJobs(rows, { client }),
  recordDrift: (warnings, o) => recordParseDrift(warnings, { client: o.client, capability: "company.jobs", shapeHash: null }),
  capture: async (ctx, captureArgs) => {
    const before = ctx.browser.tap.cursor;
    const result = await companyProbe.run({ ...ctx, args: { ...captureArgs, subpages: "jobs", scrolls: 1 } });
    const captures = ctx.browser.tap.captures().filter((capture) => capture.seq >= before);
    return { result, captures, sessionUrns: sessionUrnsOf(captures) };
  },
};
function drift(code: string, evidence: string) {
  return new CapabilityError({ code, exit: EXIT.PARSE_DRIFT, action: "HALT_AND_NOTIFY", retryable: false,
    message: "captured bodies did not yield a trusted company subject", evidence });
}
function ordinary(warnings: readonly CompanyJobsWarning[]): Warning[] { return warnings.map(({ code, field, n }) => ({ code, field, n })); }

export function createCompanyJobsCapability(deps: CompanyJobsDeps = defaults) {
  return defineCapability({
    name: "company.jobs", risk: "read-cheap", needsBrowser: true,
    summary: "List subject-company jobs from captured embedded Voyager values.", args,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const target = normalizeCompanyUrl(ctx.args.url); const configured = deps.storeConfigured();
      const client = configured ? deps.store() : ctx.flags.noStore ? null : deps.store();
      const captured = await deps.capture(ctx, { url: ctx.args.url,
        ...(ctx.args.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: ctx.args.captureTimeoutMs }),
        ...(ctx.args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: ctx.args.layoutTimeoutMs }) });
      const evidence = receiptPath(ctx.run.paths.raw) + "/";
      const parsed = parseCompanyJobs(captured.captures, { targetVanity: target.vanity, sessionUrns: captured.sessionUrns, limit: ctx.args.limit });
      for (const item of parsed.warnings) ctx.run.log("parse.miss", { level: "warn", phase: "company.jobs", item_ref: target.ref, detail: item });
      if (!parsed.ok) throw drift(parsed.warnings.some((warning) => warning.code === "PARSE_IDENTITY_IS_SESSION") ? "COMPANY_IDENTITY_IS_SESSION" : "COMPANY_IDENTITY_UNRESOLVED", evidence);
      let stored: JobsUpsertResult | null = null; let driftRows = 0;
      if (!ctx.flags.noStore) {
        stored = await deps.upsert(parsed.jobs, client!);
        try { driftRows = await deps.recordDrift(parsed.warnings, { client: client! }); }
        catch (cause) { if (cause instanceof CapabilityError) throw new StoreWriteError(cause, stored.rows); throw cause; }
      }
      return {
        counts: { requested: ctx.args.limit, captured: captured.result.counts?.captured ?? captured.captures.length,
          usable: parsed.jobs.length, skipped: parsed.inspectedPostings - parsed.jobs.length },
        warnings: [...(captured.result.warnings ?? []), ...ordinary(parsed.warnings)],
        ...(stored === null ? {} : { stored: { table: "jobs", run_ref: ctx.run.runId, rows: stored.rows } }),
        data: { source: "embedded-json", inspected_postings: parsed.inspectedPostings,
          storage: stored === null ? { skipped: true, reason: "--no-store" } : { skipped: false, job_rows: stored.rows, drift_rows: driftRows } },
        next: stored === null ? `read archived network bodies at ${evidence}` :
          `select j.id, j.title, j.location, j.posted_at, j.workplace_type from jobs j join companies c on c.urn = j.company_urn where c.vanity = '${target.vanity.replaceAll("'", "''")}' order by j.posted_at desc limit ${ctx.args.limit}`,
      };
    },
  });
}
export const capability = createCompanyJobsCapability(); export default capability;
