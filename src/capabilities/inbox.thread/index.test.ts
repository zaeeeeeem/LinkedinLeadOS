import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InboxCaptureResult } from "../inbox.list/capture.js";
import { createInboxThreadCapability } from "./index.js";

const fixture = readFileSync(
  join(import.meta.dirname, "test-fixtures", "messenger-messages.synthetic.json"),
  "utf8",
);
const listFixture = readFileSync(
  join(import.meta.dirname, "..", "inbox.list", "test-fixtures", "messenger-conversations.synthetic.json"),
  "utf8",
);
const URL = "https://www.linkedin.com/messaging/thread/c3ludGhldGljLWE=/";
const SECRETS = [
  "SYNTHETIC_PRIVATE_MESSAGE_ALPHA",
  "SYNTHETIC_PRIVATE_MESSAGE_BETA",
  "SYNTHETIC_PRIVATE_MESSAGE_GAMMA",
];

function captured(payloads = [{ file: "0002-thread.json.gz", bytes: fixture.length }]): InboxCaptureResult {
  return {
    payloads,
    snapshot: null,
    reading: null,
    summary: { captured: 1, profile_ish: 1, unmatched_profile_ish: 0, misses: 0, patterns: [], endpoints: [] } as never,
    sessionUrns: ["urn:li:fsd_profile:OPERATOR"],
    warnings: [],
    foreground: { ok: true, via: "already" },
  };
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    args: { url: URL, limit: 50, scrolls: 2, ...overrides },
    flags: { noStore: false },
    run: {
      runId: "run", log: vi.fn(), paths: { raw: "/runs/run/raw" }, artifacts: () => ({ summary: "summary.json" }),
    },
    browser: { archive: { readText: vi.fn(async () => fixture) } },
  } as any;
}

describe("inbox.thread — composition", () => {
  it("costs one metered page and no profile/search spend", () => {
    expect(createInboxThreadCapability().cost({} as never)).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 0,
    });
  });

  it("tags sent/received, while no message text reaches receipt or log paths", async () => {
    const ctx = context();
    const capture = vi.fn(async () => captured());
    const result = await createInboxThreadCapability({ capture }).run(ctx);
    expect(ctx.browser.archive.readText).toHaveBeenCalledWith("0002-thread.json.gz");
    expect((result.data as any).read).toMatchObject({ messages: 3, sent: 1, received: 2 });
    expect((result.data as any).messages.map((m: any) => m.direction)).toEqual(["received", "sent", "received"]);
    expect((result.data as any).messages[0].text_chars).toBe(SECRETS[0]!.length);
    expect((result.data as any).messages.every((message: any) => !("text" in message))).toBe(true);
    expect((result.data as any).read.partial).toBe(true);
    for (const secret of SECRETS) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(ctx.run.log.mock.calls)).not.toContain(secret);
    }
  });

  it("states the accepted read-marking side effect on every successful receipt", async () => {
    const result = await createInboxThreadCapability({ capture: async () => captured() }).run(context());
    expect(result.data).toMatchObject({
      source: "voyager-body",
      storage: { mode: "archive-only" },
      side_effect: { may_mark_read: true },
      probe: { source_verdict: "voyager-body" },
    });
    expect((result.data as any).side_effect.note).toContain("may mark it read");
  });

  it("merges list and message envelopes and deduplicates by message urn", async () => {
    const ctx = context();
    ctx.browser.archive.readText.mockImplementation(async (file: string) =>
      file.includes("list") ? listFixture : fixture,
    );
    const result = await createInboxThreadCapability({
      capture: async () => captured([
        { file: "list.gz", bytes: listFixture.length },
        { file: "messages-a.gz", bytes: fixture.length },
        { file: "messages-duplicate.gz", bytes: fixture.length },
      ]),
    }).run(ctx);
    expect((result.data as any).messages).toHaveLength(3);
    expect((result.data as any).messages.map((message: any) => message.urn)).toEqual([
      "urn:li:msg_message:synthetic-2",
      "urn:li:msg_message:synthetic-1",
      "urn:li:msg_message:synthetic-empty",
    ]);
    expect(result.counts!.captured).toBe(3);
  });

  it("refuses a non-thread URL before capture or budget work", async () => {
    const capture = vi.fn(async () => captured());
    await expect(
      createInboxThreadCapability({ capture }).run(context({ url: "https://www.linkedin.com/feed/" })),
    ).rejects.toMatchObject({ code: "INBOX_THREAD_URL_INVALID", exit: 1 });
    expect(capture).not.toHaveBeenCalled();
  });

  it("fails as parse drift when no labeled payload can be parsed", async () => {
    await expect(
      createInboxThreadCapability({ capture: async () => captured([]) }).run(context()),
    ).rejects.toMatchObject({ code: "INBOX_THREAD_NO_LABELED_PAYLOAD", exit: 5 });
  });

  it("passes a lower-layer classified failure through unchanged", async () => {
    const failure = Object.assign(new Error("challenge"), { code: "CHALLENGE_DETECTED", exit: 2 });
    await expect(
      createInboxThreadCapability({ capture: async () => { throw failure; } }).run(context()),
    ).rejects.toBe(failure);
  });
});
