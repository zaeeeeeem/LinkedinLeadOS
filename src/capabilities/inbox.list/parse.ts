import { MAX_INBOX_PARTICIPANTS } from "./constants.js";

export type InboxParseWarning = { code: string; n: number; field: string };

export type InboxParticipant = {
  urn: string | null;
  name: string | null;
  is_operator: boolean;
};

export type InboxConversation = {
  urn: string | null;
  backend_urn: string | null;
  url: string | null;
  participants: InboxParticipant[];
  last_message: {
    sender_urn: string | null;
    text_chars: number;
    sent_at: string | null;
  };
  unread_count: number;
  unread: boolean;
};

export type ParseInboxListResult = {
  ok: boolean;
  conversations: InboxConversation[];
  examined: number;
  warnings: InboxParseWarning[];
};

type JsonObject = Record<string, unknown>;

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

/** Normalize once, before the href is compared or exposed (D287's inbox form). */
export function absoluteInboxHref(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const url = new URL(raw, "https://www.linkedin.com/");
    const host = url.hostname.toLowerCase();
    if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
    if (!/^\/messaging\/thread\//i.test(url.pathname)) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function conversationRowsOf(body: string): JsonObject[] | null {
  let root: unknown;
  try { root = JSON.parse(body); } catch { return null; }
  const data = record(record(root)?.["data"]);
  const envelope = record(data?.["messengerConversationsBySyncToken"]);
  const elements = envelope?.["elements"];
  if (!Array.isArray(elements)) return null;
  return elements.map(record).filter((row): row is JsonObject => row !== null);
}

function participantName(row: JsonObject): string | null {
  const kind = record(row["participantType"]);
  const member = record(kind?.["member"]);
  const first = stringOf(record(member?.["firstName"])?.["text"]);
  const last = stringOf(record(member?.["lastName"])?.["text"]);
  const organization = record(kind?.["organization"]);
  const orgName = stringOf(record(organization?.["name"])?.["text"]);
  const joined = [first, last].filter((v): v is string => v !== null).join(" ");
  return joined !== "" ? joined : orgName;
}

export function parseInboxList(
  body: string,
  options: { limit: number; sessionUrns?: readonly string[] },
): ParseInboxListResult {
  const rows = conversationRowsOf(body);
  if (rows === null) {
    return {
      ok: false, conversations: [], examined: 0,
      warnings: [{ code: "INBOX_ENVELOPE_MISSING", n: 1, field: "conversation envelope missing" }],
    };
  }
  const session = new Set(options.sessionUrns ?? []);
  const wanted = Math.max(0, Math.min(options.limit, 100));
  const conversations: InboxConversation[] = [];
  const warnings: InboxParseWarning[] = [];
  let noSnippet = 0;
  let noTimestamp = 0;
  let noParticipant = 0;
  let participantsNotExamined = 0;

  for (const row of rows.slice(0, wanted)) {
    const participantRows = Array.isArray(row["conversationParticipants"])
      ? (row["conversationParticipants"] as unknown[]).map(record).filter((p): p is JsonObject => p !== null)
      : [];
    participantsNotExamined += Math.max(0, participantRows.length - MAX_INBOX_PARTICIPANTS);
    const participants = participantRows.slice(0, MAX_INBOX_PARTICIPANTS).map((p) => {
      const urn = stringOf(p["hostIdentityUrn"]);
      return { urn, name: participantName(p), is_operator: urn !== null && session.has(urn) };
    });
    if (participants.length === 0) noParticipant++;

    const messages = record(row["messages"]);
    const elements = messages?.["elements"];
    const latest = Array.isArray(elements) ? record(elements[0]) : null;
    const bodyNode = record(latest?.["body"]);
    const text = stringOf(bodyNode?.["text"]);
    if (text === null) noSnippet++;
    const sentAt = epochIso(latest?.["deliveredAt"]);
    if (sentAt === null) noTimestamp++;
    const unreadCount = typeof row["unreadCount"] === "number" && row["unreadCount"] >= 0
      ? Math.trunc(row["unreadCount"] as number)
      : 0;

    conversations.push({
      urn: stringOf(row["entityUrn"]),
      backend_urn: stringOf(row["backendUrn"]),
      url: absoluteInboxHref(row["conversationUrl"]),
      participants,
      last_message: {
        sender_urn: stringOf(record(latest?.["sender"])?.["hostIdentityUrn"]),
        text_chars: text?.length ?? 0,
        sent_at: sentAt,
      },
      unread_count: unreadCount,
      unread: unreadCount > 0,
    });
  }

  const examined = conversations.length;
  if (noSnippet > 0) warnings.push({
    code: "CONVERSATION_NO_SNIPPET", n: noSnippet,
    field: `${noSnippet} of ${examined} examined conversations had no latest-message text`,
  });
  if (noTimestamp > 0) warnings.push({
    code: "CONVERSATION_NO_TIMESTAMP", n: noTimestamp,
    field: `${noTimestamp} of ${examined} examined conversations had no absolute latest-message timestamp`,
  });
  if (noParticipant > 0) warnings.push({
    code: "CONVERSATION_NO_PARTICIPANT", n: noParticipant,
    field: `${noParticipant} of ${examined} examined conversations had no participant row`,
  });
  if (participantsNotExamined > 0) warnings.push({
    code: "PARTICIPANTS_NOT_EXAMINED", n: participantsNotExamined,
    field: `${participantsNotExamined} participant rows exceeded the ${MAX_INBOX_PARTICIPANTS}-per-conversation receipt bound`,
  });
  return { ok: true, conversations, examined, warnings };
}
