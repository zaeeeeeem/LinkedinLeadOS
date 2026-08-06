import { join } from "node:path";
import { z } from "zod";

import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { receiptPath } from "../../core/run/paths.js";
import { CapabilityError, EXIT, type Warning } from "../../core/run/receipt.js";
import {
  DEFAULT_MAX_AGE,
  findPersonByUrn,
  findPersonByVanity,
  getStore,
  isFresh,
  isStoreConfigured,
  parseDuration,
  recordParseDrift,
  StoreWriteError,
  upsertPerson,
  type PersonUpsertResult,
  type StoreClient,
  type StoredPerson,
} from "../../core/store/index.js";
import { capability as profileCapture } from "../profile.capture/index.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import {
  DOM_SOURCE,
  parseProfileSnapshot,
  toPersonStoreInput,
  type ProfileParseWarning,
} from "../profile.capture/parse.js";
import { normalizeProfileUrl, type ProfileTarget } from "../profile.capture/url.js";

const args = z.object({
  url: z.string().min(1),
  maxAge: z.union([z.string(), z.number()]).default(DEFAULT_MAX_AGE),
  scrolls: z.coerce.number().int().min(0).max(12).optional(),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();

type ProfileGetArgs = z.infer<typeof args>;
type ProfileGetContext = CapabilityContext<ProfileGetArgs, true>;
type CaptureArgs = Pick<ProfileGetArgs, "url" | "scrolls" | "captureTimeoutMs" | "layoutTimeoutMs">;

export type CaptureExecution = {
  result: CapabilityResult;
  /** Captured data used only for the required session-vs-subject comparison.
   * Never copied onto the receipt. */
  sessionUrns: string[];
};

export type ProfileGetDeps = {
  storeConfigured(): boolean;
  store(): StoreClient;
  findByUrn(urn: string, client: StoreClient): Promise<StoredPerson | null>;
  findByVanity(vanity: string, client: StoreClient): Promise<StoredPerson | null>;
  upsert(input: Parameters<typeof upsertPerson>[0], client: StoreClient): Promise<PersonUpsertResult>;
  recordDrift(
    warnings: readonly ProfileParseWarning[],
    o: { client: StoreClient; shapeHash: string | null },
  ): Promise<number>;
  capture(ctx: ProfileGetContext, captureArgs: CaptureArgs): Promise<CaptureExecution>;
};

const defaultDeps: ProfileGetDeps = {
  storeConfigured: () => isStoreConfigured(),
  store: () => getStore(),
  findByUrn: (urn, client) => findPersonByUrn(urn, { client }),
  findByVanity: (vanity, client) => findPersonByVanity(vanity, { client }),
  upsert: (input, client) => upsertPerson(input, { client }),
  recordDrift: (warnings, o) => recordParseDrift(warnings, {
    client: o.client,
    capability: "profile.get",
    shapeHash: o.shapeHash,
  }),
  capture: async (ctx, captureArgs) => ({
    result: await profileCapture.run({ ...ctx, args: captureArgs }),
    sessionUrns: sessionUrnsOf(ctx.browser.tap.captures()),
  }),
};

type CaptureData = {
  target: ProfileTarget;
  snapshot: { archived: string | null; bytes: number; rendered: boolean; failure: string | null };
  capture: { captured: number; misses: number };
};

function captureData(result: CapabilityResult, evidence: string): CaptureData {
  const data = result.data as Partial<CaptureData> | null;
  if (
    data === null || typeof data !== "object" ||
    data.snapshot === undefined || typeof data.snapshot !== "object" ||
    data.capture === undefined || typeof data.capture !== "object"
  ) {
    throw drift(
      "PROFILE_CAPTURE_CONTRACT_DRIFT",
      "profile.capture returned no readable snapshot/capture contract",
      evidence,
    );
  }
  return data as CaptureData;
}

function drift(code: string, message: string, evidence: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
    evidence,
  });
}

function cacheUrn(target: ProfileTarget): string | null {
  return target.kind === "sales-lead" && target.leadId
    ? `urn:li:fsd_profile:${target.leadId}`
    : null;
}

async function cachedPerson(
  target: ProfileTarget,
  client: StoreClient,
  maxAgeMs: number,
  deps: ProfileGetDeps,
): Promise<StoredPerson | null> {
  if (maxAgeMs === 0) return null;
  const urn = cacheUrn(target);
  const stored = urn !== null
    ? await deps.findByUrn(urn, client)
    : target.vanity === undefined
      ? null
      : await deps.findByVanity(target.vanity, client);
  if (stored === null || !isFresh(stored.person.last_seen, maxAgeMs)) return null;
  // A reused vanity does not identify one person (D104). Fetch the page to
  // resolve its card-ref urn rather than serving the newest guess as the answer.
  if (target.vanity !== undefined && stored.vanityMatches !== 1) return null;
  return stored;
}

function ordinaryWarnings(warnings: readonly ProfileParseWarning[]): Warning[] {
  return warnings.map(({ code, field, n }) => ({ code, field, n }));
}

function refusalCode(warnings: readonly ProfileParseWarning[]): string {
  const code = warnings[0]?.code;
  if (code === "PARSE_IDENTITY_IS_SESSION") return "PROFILE_IDENTITY_IS_SESSION";
  if (code === "PARSE_SESSION_IDENTITY_UNAVAILABLE") return "PROFILE_SESSION_IDENTITY_UNAVAILABLE";
  return "PROFILE_IDENTITY_UNRESOLVED";
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function queryHint(target: ProfileTarget): string {
  if (target.vanity !== undefined) {
    return `select * from persons where vanity = ${sqlLiteral(target.vanity)} order by last_seen desc limit 2`;
  }
  const urn = cacheUrn(target);
  return urn === null
    ? "select * from persons order by last_seen desc limit 1"
    : `select * from persons where urn = ${sqlLiteral(urn)}`;
}

export function createProfileGetCapability(deps: ProfileGetDeps = defaultDeps) {
  return defineCapability({
    name: "profile.get",
    risk: "read-cheap",
    summary: "Read one LinkedIn profile from an archived DOM snapshot, with freshness and storage.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 1 }),
    run: async (ctx) => {
      const target = normalizeProfileUrl(ctx.args.url);
      const maxAgeMs = parseDuration(ctx.args.maxAge);
      const configured = deps.storeConfigured();
      // `--no-store` skips writes, not useful reads. If a store exists, it may
      // still save the page load; if it does not, no-store is the explicit
      // permission to continue with archive-only output.
      const client = configured ? deps.store() : ctx.flags.noStore ? null : deps.store();

      if (client !== null) {
        const cached = await cachedPerson(target, client, maxAgeMs, deps);
        if (cached !== null) {
          return {
            counts: { requested: 1, captured: 0, usable: 1, skipped: 0 },
            data: {
              from_cache: true,
              source: { identity: "store", content: "store" },
              cache: {
                max_age_ms: maxAgeMs,
                experience_rows: cached.experience.length,
                vanity_matches: cached.vanityMatches ?? null,
              },
            },
            next: queryHint(target),
          };
        }
      }

      const captureArgs: CaptureArgs = {
        url: ctx.args.url,
        ...(ctx.args.scrolls === undefined ? {} : { scrolls: ctx.args.scrolls }),
        ...(ctx.args.captureTimeoutMs === undefined ? {} : { captureTimeoutMs: ctx.args.captureTimeoutMs }),
        ...(ctx.args.layoutTimeoutMs === undefined ? {} : { layoutTimeoutMs: ctx.args.layoutTimeoutMs }),
      };
      const captured = await deps.capture(ctx, captureArgs);
      const fallbackEvidence = receiptPath(ctx.run.paths.raw) + "/";
      const data = captureData(captured.result, fallbackEvidence);
      const snapshotFile = data.snapshot.archived;
      if (snapshotFile === null) {
        throw drift(
          "PROFILE_SNAPSHOT_UNAVAILABLE",
          "profile.capture did not archive a DOM snapshot, so no profile may be parsed or stored",
          fallbackEvidence,
        );
      }
      const snapshotPath = receiptPath(join(ctx.run.paths.raw, snapshotFile));
      const html = await ctx.browser.archive.readText(snapshotFile);
      const parsed = parseProfileSnapshot(html, { sessionUrns: captured.sessionUrns });
      for (const warning of parsed.warnings) {
        ctx.run.log("parse.miss", {
          level: "warn",
          phase: "profile.get",
          item_ref: target.ref,
          detail: {
            code: warning.code,
            field: warning.field,
            n: warning.n,
            basis: warning.basis,
          },
        });
      }
      if (!parsed.ok) {
        throw drift(
          refusalCode(parsed.warnings),
          "the archived DOM snapshot did not yield a trusted, usable profile identity",
          snapshotPath,
        );
      }
      ctx.run.log("parse.ok", {
        phase: "profile.get",
        item_ref: target.ref,
        detail: { source: DOM_SOURCE, warnings: parsed.warnings.length },
      });

      let stored: PersonUpsertResult | null = null;
      let driftRows = 0;
      if (!ctx.flags.noStore) {
        stored = await deps.upsert(toPersonStoreInput(parsed), client!);
        ctx.run.log("store.write", {
          phase: "profile.get",
          item_ref: target.ref,
          detail: {
            table: "persons",
            rows: stored.rows,
            experience_upserted: stored.experience.upserted,
            experience_removed: stored.experience.removed,
          },
        });
        const archived = (await ctx.browser.archive.list()).find((entry) => entry.file === snapshotFile);
        try {
          driftRows = await deps.recordDrift(parsed.warnings, {
            client: client!,
            shapeHash: archived?.shapeHash ?? null,
          });
        } catch (cause) {
          if (cause instanceof CapabilityError) throw new StoreWriteError(cause, stored.rows);
          throw cause;
        }
      }

      return {
        counts: {
          requested: 1,
          captured: data.capture.captured,
          usable: 1,
          skipped: data.capture.misses,
        },
        warnings: [...(captured.result.warnings ?? []), ...ordinaryWarnings(parsed.warnings)],
        ...(stored === null ? {} : {
          stored: { table: "persons", run_ref: ctx.run.runId, rows: stored.rows },
        }),
        data: {
          from_cache: false,
          source: {
            identity: DOM_SOURCE,
            content: DOM_SOURCE,
            archived: snapshotFile,
          },
          storage: stored === null ? {
            skipped: true,
            reason: "--no-store",
          } : {
            skipped: false,
            person_rows: 1,
            experience_rows: stored.experience.upserted,
            experience_removed: stored.experience.removed,
            drift_rows: driftRows,
          },
        },
        next: stored === null
          ? `read the archived snapshot at ${snapshotPath}`
          : queryHint(target),
      };
    },
  });
}

export const capability = createProfileGetCapability();
export default capability;
