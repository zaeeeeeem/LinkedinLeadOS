import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import {
  DEFAULT_MAX_AGE, findCompanyByUrn, findCompanyByVanity, getStore, isFresh,
  isStoreConfigured, parseDuration, recordParseDrift, StoreWriteError, upsertCompany,
  type CompanyUpsertResult, type StoreClient, type StoredCompany,
} from "../../core/store/index.js";
import { capability as companyProbe } from "../company.probe/index.js";
import { normalizeCompanyUrl, type CompanyTarget } from "../company.probe/url.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { parseCompanyCaptures, type CompanyCapture, type CompanyParseWarning } from "./parse.js";

const args = z.object({
  url: z.string().min(1),
  maxAge: z.union([z.string(), z.number()]).default(DEFAULT_MAX_AGE),
  scrolls: z.coerce.number().int().min(0).max(12).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();
type CompanyGetArgs = z.infer<typeof args>;
type CompanyGetContext = CapabilityContext<CompanyGetArgs, true>;
type CaptureArgs = Pick<CompanyGetArgs, "url" | "scrolls" | "captureTimeoutMs" | "layoutTimeoutMs">;

export type CompanyCaptureExecution = { result: CapabilityResult; captures: CompanyCapture[]; sessionUrns: string[] };
export type CompanyGetDeps = {
  storeConfigured(): boolean;
  store(): StoreClient;
  findByUrn(urn: string, client: StoreClient): Promise<StoredCompany | null>;
  findByVanity(vanity: string, client: StoreClient): Promise<StoredCompany | null>;
  upsert(input: Parameters<typeof upsertCompany>[0], client: StoreClient): Promise<CompanyUpsertResult>;
  recordDrift(warnings: readonly CompanyParseWarning[], o: { client: StoreClient; shapeHash: string | null }): Promise<number>;
  capture(ctx: CompanyGetContext, args: CaptureArgs): Promise<CompanyCaptureExecution>;
};

const defaultDeps: CompanyGetDeps = {
  storeConfigured: isStoreConfigured,
  store: getStore,
  findByUrn: (urn, client) => findCompanyByUrn(urn, { client }),
  findByVanity: (vanity, client) => findCompanyByVanity(vanity, { client }),
  upsert: (input, client) => upsertCompany(input, { client }),
  recordDrift: (warnings, o) => recordParseDrift(warnings, { client: o.client, capability: "company.get", shapeHash: o.shapeHash }),
  capture: async (ctx, captureArgs) => {
    const before = ctx.browser.tap.cursor;
    const result = await companyProbe.run({ ...ctx, args: { ...captureArgs, subpages: "main" } });
    const captures = ctx.browser.tap.captures().filter((capture) => capture.seq >= before);
    return { result, captures, sessionUrns: sessionUrnsOf(captures) };
  },
};

function drift(code: string, message: string, evidence: string): CapabilityError {
  return new CapabilityError({ code, exit: EXIT.PARSE_DRIFT, action: "HALT_AND_NOTIFY", retryable: false, message, evidence });
}

function cacheUrn(target: CompanyTarget): string | null {
  return /^\d+$/.test(target.segment) ? `urn:li:fsd_company:${target.segment}` : null;
}

async function cachedCompany(target: CompanyTarget, client: StoreClient, maxAgeMs: number, deps: CompanyGetDeps): Promise<StoredCompany | null> {
  if (maxAgeMs === 0) return null;
  const urn = cacheUrn(target);
  const stored = urn === null ? await deps.findByVanity(target.vanity, client) : await deps.findByUrn(urn, client);
  if (stored === null || !isFresh(stored.company.last_seen, maxAgeMs)) return null;
  if (urn === null && stored.vanityMatches !== 1) return null;
  return stored;
}

function sqlLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
function queryHint(target: CompanyTarget): string {
  const urn = cacheUrn(target);
  return urn === null
    ? `select * from companies where vanity = ${sqlLiteral(target.vanity)} order by last_seen desc limit 2`
    : `select * from companies where urn = ${sqlLiteral(urn)}`;
}
function ordinaryWarnings(warnings: readonly CompanyParseWarning[]): Warning[] {
  return warnings.map(({ code, field, n }) => ({ code, field, n }));
}
function captureCounts(result: CapabilityResult, evidence: string) {
  if (result.counts === undefined) throw drift("COMPANY_CAPTURE_CONTRACT_DRIFT", "company.probe returned no capture counts", evidence);
  return result.counts;
}

export function createCompanyGetCapability(deps: CompanyGetDeps = defaultDeps) {
  return defineCapability({
    name: "company.get", risk: "read-cheap", needsBrowser: true,
    summary: "Read one LinkedIn company from captured network bodies, with freshness and storage.",
    args, cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const target = normalizeCompanyUrl(ctx.args.url);
      const maxAgeMs = parseDuration(ctx.args.maxAge);
      const configured = deps.storeConfigured();
      const client = configured ? deps.store() : ctx.flags.noStore ? null : deps.store();
      if (client !== null) {
        const cached = await cachedCompany(target, client, maxAgeMs, deps);
        if (cached !== null) return {
          counts: { requested: 1, captured: 0, usable: 1, skipped: 0 },
          data: { from_cache: true, source: { identity: "store", content: "store" }, cache: { max_age_ms: maxAgeMs, vanity_matches: cached.vanityMatches ?? null } },
          next: queryHint(target),
        };
      }
      const captureArgs: CaptureArgs = {
        url: ctx.args.url,
        ...(ctx.args.scrolls === undefined ? {} : { scrolls: ctx.args.scrolls }),
        ...(ctx.args.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: ctx.args.captureTimeoutMs }),
        ...(ctx.args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: ctx.args.layoutTimeoutMs }),
      };
      const captured = await deps.capture(ctx, captureArgs);
      const evidence = receiptPath(ctx.run.paths.raw) + "/";
      const counts = captureCounts(captured.result, evidence);
      const parsed = parseCompanyCaptures(captured.captures, { targetVanity: target.vanity, sessionUrns: captured.sessionUrns });
      for (const item of parsed.warnings) ctx.run.log("parse.miss", { level: "warn", phase: "company.get", item_ref: target.ref, detail: item });
      if (!parsed.ok) {
        const code = parsed.warnings.some((item) => item.code === "PARSE_IDENTITY_IS_SESSION")
          ? "COMPANY_IDENTITY_IS_SESSION" : "COMPANY_IDENTITY_UNRESOLVED";
        throw drift(code, "captured bodies did not yield a trusted, corroborated company identity", evidence);
      }
      ctx.run.log("parse.ok", { phase: "company.get", item_ref: target.ref, detail: { source: "network-body", warnings: parsed.warnings.length } });
      let stored: CompanyUpsertResult | null = null;
      let driftRows = 0;
      if (!ctx.flags.noStore) {
        stored = await deps.upsert(parsed.company.value, client!);
        ctx.run.log("store.write", { phase: "company.get", item_ref: target.ref, detail: { table: "companies", rows: stored.rows } });
        try {
          driftRows = await deps.recordDrift(parsed.warnings, { client: client!, shapeHash: null });
        } catch (cause) {
          if (cause instanceof CapabilityError) throw new StoreWriteError(cause, stored.rows);
          throw cause;
        }
      }
      return {
        counts: { requested: 1, captured: counts.captured, usable: 1, skipped: counts.skipped },
        warnings: [...(captured.result.warnings ?? []), ...ordinaryWarnings(parsed.warnings)],
        ...(stored === null ? {} : { stored: { table: "companies", run_ref: ctx.run.runId, rows: stored.rows } }),
        data: {
          from_cache: false,
          source: { identity: parsed.company.source.identity, content: parsed.company.source.content },
          storage: stored === null ? { skipped: true, reason: "--no-store" } : { skipped: false, company_rows: 1, drift_rows: driftRows },
        },
        next: stored === null ? `read archived network bodies at ${evidence}` : queryHint(target),
      };
    },
  });
}
export const capability = createCompanyGetCapability();
export default capability;
