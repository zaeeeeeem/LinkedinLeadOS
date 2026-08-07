import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import { getStore, isStoreConfigured, recordParseDrift, StoreWriteError, upsertCompanyPosts,
  type CompanyPostsUpsertResult, type StoreClient } from "../../core/store/index.js";
import { capability as companyProbe } from "../company.probe/index.js";
import { normalizeCompanyUrl } from "../company.probe/url.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { parseCompanyPosts, type CompanyCapture, type CompanyPostsWarning } from "./parse.js";

const sinceArg = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "since must be an ISO date or timestamp");
const args = z.object({
  url: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  since: sinceArg.optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();
type PostsArgs = z.infer<typeof args>;
type PostsContext = CapabilityContext<PostsArgs, true>;
type CaptureArgs = Pick<PostsArgs, "url" | "captureTimeoutMs" | "layoutTimeoutMs">;
export type PostsCaptureExecution = { result: CapabilityResult; captures: CompanyCapture[]; sessionUrns: string[] };
export type CompanyPostsDeps = {
  storeConfigured(): boolean; store(): StoreClient;
  upsert(posts: Parameters<typeof upsertCompanyPosts>[0], client: StoreClient): Promise<CompanyPostsUpsertResult>;
  recordDrift(warnings: readonly CompanyPostsWarning[], o: { client: StoreClient }): Promise<number>;
  capture(ctx: PostsContext, args: CaptureArgs): Promise<PostsCaptureExecution>;
};
const defaults: CompanyPostsDeps = {
  storeConfigured: isStoreConfigured, store: getStore,
  upsert: (posts, client) => upsertCompanyPosts(posts, { client }),
  recordDrift: (warnings, o) => recordParseDrift(warnings, { client: o.client, capability: "company.posts", shapeHash: null }),
  capture: async (ctx, captureArgs) => {
    const before = ctx.browser.tap.cursor;
    const result = await companyProbe.run({ ...ctx, args: { ...captureArgs, subpages: "posts", scrolls: 6 } });
    const captures = ctx.browser.tap.captures().filter((capture) => capture.seq >= before);
    return { result, captures, sessionUrns: sessionUrnsOf(captures) };
  },
};
function drift(code: string, message: string, evidence: string): CapabilityError {
  return new CapabilityError({ code, exit: EXIT.PARSE_DRIFT, action: "HALT_AND_NOTIFY", retryable: false, message, evidence });
}
function ordinary(warnings: readonly CompanyPostsWarning[]): Warning[] { return warnings.map(({ code, field, n }) => ({ code, field, n })); }

export function createCompanyPostsCapability(deps: CompanyPostsDeps = defaults) {
  return defineCapability({
    name: "company.posts", risk: "read-cheap", needsBrowser: true,
    summary: "Read subject-authored company posts from captured Voyager bodies.", args,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const target = normalizeCompanyUrl(ctx.args.url);
      const configured = deps.storeConfigured();
      const client = configured ? deps.store() : ctx.flags.noStore ? null : deps.store();
      const captured = await deps.capture(ctx, { url: ctx.args.url,
        ...(ctx.args.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: ctx.args.captureTimeoutMs }),
        ...(ctx.args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: ctx.args.layoutTimeoutMs }) });
      const evidence = receiptPath(ctx.run.paths.raw) + "/";
      const parsed = parseCompanyPosts(captured.captures, { targetVanity: target.vanity,
        sessionUrns: captured.sessionUrns, limit: ctx.args.limit,
        ...(ctx.args.since === undefined ? {} : { since: Date.parse(ctx.args.since) }) });
      for (const item of parsed.warnings) ctx.run.log("parse.miss", { level: "warn", phase: "company.posts", item_ref: target.ref, detail: item });
      if (!parsed.ok) throw drift(parsed.warnings.some((w) => w.code === "PARSE_IDENTITY_IS_SESSION")
        ? "COMPANY_IDENTITY_IS_SESSION" : "COMPANY_IDENTITY_UNRESOLVED",
      "captured bodies did not yield a trusted company subject", evidence);
      let stored: CompanyPostsUpsertResult | null = null; let driftRows = 0;
      if (!ctx.flags.noStore) {
        stored = await deps.upsert(parsed.posts, client!);
        try { driftRows = await deps.recordDrift(parsed.warnings, { client: client! }); }
        catch (cause) { if (cause instanceof CapabilityError) throw new StoreWriteError(cause, stored.rows); throw cause; }
      }
      return { counts: { requested: ctx.args.limit, captured: captured.result.counts?.captured ?? captured.captures.length,
        usable: parsed.posts.length, skipped: parsed.inspectedUpdates - parsed.posts.length },
      warnings: [...(captured.result.warnings ?? []), ...ordinary(parsed.warnings)],
      ...(stored === null ? {} : { stored: { table: "company_posts", run_ref: ctx.run.runId, rows: stored.rows } }),
      data: { source: "voyager-body", inspected_updates: parsed.inspectedUpdates,
        storage: stored === null ? { skipped: true, reason: "--no-store" } : { skipped: false, post_rows: stored.rows, drift_rows: driftRows } },
      next: stored === null ? `read archived network bodies at ${evidence}` :
        `select p.urn, p.company_urn, p.posted_at, p.reactions, p.comments from company_posts p join companies c on c.urn = p.company_urn where c.vanity = '${target.vanity.replaceAll("'", "''")}' order by p.posted_at desc limit ${ctx.args.limit}` };
    },
  });
}
export const capability = createCompanyPostsCapability();
export default capability;
