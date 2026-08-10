import { join } from "node:path";
import { z } from "zod";

import { defineCapability, type CapabilityContext, type CapabilityResult } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import {
  findPersonByVanity,
  getStore,
  upsertPostRows,
  type OwnedPostProjection,
} from "../../core/store/index.js";
import { capability as activityCapture } from "../activity.capture/index.js";
import { normalizeActivityUrl } from "../activity.capture/url.js";
import { sessionUrnsOf, sessionVanitiesOf } from "../profile.capture/identity.js";
import { authorWarning, resolveAuthor, type AuthorLookup } from "./author.js";
import { parsePost, type ParsePostResult } from "./parse.js";
import { parseReactionsBody } from "./reactions.js";

/**
 * The watch whose bodies carry reactions. Registered by `activity.capture`, so
 * nothing here asks LinkedIn for anything the page did not already fetch (D1).
 */
const REACTIONS_PATTERN = "gql-social-reactions";

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
  /**
   * Bodies the page fetched on the `gql-social-reactions` watch. Empty on the
   * SDUI renderer, which fetches none (D312) — so this is a capability the page
   * either gave us or did not, never something requested on its own (D1).
   */
  reactionBodies: string[];
  result: CapabilityResult;
};

export type PostGetDeps = {
  capture(ctx: Context, captureArgs: { url: string; scrolls: number }): Promise<CaptureOutcome>;
  /** A store read. Never a page load, and never a profile open (D330). */
  findAuthor: AuthorLookup;
  store(row: OwnedPostProjection<"person_urn">): Promise<number>;
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
      reactionBodies: captures.filter((c) => c.patterns.includes(REACTIONS_PATTERN)).map((c) => c.body),
    };
  },
  findAuthor: async (vanity) => {
    const found = await findPersonByVanity(vanity, { client: getStore(), withExperience: false });
    if (found === null) return null;
    return { urn: found.person.urn, vanityMatches: found.vanityMatches ?? 1 };
  },
  store: (row) => upsertPostRows("person_urn", [row], { client: getStore() }),
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
    message:
      parsed.renderer === "unknown"
        ? "the archived snapshot is neither of the post renderers this reader knows (D340)"
        : "the archived snapshot did not resolve to the requested post urn",
    evidence: `renderer=${parsed.renderer} ${parsed.warnings.map((w) => w.code).join(", ")} — ${path}`,
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

      // No `surface` passed down either: a permalink names itself, and
      // `--surface=post` is refused as naming no page on its own. Measured live
      // on 2026-08-10 — the run failed before spending, which is the right
      // direction, but it failed.
      const captured = await deps.capture(ctx, { url: target.url, scrolls: READ_PASSES });
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

      // ── reactions: the labeled body wins over the rendered facepile (D341) ──
      // Only when asked for, exactly as D313 requires — a default run reads
      // neither source. The DOM stays the fallback for the renderer that fetches
      // no such body, so neither path is dead code.
      const reactionsFromBody =
        ctx.args.reactions && captured.reactionBodies.length > 0
          ? parseReactionsBody(captured.reactionBodies[0]!, {
            expectedUrn: target.postUrn,
            limit: ctx.args.reactionsLimit,
          })
          : null;
      const usingBody = reactionsFromBody !== null && reactionsFromBody.rows.length > 0;
      const reactionRows = usingBody
        ? reactionsFromBody!.rows.map((r) => ({ source: r.source, value: r.value as Record<string, unknown> }))
        : parsed.reactions.map((r) => ({ source: r.source, value: r.value as unknown as Record<string, unknown> }));
      // `paging.total` is what LinkedIn says; the aria-label is what a page
      // rendered. When both exist the labeled one is the number reported and
      // stored.
      const reactionsTotal = usingBody && reactionsFromBody!.total !== null
        ? reactionsFromBody!.total
        : post.reactions_total;

      // ── the author, and therefore whether anything may be written ──────────
      // `--no-store` touches the store for nothing at all, not even the lookup:
      // a run told not to store must not require a configured client to succeed.
      const author = ctx.flags.noStore
        ? null
        : await resolveAuthor(post.author_vanity, deps.findAuthor);
      const refusal = author === null ? null : authorWarning(author);

      // `person_posts.posted_at` is nullable in SQL, but the shared projection
      // types it as a string and a post whose snowflake would not parse is drift,
      // not a row. Refuse the write rather than widening the projection.
      const timeless = author?.status === "resolved" && post.posted_at === null;
      let storedRows: number | null = null;
      if (author?.status === "resolved" && post.posted_at !== null) {
        storedRows = await deps.store({
          urn: post.urn,
          person_urn: author.urn,
          text: post.text,
          posted_at: post.posted_at,
          reactions: reactionsTotal,
          comments: post.comments_total,
        });
      }

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
          // A DOM REACTIONS_PARTIAL counted the facepile against a rendered
          // label. When the body won, both numbers were replaced, so the stale
          // warning is dropped rather than left to contradict the receipt.
          ...parsed.warnings
            .filter((w) => !(usingBody && w.code === "REACTIONS_PARTIAL"))
            .map((w) => ({ code: w.code, n: w.n, field: w.field })),
          ...(usingBody && reactionsFromBody!.total !== null && reactionRows.length < reactionsFromBody!.total
            ? [{
              code: "REACTIONS_PARTIAL",
              n: reactionsFromBody!.total - reactionRows.length,
              field: `read ${reactionRows.length} of ${reactionsFromBody!.total} reactions the body reports; the page fetched one page and nothing here follows its pagination token`,
            }]
            : []),
          ...(reactionsFromBody?.warnings ?? []).map((w) => ({ code: w.code, n: w.n, field: w.field })),
          ...(refusal === null ? [] : [refusal]),
          ...(timeless
            ? [{
              code: "POST_AUTHOR_NOT_STORED",
              n: 1,
              field: `author resolved but posted_at did not, from ${post.urn}; no post row was written`,
            }]
            : []),
        ],
        ...(storedRows === null
          ? {}
          : { stored: { table: "person_posts", run_ref: ctx.run.runId, rows: storedRows } }),
        data: {
          // Every field below came from the rendered DOM, and says so.
          source: "dom-snapshot",
          // Which of LinkedIn's two post apps this snapshot was (D340). On the
          // receipt because a silent renderer switch is what cost the 2026-08-10
          // gate two page loads to diagnose — the run said "identity unresolved"
          // and nothing said "this is a different app".
          renderer: parsed.renderer,
          post: {
            urn: post.urn,
            author_vanity: post.author_vanity,
            posted_at: post.posted_at,
            reactions_total: reactionsTotal,
            comments_total: post.comments_total,
            reposts_total: post.reposts_total,
            text_chars: post.text?.length ?? 0,
          },
          read: {
            comments: parsed.comments.length,
            reactions: reactionRows.length,
            // Which source the reactions came from, per row and in summary, so
            // "voyager" and "dom-snapshot" are never conflated downstream (D341).
            reactions_source: usingBody ? "voyager" : "dom-snapshot",
            // Stated plainly so a caller cannot read silence as completeness.
            comments_complete: post.comments_total === null ? null : parsed.comments.length >= post.comments_total,
            reactions_complete: reactionsTotal === null ? null : reactionRows.length >= reactionsTotal,
          },
          // What the author lookup did, in the receipt rather than in a log —
          // a skipped write and a successful one must not look alike.
          author: {
            vanity: post.author_vanity,
            urn: author?.status === "resolved" ? author.urn : null,
            status: author === null ? "not-looked-up" : author.status,
          },
          storage:
            storedRows === null
              ? {
                mode: "archive-only",
                reason: ctx.flags.noStore
                  ? "--no-store"
                  : timeless
                    ? "posted_at unresolved"
                    : `author ${author?.status ?? "unknown"}`,
              }
              : { mode: "stored", table: "person_posts", rows: storedRows },
          snapshot: snapshotPath,
        },
        next:
          storedRows !== null && author?.status === "resolved"
            ? `select * from person_posts where urn = '${post.urn.replaceAll("'", "''")}'`
            : post.comments_total !== null && parsed.comments.length < post.comments_total
              ? `re-run with --comments --comments-limit=<n> to read more of the ${post.comments_total} comments; nothing is loaded implicitly`
              : "read the archived snapshot for anything this receipt does not carry",
      };
    },
  });
}

export const capability = createPostGetCapability();
