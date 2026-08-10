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

function targetBackendUrn(url: string): string | null {
  const absolute = absoluteInboxHref(url);
  if (absolute === null) return null;
  try {
    const segments = new URL(absolute).pathname.split("/").filter(Boolean);
    const token = segments[2];
    return token === undefined || token === "" ? null : `urn:li:messagingThread:${decodeURIComponent(token)}`;
  } catch {
    return null;
  }
}

function directMessagesOf(body: string, backendUrn: string): { rows: JsonObject[]; conversationUrn: string | null } | null {
  let root: unknown;
  try { root = JSON.parse(body); } catch { return null; }
  const data = record(record(root)?.["data"]);
  const envelope = record(data?.["messengerMessagesBySyncToken"]);
  const elements = envelope?.["elements"];
  if (!Array.isArray(elements)) return null;
  const all = elements.map(record).filter((row): row is JsonObject => row !== null);
  const rows = all.filter((row) => stringOf(row["backendConversationUrn"]) === backendUrn);
  if (all.length > 0 && rows.length === 0) return { rows: [], conversationUrn: null };
  const urns = new Set(
    rows.map((row) => stringOf(record(row["conversation"])?.["entityUrn"]))
      .filter((urn): urn is string => urn !== null),
  );
  return { rows, conversationUrn: urns.size === 1 ? [...urns][0]! : null };
}

export function parseInboxThread(
  body: string,
  options: { url: string; limit: number; sessionUrns?: readonly string[] },
): ParseInboxThreadResult {
  const target = absoluteInboxHref(options.url);
  const backendUrn = targetBackendUrn(options.url);
  if (target === null || backendUrn === null) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: 0,
      warnings: [{ code: "INBOX_THREAD_ENVELOPE_MISSING", n: 1, field: "thread envelope or target missing" }],
    };
  }
  const direct = directMessagesOf(body, backendUrn);
  const conversations = direct === null ? conversationRowsOf(body) : null;
  const row = conversations?.find((candidate) => absoluteInboxHref(candidate["conversationUrl"]) === target)
    ?? (conversations?.length === 1 ? conversations[0]! : null);
  if (direct === null && conversations === null) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: 0,
      warnings: [{ code: "INBOX_THREAD_ENVELOPE_MISSING", n: 1, field: "thread envelope missing" }],
    };
  }
  if (direct !== null && direct.rows.length === 0) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: 0,
      warnings: [{ code: "INBOX_THREAD_TARGET_MISSING", n: 1, field: "captured body did not name the requested thread" }],
    };
  }
  if (direct === null && row === null) {
    return {
      ok: false, conversation_urn: null, messages: [], examined: conversations?.length ?? 0,
      warnings: [{ code: "INBOX_THREAD_TARGET_MISSING", n: 1, field: "captured body did not name the requested thread" }],
    };
  }
  const session = new Set(options.sessionUrns ?? []);
  const collection = row === null ? null : record(row["messages"]);
  const rawMessages = direct?.rows ?? (Array.isArray(collection?.["elements"])
    ? (collection!["elements"] as unknown[]).map(record).filter((m): m is JsonObject => m !== null)
    : []);
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
    conversation_urn: direct?.conversationUrn ?? (row === null ? null : stringOf(row["entityUrn"])),
    messages,
    examined,
    warnings,
  };
}
