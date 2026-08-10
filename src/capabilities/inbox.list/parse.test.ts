import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOX_LIST_FIELD_PATHS } from "./field-map.js";
import { absoluteInboxHref, parseInboxList } from "./parse.js";

const fixturePath = join(import.meta.dirname, "test-fixtures", "messenger-conversations.synthetic.json");
const fixture = readFileSync(fixturePath, "utf8");
const root = JSON.parse(fixture) as any;

describe("inbox.list — FIELD-MAP meaning", () => {
  it("pins every documented path to the intended value, not merely the right type", () => {
    const row = root.data.messengerConversationsBySyncToken.elements[0];
    expect(INBOX_LIST_FIELD_PATHS.rows).toBe("$.data.messengerConversationsBySyncToken.elements[]");
    expect(row.conversationParticipants[1].hostIdentityUrn).toBe("urn:li:fsd_profile:CONTACT_A");
    expect(row.messages.elements[0].body.text).toBe("SYNTHETIC_PRIVATE_MESSAGE_ALPHA");
    expect(row.messages.elements[0].deliveredAt).toBe(1786291200000);
    expect(row.unreadCount).toBe(2);

    const map = readFileSync(join(import.meta.dirname, "FIELD-MAP.md"), "utf8");
    for (const path of Object.values(INBOX_LIST_FIELD_PATHS)) expect(map).toContain(`\`${path}\``);
  });
});

describe("inbox.list — pure parser", () => {
  it("reads participants, latest-message metadata and unread state from the measured envelope", () => {
    const result = parseInboxList(fixture, { limit: 20, sessionUrns: ["urn:li:fsd_profile:OPERATOR"] });
    expect(result.ok).toBe(true);
    expect(result.conversations).toHaveLength(2);
    expect(result.conversations[0]!.participants.map((p) => p.is_operator)).toEqual([true, false]);
    expect(result.conversations[0]!.last_message).toEqual({
      sender_urn: "urn:li:fsd_profile:CONTACT_A",
      text: "SYNTHETIC_PRIVATE_MESSAGE_ALPHA",
      sent_at: "2026-08-09T16:00:00.000Z",
    });
    expect(result.conversations[0]!.unread).toBe(true);
    expect(result.conversations[0]!.unread_count).toBe(2);
  });

  it("normalizes relative hrefs once before returning or comparing them", () => {
    expect(absoluteInboxHref("/messaging/thread/c3ludGhldGljLWE=/")).toBe(
      "https://www.linkedin.com/messaging/thread/c3ludGhldGljLWE=/",
    );
    expect(absoluteInboxHref("https://evil.example/messaging/thread/x/")).toBeNull();
    const result = parseInboxList(fixture, { limit: 1 });
    expect(result.conversations[0]!.url).toBe("https://www.linkedin.com/messaging/thread/c3ludGhldGljLWE=/");
  });

  it("bounds output and warning denominators by rows actually examined", () => {
    const changed = JSON.parse(fixture) as any;
    delete changed.data.messengerConversationsBySyncToken.elements[0].messages.elements[0].body.text;
    const result = parseInboxList(JSON.stringify(changed), { limit: 1 });
    expect(result.conversations).toHaveLength(1);
    expect(result.conversations[0]!.last_message.text).toBeNull();
    expect(result.warnings).toContainEqual({
      code: "CONVERSATION_NO_SNIPPET",
      n: 1,
      field: "1 of 1 examined conversations had no latest-message text",
    });
  });

  it("reports a missing envelope rather than returning an unexplained empty list", () => {
    expect(parseInboxList("{}", { limit: 20 })).toMatchObject({
      ok: false,
      warnings: [{ code: "INBOX_ENVELOPE_MISSING" }],
    });
  });
});
