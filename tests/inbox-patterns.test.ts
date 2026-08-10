import { describe, expect, it } from "vitest";
import {
  carriesInboxPayload, isInboxFixtureEndpoint, isInboxIsh,
} from "../src/capabilities/inbox.list/patterns.js";

const BODY = JSON.stringify({
  data: { messengerConversationsBySyncToken: { elements: [{ conversationParticipants: [], messages: {} }] } },
});

describe("inbox source predicates", () => {
  it("recognizes a labeled conversation body and rejects body-shaped rails/documents", () => {
    const conversation =
      "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc";
    const notification =
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashNotificationCards.abc";
    expect(isInboxIsh(BODY)).toBe(true);
    expect(carriesInboxPayload(BODY, conversation)).toBe(true);
    expect(carriesInboxPayload(BODY, notification)).toBe(false);
    expect(carriesInboxPayload(BODY, "https://www.linkedin.com/messaging/")).toBe(false);
  });

  it("names only messaging payloads and the messaging document/snapshot as private fixtures", () => {
    expect(isInboxFixtureEndpoint(
      "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.abc",
    )).toBe(true);
    expect(isInboxFixtureEndpoint("https://www.linkedin.com/voyager/api/presenceStatuses")).toBe(false);
    expect(isInboxFixtureEndpoint("https://www.linkedin.com/messaging/")).toBe(true);
    expect(isInboxFixtureEndpoint("dom-snapshot:https://www.linkedin.com/messaging/")).toBe(true);
  });
});
