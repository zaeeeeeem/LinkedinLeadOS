import { join } from "node:path";
import { z } from "zod";

import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import { capability as activityCapture } from "../activity.capture/index.js";
import { normalizeActivityUrl } from "../activity.capture/url.js";
import { sessionUrnsOf, sessionVanitiesOf } from "../profile.capture/identity.js";
import { parsePost, type ParsePostResult } from "./parse.js";

/**
 * D313's conditions, expressed as defaults rather than as documentation.
 *
 * `comments` and `reactions` are **off** unless named. When they are named they
 * are bounded, and the bound is small: the operator's instruction was that we
 * must not send the request again and again to get a whole thread, and that
 * reactions rank below comments in value.
 */
export const DEFAULT_COMMENTS_LIMIT = 10;
export const DEFAULT_REACTIONS_LIMIT = 10;

/**
 * Schema keys are **camelCase**, because `parseArgv` camel-cases every flag name
 * before the schema ever sees it (`flags.ts`'s `camel`). A `"comments-limit"` key
 * on a `.strict()` object is unreachable: the CLI spelling stays
 * `--comments-limit`, but what arrives is `commentsLimit`, and strict mode
 * rejects it as unrecognized. Pinned for the whole registry in
 * `tests/cli-schema-keys.test.ts`.
 */
const args = z
  .object({
    url: z.string().min(1),
    /** Read the comments the page rendered. Off by default (D313). */
    comments: z.coerce.boolean().default(false),
    commentsLimit: z.coerce.number().int().min(1).max(200).default(DEFAULT_COMMENTS_LIMIT),
    /** Read the reaction facepile the page rendered. Off by default (D313). */
    reactions: z.coerce.boolean().default(false),
    reactionsLimit: z.coerce.number().int().min(1).max(200).default(DEFAULT_REACTIONS_LIMIT),
  })
  .strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;

type CaptureOutcome = {
  snapshotFile: string | null;
  sessionUrns: string[];
  sessionVanities: string[];
  result: CapabilityResult;
};

export type PostGetDeps = {
  capture(ctx: Context, captureArgs: { url: string; surface: "post"; scrolls: number }): Promise<CaptureOutcome>;
};

/**
 * One bounded read pass. Enough for the post, its rendered comment prefix and
 * the facepile; deliberately not enough to walk a thread, because nothing here
 * is allowed to (D313).
 */
export const READ_PASSES = 2;

function snapshotFileOf(result: CapabilityResult): string | null {
  const data = result.data as { snapshot?: { archived?: unknown } } | undefined;
  const archived = data?.snapshot?.archived;
  return typeof archived === "string" ? archived : null;
}

const defaultDeps: PostGetDeps = {
  capture: async (ctx, captureArgs) => {
    const result = await activityCapture.run({ ...ctx, args: captureArgs });
    const captures = ctx.browser.tap.captures();
    return {
      result,
      snapshotFile: snapshotFileOf(result),
      sessionUrns: sessionUrnsOf(captures),
      sessionVanities: sessionVanitiesOf(captures),
    };
  },
};

function invalidTarget(): CapabilityError {
  return new CapabilityError({
    code: "POST_GET_URL_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "post.get requires a post permalink (/posts/… or /feed/update/…), not a person or company url",
  });
}

function noSnapshot(): CapabilityError {
  return new CapabilityError({
    code: "POST_GET_NO_SNAPSHOT",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: "the post page loaded but no DOM snapshot was archived, so nothing may be parsed",
  });
}

function identityRefused(parsed: ParsePostResult, path: string): CapabilityError {
  return new CapabilityError({
    code: "POST_GET_IDENTITY_UNRESOLVED",
    exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: "the archived snapshot did not resolve to the requested post urn",
    evidence: `${parsed.warnings.map((w) => w.code).join(", ")} — ${path}`,
  });
}

export function createPostGetCapability(deps: PostGetDeps = defaultDeps) {
  return defineCapability({
    name: "post.get",
    risk: "read-cheap",
    summary: "Read one post from an archived DOM snapshot; comments and reactions are opt-in and bounded.",
    args,
    needsBrowser: true,
    // One page load, and no profile open: a permalink is a post, not a person
    // (D222), so it must not spend the day's distinct-person budget.
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      // No `surface` hint: the permalink spellings name themselves, and passing
      // `surface: "post"` makes a bare slug look like a valid post target.
      const target = normalizeActivityUrl(ctx.args.url);
      if (target.surface !== "post" || target.postUrn === undefined) throw invalidTarget();

      const captured = await deps.capture(ctx, { url: target.url, surface: "post", scrolls: READ_PASSES });
      if (captured.snapshotFile === null) throw noSnapshot();

      const snapshotPath = receiptPath(join(ctx.run.paths.raw, captured.snapshotFile));
      const html = await ctx.browser.archive.readText(captured.snapshotFile);

      // Parsed offline, from the archived bytes — never from a live DOM read.
      const parsed = parsePost(html, {
        expectedUrn: target.postUrn,
        sessionVanities: captured.sessionVanities,
        ...(ctx.args.comments ? { comments: { limit: ctx.args.commentsLimit } } : {}),
        ...(ctx.args.reactions ? { reactions: { limit: ctx.args.reactionsLimit } } : {}),
      });
      if (!parsed.ok || parsed.post === null) throw identityRefused(parsed, snapshotPath);

      const post = parsed.post.value;
      ctx.run.log("parse.ok", {
        phase: "post.get",
        detail: {
          comments: parsed.comments.length,
          reactions: parsed.reactions.length,
          asked_comments: ctx.args.comments,
          asked_reactions: ctx.args.reactions,
        },
      });

      return {
        counts: {
          requested: 1,
          captured: 1,
          usable: 1,
          skipped: 0,
        },
        warnings: [
          ...(captured.result.warnings ?? []),
          ...parsed.warnings.map((w) => ({ code: w.code, n: w.n, field: w.field })),
        ],
        data: {
          // Every field below came from the rendered DOM, and says so.
          source: "dom-snapshot",
          post: {
            urn: post.urn,
            author_vanity: post.author_vanity,
            posted_at: post.posted_at,
            reactions_total: post.reactions_total,
            comments_total: post.comments_total,
            reposts_total: post.reposts_total,
            text_chars: post.text?.length ?? 0,
          },
          read: {
            comments: parsed.comments.length,
            reactions: parsed.reactions.length,
            // Stated plainly so a caller cannot read silence as completeness.
            comments_complete: post.comments_total === null ? null : parsed.comments.length >= post.comments_total,
            reactions_complete: post.reactions_total === null ? null : parsed.reactions.length >= post.reactions_total,
          },
          storage: { mode: "archive-only" },
          snapshot: snapshotPath,
        },
        next:
          post.comments_total !== null && parsed.comments.length < post.comments_total
            ? `re-run with --comments --comments-limit=<n> to read more of the ${post.comments_total} comments; nothing is loaded implicitly`
            : "read the archived snapshot for anything this receipt does not carry",
      };
    },
  });
}

export const capability = createPostGetCapability();
