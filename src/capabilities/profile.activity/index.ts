import { z } from "zod";
import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { capability as activityCapture } from "../activity.capture/index.js";
import { looksLikePostPermalink, normalizeActivityUrl } from "../activity.capture/url.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import { capturesFromCursor, resolvePostsSubject } from "../profile.posts/index.js";
import { parseProfileActivity } from "./parse.js";

const args = z.object({
  url: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(260).default(20),
  since: z.iso.datetime().optional(),
}).strict();
type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;
type Surface = "comments" | "reactions";

export function scrollPassesForActivityLimit(limit: number): number {
  return Math.min(12, Math.max(0, Math.ceil(limit / 20) - 1));
}

type CaptureResult = {
  bodies: string[];
  sessionUrns: string[];
  result?: CapabilityResult;
};

export type ProfileActivityDeps = {
  capture(ctx: Context, args: { url: string; surface: Surface; scrolls: number }): Promise<CaptureResult>;
};

const defaultDeps: ProfileActivityDeps = {
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
};

function unresolved(): CapabilityError {
  return new CapabilityError({
    code: "PROFILE_ACTIVITY_SUBJECT_UNRESOLVED",
    exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "the captured profile-components body did not resolve exactly one non-session activity subject",
  });
}

function invalidTarget(): CapabilityError {
  return new CapabilityError({
    code: "PROFILE_ACTIVITY_URL_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "profile.activity requires a person profile or recent-activity URL, not a post permalink",
  });
}

export function createProfileActivityCapability(deps: ProfileActivityDeps = defaultDeps) {
  return defineCapability({
    name: "profile.activity",
    risk: "read-cheap",
    summary: "Read a person's outbound comments and reactions from archived Voyager JSON.",
    args,
    needsBrowser: true,
    cost: (a) => ({ page_loads: looksLikePostPermalink(a.url) ? 0 : 2, search_pages: 0, profile_opens: looksLikePostPermalink(a.url) ? 0 : 1 }),
    run: async (ctx) => {
      const target = normalizeActivityUrl(ctx.args.url);
      if (target.personRef === undefined || target.vanity === undefined || target.surface === "post") throw invalidTarget();
      const scrolls = scrollPassesForActivityLimit(ctx.args.limit);
      const commentsCapture = await deps.capture(ctx, { url: target.vanity, surface: "comments", scrolls });
      const subjectUrn = resolvePostsSubject(commentsCapture.bodies, commentsCapture.sessionUrns);
      if (subjectUrn === null) throw unresolved();
      const reactionsCapture = await deps.capture(ctx, { url: target.vanity, surface: "reactions", scrolls });
      const sessionUrns = [...new Set([...commentsCapture.sessionUrns, ...reactionsCapture.sessionUrns])];
      if (sessionUrns.includes(subjectUrn)) throw unresolved();

      let examined = 0;
      let excluded = 0;
      let unresolvedRows = 0;
      let filteredSince = 0;
      let commentCount = 0;
      let reactionCount = 0;
      for (const capture of [commentsCapture, reactionsCapture]) {
        let remaining = ctx.args.limit;
        for (const body of capture.bodies) {
          if (remaining === 0 || !body.includes("feedDashProfileUpdatesByMember")) continue;
          const parsed = parseProfileActivity(body, {
            subjectUrn,
            sessionUrns,
            limit: remaining,
            ...(ctx.args.since === undefined ? {} : { since: ctx.args.since }),
          });
          examined += parsed.examined;
          remaining -= parsed.examined;
          excluded += parsed.excludedActors + parsed.excludedSessionActors;
          unresolvedRows += parsed.unresolved;
          filteredSince += parsed.filteredSince;
          commentCount += parsed.rows.filter((row) => row.kind === "comment").length;
          reactionCount += parsed.rows.filter((row) => row.kind === "reaction").length;
        }
      }
      const usable = commentCount + reactionCount;
      ctx.run.log("parse.ok", {
        phase: "profile.activity",
        detail: { examined, usable, excluded, unresolved: unresolvedRows, filtered_since: filteredSince },
      });
      return {
        counts: {
          requested: ctx.args.limit * 2,
          captured: examined,
          usable,
          skipped: excluded + unresolvedRows + filteredSince,
        },
        warnings: [...(commentsCapture.result?.warnings ?? []), ...(reactionsCapture.result?.warnings ?? [])],
        data: {
          source: "voyager-json",
          activity: { comments: commentCount, reactions: reactionCount },
          work: { limit_per_surface: ctx.args.limit, examined, scrolls_per_surface: scrolls },
          storage: { mode: "archive-only" },
          from_archive: true,
          archive_hint: "Reparse the raw bodies in this run archive after the profile.activity storage decision lands.",
        },
        next: "Inspect this receipt's counts; raw activity remains available in the run archive for offline reparse.",
      };
    },
  });
}

export const capability = createProfileActivityCapability();
export default capability;
