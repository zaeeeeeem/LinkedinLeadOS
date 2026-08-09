import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { getStore, upsertPostRows, type OwnedPostProjection } from "../../core/store/index.js";
import { capability as activityCapture } from "../activity.capture/index.js";
import { looksLikePostPermalink, normalizeActivityUrl } from "../activity.capture/url.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { parseProfilePosts } from "./parse.js";

const args = z.object({
  url: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(260).default(20),
  since: z.iso.datetime().optional(),
}).strict();
type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;

export function scrollPassesForLimit(limit: number): number {
  return Math.min(12, Math.max(0, Math.ceil(limit / 20) - 1));
}

type CaptureResult = { bodies: string[]; sessionUrns: string[]; result?: CapabilityResult };
type SequencedCapture = { seq: number };
export function capturesFromCursor<T extends SequencedCapture>(captures: readonly T[], cursor: number): T[] {
  return captures.filter((capture) => capture.seq >= cursor);
}
export type ProfilePostsDeps = {
  capture(ctx: Context, args: { url: string; surface: "posts"; scrolls: number }): Promise<CaptureResult>;
  store(rows: readonly OwnedPostProjection<"person_urn">[]): Promise<number>;
};

const defaultDeps: ProfilePostsDeps = {
  capture: async (ctx, captureArgs) => {
    const cursor = ctx.browser.tap.cursor;
    const result = await activityCapture.run({ ...ctx, args: captureArgs });
    const captures = capturesFromCursor(ctx.browser.tap.captures(), cursor);
    return {
      result,
      bodies: captures.map((capture) => capture.body),
      sessionUrns: sessionUrnsOf(ctx.browser.tap.captures()),
    };
  },
  store: (rows) => upsertPostRows("person_urn", rows, { client: getStore() }),
};

function stringsAtViewee(body: string): string[] {
  let root: unknown;
  try { root = JSON.parse(body); } catch { return []; }
  if (root === null || typeof root !== "object") return [];
  const included = (root as Record<string, unknown>)["included"];
  if (!Array.isArray(included)) return [];
  const found = new Set<string>();
  for (const entity of included) {
    if (entity === null || typeof entity !== "object") continue;
    const urn = (entity as Record<string, unknown>)["*vieweeProfile"];
    if (typeof urn === "string" && urn.startsWith("urn:li:fsd_profile:")) found.add(urn);
  }
  return [...found];
}

export function resolvePostsSubject(bodies: readonly string[], sessionUrns: readonly string[]): string | null {
  const candidates = new Set(bodies.flatMap(stringsAtViewee));
  for (const session of sessionUrns) candidates.delete(session);
  return candidates.size === 1 ? [...candidates][0]! : null;
}

function unresolved(): CapabilityError {
  return new CapabilityError({
    code: "PROFILE_POSTS_SUBJECT_UNRESOLVED", exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "the captured profile-components body did not resolve exactly one non-session subject; no posts were stored",
  });
}

function invalidTarget(): CapabilityError {
  return new CapabilityError({
    code: "PROFILE_POSTS_URL_INVALID", exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "profile.posts requires a person profile or recent-activity URL, not a post permalink",
  });
}

export function createProfilePostsCapability(deps: ProfilePostsDeps = defaultDeps) {
  return defineCapability({
    name: "profile.posts",
    risk: "read-cheap",
    summary: "Read a person's own posts from archived Voyager JSON into person_posts.",
    args,
    needsBrowser: true,
    cost: (a) => ({ page_loads: 1, search_pages: 0, profile_opens: looksLikePostPermalink(a.url) ? 0 : 1 }),
    run: async (ctx) => {
      const target = normalizeActivityUrl(ctx.args.url, { surface: "posts" });
      if (target.surface !== "posts" || target.personRef === undefined) throw invalidTarget();
      const scrolls = scrollPassesForLimit(ctx.args.limit);
      const captured = await deps.capture(ctx, { url: target.url, surface: "posts", scrolls });
      const subjectUrn = resolvePostsSubject(captured.bodies, captured.sessionUrns);
      if (subjectUrn === null) throw unresolved();

      let remaining = ctx.args.limit;
      const byUrn = new Map<string, OwnedPostProjection<"person_urn">>();
      let examined = 0;
      let excluded = 0;
      let unresolvedRows = 0;
      let filteredSince = 0;
      for (const body of captured.bodies) {
        if (remaining === 0 || !body.includes("feedDashProfileUpdatesByMemberShareFeed")) continue;
        const parsed = parseProfilePosts(body, {
          subjectUrn, limit: remaining, ...(ctx.args.since === undefined ? {} : { since: ctx.args.since }),
        });
        examined += parsed.examined;
        remaining -= parsed.examined;
        excluded += parsed.excludedAuthors;
        unresolvedRows += parsed.unresolved;
        filteredSince += parsed.filteredSince;
        for (const row of parsed.rows) byUrn.set(row.urn, row);
      }
      const rows = [...byUrn.values()];
      const stored = ctx.flags.noStore ? 0 : await deps.store(rows);
      ctx.run.log("parse.ok", { phase: "profile.posts", detail: { examined, usable: rows.length, excluded, unresolved: unresolvedRows, filtered_since: filteredSince } });
      return {
        counts: { requested: ctx.args.limit, captured: examined, usable: rows.length, skipped: excluded + unresolvedRows + filteredSince },
        ...(ctx.flags.noStore ? {} : { stored: { table: "person_posts", run_ref: ctx.run.runId, rows: stored } }),
        warnings: captured.result?.warnings,
        data: { source: "voyager-json", work: { limit: ctx.args.limit, examined, scrolls }, storage: { skipped: ctx.flags.noStore } },
        next: `select * from person_posts where person_urn = '${subjectUrn.replaceAll("'", "''")}' order by posted_at desc limit ${ctx.args.limit}`,
      };
    },
  });
}

export const capability = createProfilePostsCapability();
export default capability;
