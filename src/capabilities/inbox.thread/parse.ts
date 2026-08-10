import { absoluteInboxHref, conversationRowsOf, type InboxParseWarning } from "../inbox.list/parse.js";

type JsonObject = Record<string, unknown>;

export type InboxMessage = {
  urn: string | null;
  sender_urn: string | null;
  text_chars: number;
  sent_at: string | null;
  direction: "sent" | "received" | "unknown";
};

export type ParseInboxThreadResult = {
  ok: boolean;
  conversation_urn: string | null;
  messages: InboxMessage[];
  examined: number;
  warnings: InboxParseWarning[];
};

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function epochIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const millis = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

export function parseInboxThread(
  body: string,
  options: { url: string; limit: number; sessionUrns?: readonly string[] },
): ParseInboxThreadResult {
  const rows = conversationRowsOf(body);
  const target = absoluteInboxHref(options.url);
  if (rows === null || target === null) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: 0,
      warnings: [{ code: "INBOX_THREAD_ENVELOPE_MISSING", n: 1, field: "thread envelope or target missing" }],
    };
  }
  const row = rows.find((candidate) => absoluteInboxHref(candidate["conversationUrl"]) === target)
    ?? (rows.length === 1 ? rows[0]! : null);
  if (row === null) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: rows.length,
      warnings: [{ code: "INBOX_THREAD_TARGET_MISSING", n: 1, field: "captured body did not name the requested thread" }],
    };
  }
  const session = new Set(options.sessionUrns ?? []);
  const collection = record(row["messages"]);
  const rawMessages = Array.isArray(collection?.["elements"])
    ? (collection!["elements"] as unknown[]).map(record).filter((m): m is JsonObject => m !== null)
    : [];
  const wanted = Math.max(0, Math.min(options.limit, 100));
  const warnings: InboxParseWarning[] = [];
  let noText = 0;
  let noSender = 0;
  let noTime = 0;
  const messages = rawMessages.slice(0, wanted).map((message): InboxMessage => {
    const senderUrn = stringOf(record(message["sender"])?.["hostIdentityUrn"]);
    const text = stringOf(record(message["body"])?.["text"]);
    const sentAt = epochIso(message["deliveredAt"]);
    if (text === null) noText++;
    if (senderUrn === null) noSender++;
    if (sentAt === null) noTime++;
    return {
      urn: stringOf(message["entityUrn"]),
      sender_urn: senderUrn,
      text_chars: text?.length ?? 0,
      sent_at: sentAt,
      direction: senderUrn === null ? "unknown" : session.has(senderUrn) ? "sent" : "received",
    };
  });
  const examined = messages.length;
  if (noText > 0) warnings.push({
    code: "MESSAGE_NO_TEXT", n: noText,
    field: `${noText} of ${examined} examined messages had no text and were still emitted`,
  });
  if (noSender > 0) warnings.push({
    code: "MESSAGE_NO_SENDER", n: noSender,
    field: `${noSender} of ${examined} examined messages had no sender identity`,
  });
  if (noTime > 0) warnings.push({
    code: "MESSAGE_NO_SENT_AT", n: noTime,
    field: `${noTime} of ${examined} examined messages had no absolute sent time`,
  });
  return {
    ok: true,
    conversation_urn: stringOf(row["entityUrn"]),
    messages,
    examined,
    warnings,
  };
}
