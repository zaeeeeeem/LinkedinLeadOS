import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import { captureInbox, type InboxCaptureResult } from "./capture.js";
import { INBOX_URL } from "./patterns.js";
import { parseInboxList } from "./parse.js";
import {
  DEFAULT_INBOX_LIST_LIMIT, DEFAULT_INBOX_SCROLL_PASSES, MAX_INBOX_ROWS, MAX_INBOX_SCROLL_PASSES,
} from "./constants.js";

const args = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_INBOX_ROWS).default(DEFAULT_INBOX_LIST_LIMIT),
  scrolls: z.coerce.number().int().min(0).max(MAX_INBOX_SCROLL_PASSES).default(DEFAULT_INBOX_SCROLL_PASSES),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;
export type InboxListDeps = {
  capture(ctx: Context, options: { url: string; passes: number; itemRef: "list" }): Promise<InboxCaptureResult>;
};
const defaultDeps: InboxListDeps = { capture: (ctx, options) => captureInbox(ctx, options) };

function noPayload(): CapabilityError {
  return new CapabilityError({
    code: "INBOX_LIST_NO_LABELED_PAYLOAD", exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "the messaging page returned no labeled conversation body; use the archived snapshot to re-measure before adding a DOM parser",
  });
}

export function createInboxListCapability(deps: InboxListDeps = defaultDeps) {
  return defineCapability({
    name: "inbox.list",
    risk: "read-cheap",
    summary: "Read conversation summaries from the operator's inbox; message text stays archived.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const captured = await deps.capture(ctx, { url: INBOX_URL, passes: ctx.args.scrolls, itemRef: "list" });
      let best: ReturnType<typeof parseInboxList> | null = null;
      for (const payload of captured.payloads) {
        const body = await ctx.browser.archive.readText(payload.file);
        const parsed = parseInboxList(body, { limit: ctx.args.limit, sessionUrns: captured.sessionUrns });
        if (parsed.ok && (best === null || parsed.conversations.length > best.conversations.length)) best = parsed;
      }
      if (best === null) throw noPayload();

      const textless = best.conversations.filter((row) => row.last_message.text === null).length;
      ctx.run.log("parse.ok", {
        phase: "inbox.list",
        detail: { conversations: best.conversations.length, unread: best.conversations.filter((row) => row.unread).length, textless },
      });
      return {
        counts: {
          requested: ctx.args.limit,
          captured: best.examined,
          usable: best.conversations.length,
          skipped: 0,
        },
        warnings: [...captured.warnings, ...best.warnings],
        data: {
          source: "voyager-body",
          target: { url: INBOX_URL, limit: ctx.args.limit, passes: ctx.args.scrolls },
          read: {
            conversations: best.conversations.length,
            unread: best.conversations.filter((row) => row.unread).length,
            examined: best.examined,
            partial: best.conversations.length >= ctx.args.limit,
          },
          conversations: best.conversations.map((row) => ({
            urn: row.urn,
            backend_urn: row.backend_urn,
            url: row.url,
            participants: row.participants,
            last_message: {
              sender_urn: row.last_message.sender_urn,
              sent_at: row.last_message.sent_at,
              text_chars: row.last_message.text?.length ?? 0,
            },
            unread_count: row.unread_count,
            unread: row.unread,
          })),
          storage: { mode: "archive-only-pending-decision" },
          side_effect: { may_mark_read: false },
          probe: {
            labeled_payloads: captured.payloads.length,
            source_verdict: "voyager-body",
            scroller: captured.reading?.viewport?.scroller ?? null,
            scroller_candidates: captured.reading?.viewport?.scrollerCandidates ?? null,
          },
          snapshot: captured.snapshot?.archived == null
            ? null
            : receiptPath(`${ctx.run.paths.raw}/${captured.snapshot.archived.file}`),
          artifacts: ctx.run.artifacts(),
        },
        next: `npm run fixtures:promote -- --run=${ctx.run.runId} --capability=inbox.list`,
      };
    },
  });
}

export const capability = createInboxListCapability();
export default capability;
