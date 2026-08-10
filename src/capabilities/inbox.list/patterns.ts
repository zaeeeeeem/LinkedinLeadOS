import { isPrivateEndpoint } from "../../core/fixtures/promote.js";
import { documentPattern, isLinkedInApiUrl, type TieredPattern } from "../profile.capture/patterns.js";

export const INBOX_URL = "https://www.linkedin.com/messaging/";
export const INBOX_DOCUMENT_NAME = "inbox-document";

/** Known messaging operations plus broad nets that make endpoint drift visible. */
export const INBOX_PATTERNS: readonly TieredPattern[] = [
  { name: "gql-messenger-conversations", tier: "specific", match: "messengerConversations" },
  { name: "gql-messaging-conversations", tier: "specific", match: "MessagingDashConversations" },
  { name: "gql-messenger-messages", tier: "specific", match: "messengerMessages" },
  { name: "gql-messaging-messages", tier: "specific", match: "MessagingDashMessages" },
  { name: "gql-any", tier: "broad", match: "/graphql" },
  { name: "linkedin-api", tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

export function inboxDocumentPattern(): TieredPattern {
  return documentPattern(INBOX_URL, INBOX_DOCUMENT_NAME);
}

const INBOX_BODY_MARKERS = [
  '"conversationParticipants"',
  '"backendConversationUrn"',
  '"messengerConversationsBySyncToken"',
  '"messages"',
];

export function isInboxIsh(body: string): boolean {
  return INBOX_BODY_MARKERS.some((marker) => body.includes(marker));
}

function operationOf(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.pathname} ${url.searchParams.get("queryId") ?? ""}`;
  } catch {
    return "";
  }
}

/**
 * The explicit boundary for private promotion. It first reuses D118's one
 * private-endpoint classifier, then narrows to conversation/message payloads;
 * settings, presence, notification and mailbox-count rails remain ineligible.
 * The messaging document/snapshot are eligible so the measure-first DOM grant
 * can be evaluated without preferring it over a labeled body.
 */
export function isInboxFixtureEndpoint(rawUrl: string): boolean {
  if (rawUrl.startsWith("dom-snapshot:")) return /linkedin\.com\/messaging(?:\/|$)/i.test(rawUrl);
  try {
    const url = new URL(rawUrl);
    if (/^\/messaging\/?$/i.test(url.pathname)) return true;
  } catch {
    return false;
  }
  if (!isPrivateEndpoint(rawUrl)) return false;
  return /(messenger|messaging).*(conversation|message)|(conversation|message).*(messenger|messaging)/i.test(
    operationOf(rawUrl),
  );
}

/** URL-aware by design: a document or private rail may contain message-shaped
 * markers without being a labeled inbox payload (D285's feed defect). */
export function carriesInboxPayload(body: string, url: string): boolean {
  try {
    if (/^\/messaging\/?$/i.test(new URL(url).pathname)) return false;
  } catch {
    return false;
  }
  if (!isPrivateEndpoint(url)) return false;
  return isInboxFixtureEndpoint(url) && isInboxIsh(body);
}
