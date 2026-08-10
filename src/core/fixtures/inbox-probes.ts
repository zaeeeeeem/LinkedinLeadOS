import type { FieldProbe } from "./fieldmap.js";
import { looksEpochMs, looksEpochSeconds } from "./timeshape.js";

/**
 * The fields Task 33 must locate before either inbox parser is written.
 * These are deliberately broad discovery probes: the private FIELD-MAP records
 * every matching path from the real body, then the synthetic fixture pins the
 * one path whose meaning was verified.
 */
export const INBOX_PROBES: readonly FieldProbe[] = [
  {
    name: "conversation_container",
    what: "the bounded conversation-list envelope",
    key: /^(messengerConversationsBySyncToken|conversations|conversationList)$/,
  },
  {
    name: "conversation_urn",
    what: "the stable conversation identity used by inbox.thread",
    key: /^(backendConversationUrn|conversationUrn)$/,
  },
  {
    name: "participants",
    what: "the conversation participants; session identity is marked rather than guessed",
    key: /^(conversationParticipants|participants)$/,
  },
  {
    name: "participant_urn",
    what: "one participant's urn; every hit is checked against the session set",
    value: /^urn:li:(fsd_profile|fs_profile|member|fsd_company|company):/,
  },
  {
    name: "last_message_snippet",
    what: "the latest rendered message body or preview; content remains private",
    key: /^(body|messageBody|snippet|previewText)$/,
  },
  {
    name: "conversation_timestamp",
    what: "an absolute conversation or latest-message timestamp",
    key: /^(createdAt|deliveredAt|lastActivityAt|lastMessageAt)$/,
    number: (n) => looksEpochMs(n) || looksEpochSeconds(n),
  },
  {
    name: "unread",
    what: "the unread count or read flag for one conversation",
    key: /^(unreadCount|read|lastReadAt)$/,
  },
  {
    name: "messages",
    what: "the message collection inside one conversation",
    key: /^(messages|messageEvents)$/,
  },
  {
    name: "sender",
    what: "the message sender container",
    key: /^(sender|actor|from)$/,
  },
  {
    name: "message_text",
    what: "the message text; this value never leaves the private archive",
    key: /^(body|messageBody|text)$/,
  },
  {
    name: "sent_at",
    what: "the message's absolute sent/delivered time",
    key: /^(deliveredAt|sentAt|createdAt)$/,
    number: (n) => looksEpochMs(n) || looksEpochSeconds(n),
  },
  {
    name: "pagination",
    what: "the cursor or sync token that bounds further list/thread reads",
    key: /^(paging|metadata|nextCursor|syncToken|paginationToken|start|count)$/,
  },
  {
    name: "graphql_envelope",
    what: "the response envelope a parser starts from",
    object: (keys) => keys.includes("data") || keys.includes("elements"),
  },
];
