import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createInboxListCapability } from "./index.js";
import type { InboxCaptureResult } from "./capture.js";

const fixture = readFileSync(join(import.meta.dirname, "test-fixtures", "messenger-conversations.synthetic.json"), "utf8");
const SECRETS = [
  "SYNTHETIC_PRIVATE_MESSAGE_ALPHA",
  "SYNTHETIC_PRIVATE_MESSAGE_BETA",
  "SYNTHETIC_PRIVATE_MESSAGE_GAMMA",
];

function captured(payloads = [{ file: "0001-inbox.json.gz", bytes: fixture.length }]): InboxCaptureResult {
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
    args: { limit: 20, scrolls: 2, ...overrides },
    flags: { noStore: false },
    run: {
      runId: "run", log: vi.fn(), paths: { raw: "/runs/run/raw" }, artifacts: () => ({ summary: "summary.json" }),
    },
    browser: { archive: { readText: vi.fn(async () => fixture) } },
  } as any;
}

describe("inbox.list — composition", () => {
  it("costs one metered page and no profile/search spend", () => {
    expect(createInboxListCapability().cost({} as never)).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 0,
    });
  });

  it("parses archived bytes and strips every message text from receipt and logs", async () => {
    const ctx = context();
    const capture = vi.fn(async () => captured());
    const result = await createInboxListCapability({ capture }).run(ctx);
    expect(ctx.browser.archive.readText).toHaveBeenCalledWith("0001-inbox.json.gz");
    expect((result.data as any).conversations[0].last_message).toMatchObject({
      text_chars: SECRETS[0]!.length,
      sender_urn: "urn:li:fsd_profile:CONTACT_A",
    });
    expect("text" in (result.data as any).conversations[0].last_message).toBe(false);
    for (const secret of SECRETS) {
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(ctx.run.log.mock.calls)).not.toContain(secret);
    }
    expect((result.data as any).read.partial).toBe(true);
  });

  it("reports the labeled-body source and the list page's possible auto-open read side effect", async () => {
    const result = await createInboxListCapability({ capture: async () => captured() }).run(context());
    expect(result.data).toMatchObject({
      source: "voyager-body",
      storage: { mode: "archive-only" },
      side_effect: { may_mark_read: true },
      probe: { source_verdict: "voyager-body", labeled_payloads: 1 },
    });
    expect((result.data as any).side_effect.note).toContain("auto-open a thread");
  });

  it("fails as parse drift when no labeled payload can be parsed", async () => {
    await expect(
      createInboxListCapability({ capture: async () => captured([]) }).run(context()),
    ).rejects.toMatchObject({ code: "INBOX_LIST_NO_LABELED_PAYLOAD", exit: 5 });
  });

  it("passes a lower-layer classified failure through unchanged", async () => {
    const failure = Object.assign(new Error("challenge"), { code: "CHALLENGE_DETECTED", exit: 2 });
    await expect(
      createInboxListCapability({ capture: async () => { throw failure; } }).run(context()),
    ).rejects.toBe(failure);
  });
});
