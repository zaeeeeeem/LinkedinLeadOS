import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { INBOX_THREAD_FIELD_PATHS } from "./field-map.js";
import { parseInboxThread } from "./parse.js";

const fixturePath = join(import.meta.dirname, "..", "inbox.list", "test-fixtures", "messenger-conversations.synthetic.json");
const fixture = readFileSync(fixturePath, "utf8");
const target = "https://www.linkedin.com/messaging/thread/c3ludGhldGljLWE=/";

describe("inbox.thread — FIELD-MAP meaning", () => {
  it("pins sender, text and sent_at paths to meaning-checked synthetic values", () => {
    const root = JSON.parse(fixture) as any;
    const message = root.data.messengerConversationsBySyncToken.elements[0].messages.elements[0];
    expect(message.sender.hostIdentityUrn).toBe("urn:li:fsd_profile:CONTACT_A");
    expect(message.body.text).toBe("SYNTHETIC_PRIVATE_MESSAGE_ALPHA");
    expect(message.deliveredAt).toBe(1786291200000);

    const map = readFileSync(join(import.meta.dirname, "FIELD-MAP.md"), "utf8");
    for (const path of Object.values(INBOX_THREAD_FIELD_PATHS)) expect(map).toContain(`\`${path}\``);
  });
});

describe("inbox.thread — pure parser", () => {
  it("tags operator-sent versus received through the supplied session identity set", () => {
    const result = parseInboxThread(fixture, {
      url: target,
      limit: 20,
      sessionUrns: ["urn:li:fsd_profile:OPERATOR"],
    });
    expect(result.ok).toBe(true);
    expect(result.messages.map((m) => m.direction)).toEqual(["received", "sent", "received"]);
    expect(result.messages.map((m) => m.sender_urn)).toEqual([
      "urn:li:fsd_profile:CONTACT_A",
      "urn:li:fsd_profile:OPERATOR",
      "urn:li:fsd_profile:CONTACT_A",
    ]);
  });

  it("emits a message with no text and raises a counted warning", () => {
    const result = parseInboxThread(fixture, { url: target, limit: 20 });
    expect(result.messages).toHaveLength(3);
    expect(result.messages[2]!.text).toBeNull();
    expect(result.warnings).toContainEqual({
      code: "MESSAGE_NO_TEXT",
      n: 1,
      field: "1 of 3 examined messages had no text and were still emitted",
    });
  });

  it("limits work and cites the examined prefix, not every message in the body", () => {
    const result = parseInboxThread(fixture, { url: target, limit: 2 });
    expect(result.messages).toHaveLength(2);
    expect(result.examined).toBe(2);
    expect(result.warnings.map((w) => w.code)).not.toContain("MESSAGE_NO_TEXT");
  });

  it("refuses a target absent from a multi-conversation body", () => {
    const result = parseInboxThread(fixture, {
      url: "https://www.linkedin.com/messaging/thread/not-present/",
      limit: 20,
    });
    expect(result).toMatchObject({ ok: false, warnings: [{ code: "INBOX_THREAD_TARGET_MISSING" }] });
  });
});
