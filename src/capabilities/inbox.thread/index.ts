import { z } from "zod";
import { defineCapability, type CapabilityContext } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { receiptPath } from "../../core/run/paths.js";
import { captureInbox, type InboxCaptureResult } from "../inbox.list/capture.js";
import { absoluteInboxHref } from "../inbox.list/parse.js";
import {
  DEFAULT_INBOX_SCROLL_PASSES, DEFAULT_INBOX_THREAD_LIMIT, MAX_INBOX_ROWS, MAX_INBOX_SCROLL_PASSES,
} from "../inbox.list/constants.js";
import { parseInboxThread } from "./parse.js";

const args = z.object({
  url: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(MAX_INBOX_ROWS).default(DEFAULT_INBOX_THREAD_LIMIT),
  scrolls: z.coerce.number().int().min(0).max(MAX_INBOX_SCROLL_PASSES).default(DEFAULT_INBOX_SCROLL_PASSES),
  captureTimeoutMs: z.coerce.number().int().min(100).max(120_000).optional(),
  layoutTimeoutMs: z.coerce.number().int().min(10).max(120_000).optional(),
}).strict();

type Args = z.infer<typeof args>;
type Context = CapabilityContext<Args, true>;
export type InboxThreadDeps = {
  capture(ctx: Context, options: { url: string; passes: number; itemRef: "thread" }): Promise<InboxCaptureResult>;
};
const defaultDeps: InboxThreadDeps = { capture: (ctx, options) => captureInbox(ctx, options) };

function invalidUrl(): CapabilityError {
  return new CapabilityError({
    code: "INBOX_THREAD_URL_INVALID", exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "inbox.thread requires a LinkedIn /messaging/thread/ URL",
  });
}

function noPayload(): CapabilityError {
  return new CapabilityError({
    code: "INBOX_THREAD_NO_LABELED_PAYLOAD", exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "the thread returned no labeled message body; re-measure the archived snapshot before adding a DOM parser",
  });
}

function identityConflict(): CapabilityError {
  return new CapabilityError({
    code: "INBOX_THREAD_IDENTITY_CONFLICT", exit: EXIT.PARSE_DRIFT,
    action: "HALT_AND_NOTIFY", retryable: false,
    message: "captured thread payloads disagreed on conversation identity",
  });
}

export function createInboxThreadCapability(deps: InboxThreadDeps = defaultDeps) {
  return defineCapability({
    name: "inbox.thread",
    risk: "read-cheap",
    summary: "Read one inbox thread; opening it may mark it read and message text stays archived.",
    args,
    needsBrowser: true,
    cost: () => ({ page_loads: 1, search_pages: 0, profile_opens: 0 }),
    run: async (ctx) => {
      const url = absoluteInboxHref(ctx.args.url);
      if (url === null) throw invalidUrl();
      const captured = await deps.capture(ctx, { url, passes: ctx.args.scrolls, itemRef: "thread" });
      const parsedBodies: ReturnType<typeof parseInboxThread>[] = [];
      for (const payload of captured.payloads) {
        const body = await ctx.browser.archive.readText(payload.file);
        const parsed = parseInboxThread(body, { url, limit: 100, sessionUrns: captured.sessionUrns });
        if (parsed.ok) parsedBodies.push(parsed);
      }
      if (parsedBodies.length === 0) throw noPayload();
      const conversationUrns = new Set(
        parsedBodies.map((parsed) => parsed.conversation_urn)
          .filter((urn): urn is string => urn !== null),
      );
      if (conversationUrns.size > 1) throw identityConflict();

      // One navigation can capture the list's latest-message row plus several
      // messengerMessages pages. Dedupe only messages with a real identity;
      // identity-less rows are retained rather than collapsed by guesswork.
      const seen = new Set<string>();
      const allMessages = parsedBodies.flatMap((parsed) => parsed.messages).filter((message) => {
        if (message.urn === null) return true;
        if (seen.has(message.urn)) return false;
        seen.add(message.urn);
        return true;
      });
      const messages = allMessages.slice(0, ctx.args.limit);
      const parseWarnings = [];
      const noText = messages.filter((message) => message.text_chars === 0).length;
      const noSender = messages.filter((message) => message.sender_urn === null).length;
      const noTime = messages.filter((message) => message.sent_at === null).length;
      if (noText > 0) parseWarnings.push({
        code: "MESSAGE_NO_TEXT", n: noText,
        field: `${noText} of ${messages.length} examined messages had no text and were still emitted`,
      });
      if (noSender > 0) parseWarnings.push({
        code: "MESSAGE_NO_SENDER", n: noSender,
        field: `${noSender} of ${messages.length} examined messages had no sender identity`,
      });
      if (noTime > 0) parseWarnings.push({
        code: "MESSAGE_NO_SENT_AT", n: noTime,
        field: `${noTime} of ${messages.length} examined messages had no absolute sent time`,
      });

      ctx.run.log("parse.ok", {
        phase: "inbox.thread",
        detail: {
          messages: messages.length,
          sent: messages.filter((message) => message.direction === "sent").length,
          received: messages.filter((message) => message.direction === "received").length,
          textless: noText,
        },
      });
      return {
        counts: {
          requested: ctx.args.limit,
          captured: allMessages.length,
          usable: messages.length,
          skipped: 0,
        },
        warnings: [...captured.warnings, ...parseWarnings],
        data: {
          source: "voyager-body",
          target: { url, limit: ctx.args.limit, passes: ctx.args.scrolls },
          read: {
            messages: messages.length,
            sent: messages.filter((message) => message.direction === "sent").length,
            received: messages.filter((message) => message.direction === "received").length,
            unknown_sender: messages.filter((message) => message.direction === "unknown").length,
            examined: messages.length,
            // No measured field proves the beginning of the thread was
            // reached. A bounded read must not claim completeness by silence.
            partial: true,
          },
          conversation_urn: conversationUrns.size === 1 ? [...conversationUrns][0]! : null,
          messages: messages.map((message) => ({
            urn: message.urn,
            sender_urn: message.sender_urn,
            sent_at: message.sent_at,
            direction: message.direction,
            text_chars: message.text_chars,
          })),
          storage: { mode: "archive-only" },
          side_effect: {
            may_mark_read: true,
            note: "Opening this thread may mark it read in LinkedIn; no send, react, archive or mark action was performed.",
          },
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
        next: `npm run fixtures:promote -- --run=${ctx.run.runId} --capability=inbox.thread`,
      };
    },
  });
}

export const capability = createInboxThreadCapability();
export default capability;
