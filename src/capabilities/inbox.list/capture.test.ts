import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../profile.capture/read.js", async (original) => ({
  ...(await original<typeof import("../profile.capture/read.js")>()),
  readLikeAHuman: vi.fn(),
}));
vi.mock("../profile.capture/snapshot.js", async (original) => ({
  ...(await original<typeof import("../profile.capture/snapshot.js")>()),
  captureDomSnapshot: vi.fn(),
}));
vi.mock("../../core/challenge/detect.js", async (original) => ({
  ...(await original<typeof import("../../core/challenge/detect.js")>()),
  assertNoChallenge: vi.fn(async () => undefined),
  recordChallenge: vi.fn(),
}));
vi.mock("../../core/tap/ready.js", async (original) => ({
  ...(await original<typeof import("../../core/tap/ready.js")>()),
  waitForAny: vi.fn(async () => undefined),
}));

import { readLikeAHuman } from "../profile.capture/read.js";
import { captureDomSnapshot } from "../profile.capture/snapshot.js";
import { captureInbox } from "./capture.js";

const BODY = JSON.stringify({
  data: { messengerConversationsBySyncToken: { elements: [{ conversationParticipants: [], messages: { elements: [] } }] } },
});
const PAYLOAD_URL =
  "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.synthetic";

function harness(captures: any[] = []) {
  const order: string[] = [];
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const tap = {
    cursor: 0,
    watch: vi.fn(() => {
      const release = vi.fn();
      releases.push(release);
      return release;
    }),
    drain: vi.fn(async () => { order.push("drain"); }),
    captures: vi.fn(() => captures),
    misses: vi.fn(() => []),
  };
  const ctx = {
    args: {},
    run: { runId: "run", log: vi.fn() },
    budget: {
      check: vi.fn(async () => { order.push("check"); }),
      spend: vi.fn(async () => { order.push("spend"); }),
    },
    browser: {
      tab: {
        ensureForeground: vi.fn(async () => ({ ok: true, via: "already", state: { hidden: false } })),
        navigate: vi.fn(async () => { order.push("navigate"); }),
      },
      tap,
      cursor: { pause: vi.fn(async () => undefined) },
      archive: {},
    },
  } as any;
  return { ctx, tap, releases, order };
}

const reading = {
  passes: 2,
  notches: 4,
  scrolled: 400,
  travelled: 400,
  scrollable: 800,
  pausedMs: 50,
  viewport: { scroller: "main", scrollerCandidates: 1 },
  layout: { settled: true, waitedMs: 20, polls: 2 },
};

beforeEach(() => {
  vi.mocked(readLikeAHuman).mockReset();
  vi.mocked(captureDomSnapshot).mockReset();
  vi.mocked(captureDomSnapshot).mockResolvedValue({
    archived: { file: "snapshot.gz", bytes: 10 } as never,
    probe: { html: "<main></main>" } as never,
    rendered: true,
    failure: null,
    detail: null,
  });
});

describe("captureInbox — safety composition", () => {
  it("checks and records spend before navigation, then drains/releases on a mid-read failure", async () => {
    vi.mocked(readLikeAHuman).mockRejectedValue(new Error("read failed"));
    const { ctx, tap, releases, order } = harness();
    await expect(
      captureInbox(ctx, { url: "https://www.linkedin.com/messaging/", passes: 2, itemRef: "list" }),
    ).rejects.toThrow("read failed");
    expect(order.slice(0, 3)).toEqual(["check", "spend", "navigate"]);
    expect(tap.drain).toHaveBeenCalledOnce();
    expect(releases.length).toBeGreaterThan(0);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("drains and releases every watch when navigation itself fails", async () => {
    vi.mocked(readLikeAHuman).mockResolvedValue(reading as never);
    const { ctx, tap, releases } = harness();
    ctx.browser.tab.navigate.mockRejectedValue(new Error("navigation failed"));
    await expect(
      captureInbox(ctx, { url: "https://www.linkedin.com/messaging/", passes: 2, itemRef: "list" }),
    ).rejects.toThrow("navigation failed");
    expect(tap.drain).toHaveBeenCalledOnce();
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
    expect(readLikeAHuman).not.toHaveBeenCalled();
  });

  it("is silent on a healthy labeled payload and returns only its archived reference", async () => {
    vi.mocked(readLikeAHuman).mockResolvedValue(reading as never);
    const capture = {
      seq: 1,
      pattern: "gql-messenger-conversations",
      patterns: ["gql-messenger-conversations", "linkedin-api"],
      requestId: "r",
      url: PAYLOAD_URL,
      status: 200,
      body: BODY,
      bytes: BODY.length,
      archived: { file: "payload.gz", bytes: BODY.length },
      capturedAt: "2026-08-10T00:00:00.000Z",
    };
    const { ctx } = harness([capture]);
    const result = await captureInbox(ctx, {
      url: "https://www.linkedin.com/messaging/", passes: 2, itemRef: "list",
    });
    expect(result.payloads).toEqual([{ file: "payload.gz", bytes: BODY.length }]);
    expect(result.warnings.map((warning) => warning.code)).not.toContain("NO_INBOX_PAYLOAD");
    expect(result.warnings.map((warning) => warning.code)).not.toContain("PATTERN_MISMATCH");
    expect(JSON.stringify(result.payloads)).not.toContain(BODY);
  });
});

describe("captureInbox — which box it scrolls (D298)", () => {
  const scrolled = (matched: string | null) => ({
    ...reading,
    viewport: {
      scroller: {
        tag: "div", id: null, role: null, componentkey: null,
        scrollHeight: 1796, clientHeight: 626,
        rect: { x: 620, y: 260, width: 680, height: 520 },
        matchedSelector: matched,
      },
      scrollerCandidates: 2,
    },
  });

  it("asks for the message pane on a thread and the rail on the list", async () => {
    vi.mocked(readLikeAHuman).mockResolvedValue(scrolled(".msg-s-message-list-container") as never);
    const { ctx } = harness([{ url: PAYLOAD_URL, body: BODY, bytes: 10, status: 200, archived: { file: "a.gz" }, patterns: ["gql-messenger-conversations"] }]);
    await captureInbox(ctx, { url: "https://www.linkedin.com/messaging/thread/2-abc/", passes: 2, itemRef: "thread" });
    expect(vi.mocked(readLikeAHuman).mock.calls[0]![0]!.preferScroller)
      .toEqual([".msg-s-message-list", "div[id^='message-list-']", ".msg-s-message-list-container", ".msg-s-message-list-content"]);

    vi.mocked(readLikeAHuman).mockClear();
    const list = harness([{ url: PAYLOAD_URL, body: BODY, bytes: 10, status: 200, archived: { file: "a.gz" }, patterns: ["gql-messenger-conversations"] }]);
    await captureInbox(list.ctx, { url: "https://www.linkedin.com/messaging/", passes: 2, itemRef: "list" });
    expect(vi.mocked(readLikeAHuman).mock.calls[0]![0]!.preferScroller)
      .toEqual([".msg-conversations-container__conversations-list"]);
  });

  it("warns rather than silently scrolling the tallest box", async () => {
    vi.mocked(readLikeAHuman).mockResolvedValue(scrolled(null) as never);
    const { ctx } = harness([{ url: PAYLOAD_URL, body: BODY, bytes: 10, status: 200, archived: { file: "a.gz" }, patterns: ["gql-messenger-conversations"] }]);
    const result = await captureInbox(
      ctx, { url: "https://www.linkedin.com/messaging/thread/2-abc/", passes: 2, itemRef: "thread" },
    );
    expect(result.warnings.map((w) => w.code)).toContain("SCROLLER_SELECTOR_UNMATCHED");
  });

  it("stays silent when the preferred selector matched", async () => {
    vi.mocked(readLikeAHuman).mockResolvedValue(scrolled(".msg-s-message-list-container") as never);
    const { ctx } = harness([{ url: PAYLOAD_URL, body: BODY, bytes: 10, status: 200, archived: { file: "a.gz" }, patterns: ["gql-messenger-conversations"] }]);
    const result = await captureInbox(
      ctx, { url: "https://www.linkedin.com/messaging/thread/2-abc/", passes: 2, itemRef: "thread" },
    );
    expect(result.warnings.map((w) => w.code)).not.toContain("SCROLLER_SELECTOR_UNMATCHED");
  });
});
