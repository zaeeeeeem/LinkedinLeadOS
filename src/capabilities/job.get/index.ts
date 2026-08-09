import { join } from "node:path";
import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { getStore, isStoreConfigured, recordParseDrift, upsertJob, type StoreClient } from "../../core/store/index.js";
import { capability as jobCapture } from "../job.capture/index.js";
import { normalizeJobUrl } from "../job.capture/url.js";
import { DOM_SOURCE, parseJobSnapshot } from "./parse.js";

const args = z.object({
  url: z.string().min(1),
  scrolls: z.coerce.number().int().min(0).max(12).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();
type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;

export type JobGetDeps = {
  storeConfigured(): boolean;
  store(): StoreClient;
  upsert(input: Parameters<typeof upsertJob>[0], client: StoreClient): ReturnType<typeof upsertJob>;
  recordDrift(warnings: readonly { field: string; n: number }[], client: StoreClient, shapeHash: string | null): Promise<number>;
  capture(ctx: Context, args: Args): Promise<CapabilityResult>;
};

const defaults: JobGetDeps = {
  storeConfigured: isStoreConfigured,
  store: getStore,
  upsert: (input, client) => upsertJob(input, { client }),
  recordDrift: (warnings, client, shapeHash) => recordParseDrift(warnings, { client, capability: "job.get", shapeHash }),
  capture: (ctx, captureArgs) => jobCapture.run({ ...ctx, args: captureArgs }),
};

function drift(code: string, message: string, evidence: string): CapabilityError {
  return new CapabilityError({ code, exit: EXIT.PARSE_DRIFT, action: "HALT_AND_NOTIFY", retryable: false, message, evidence });
}

export function createJobGetCapability(deps: JobGetDeps = defaults) {
  return defineCapability({
    name: "job.get",
    risk: "read-cheap",
    summary: "Read one job description from an archived DOM snapshot and enrich its canonical jobs row.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const target = normalizeJobUrl(ctx.args.url);
      const configured = deps.storeConfigured();
      const client = configured ? deps.store() : ctx.flags.noStore ? null : deps.store();
      const captured = await deps.capture(ctx, ctx.args);
      const data = captured.data as { snapshot?: { archived?: string | null }; capture?: { captured?: number; misses?: number } } | undefined;
      const file = data?.snapshot?.archived ?? null;
      const evidence = receiptPath(ctx.run.paths.raw) + "/";
      if (file === null) throw drift("JOB_SNAPSHOT_UNAVAILABLE", "job.capture archived no DOM snapshot, so no job may be parsed or stored", evidence);
      const html = await ctx.browser.archive.readText(file);
      const parsed = parseJobSnapshot(html, { url: target.url });
      if (!parsed.ok) throw drift("JOB_IDENTITY_UNRESOLVED", "the normalized URL and the archived document did not resolve to exactly one matching job id", receiptPath(join(ctx.run.paths.raw, file)));
      for (const warning of parsed.warnings) ctx.run.log("parse.miss", { level: "warn", phase: "job.get", item_ref: target.ref, detail: warning });
      if (!ctx.flags.noStore && parsed.warnings.length > 0) {
        const archived = (await ctx.browser.archive.list()).find((entry) => entry.file === file);
        await deps.recordDrift(parsed.warnings, client!, archived?.shapeHash ?? null);
      }
      if (parsed.job.value.description === undefined) {
        throw drift("JOB_DESCRIPTION_UNAVAILABLE", "the archived job snapshot did not yield a description from the approved data-testid anchor", receiptPath(join(ctx.run.paths.raw, file)));
      }
      ctx.run.log("parse.ok", { phase: "job.get", item_ref: target.ref, detail: { source: DOM_SOURCE, warnings: parsed.warnings.length } });
      const stored = ctx.flags.noStore ? null : await deps.upsert(parsed.job.value, client!);
      if (stored) ctx.run.log("store.write", { phase: "job.get", item_ref: target.ref, detail: { table: "jobs", rows: stored.rows } });
      return {
        counts: { requested: 1, captured: data?.capture?.captured ?? 0, usable: 1, skipped: data?.capture?.misses ?? 0 },
        warnings: [...(captured.warnings ?? []), ...parsed.warnings],
        ...(stored ? { stored: { table: "jobs", run_ref: ctx.run.runId, rows: stored.rows } } : {}),
        data: { from_cache: false, source: { identity: DOM_SOURCE, content: DOM_SOURCE, archived: file }, storage: stored ? { skipped: false, rows: stored.rows } : { skipped: true, reason: "--no-store" } },
        next: stored ? `select * from jobs where id = '${target.id}'` : `read the archived snapshot at ${receiptPath(join(ctx.run.paths.raw, file))}`,
      };
    },
  });
}

export const capability = createJobGetCapability();
export default capability;
