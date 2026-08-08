import { describe, expect, it, vi } from "vitest";
import { capturesFromCursor, createProfilePostsCapability, scrollPassesForLimit } from "./index.js";

const subject = "urn:li:fsd_profile:subject";
const activity = (id: bigint, author = subject) => ({
  data: { data: { feedDashProfileUpdatesByMemberShareFeed: {
    "*elements": [`urn:li:fsd_update:(urn:li:activity:${id},MEMBER_SHARES,DEBUG_REASON,DEFAULT,false)`],
  } } },
  included: [{ urn: `urn:li:activity:${id}` }, {
    entityUrn: `urn:li:fsd_update:(urn:li:activity:${id},MEMBER_SHARES,DEBUG_REASON,DEFAULT,false)`,
    metadata: { backendUrn: `urn:li:activity:${id}` },
    actor: { name: { attributesV2: [{ detailData: { "*profileFullName": author } }] } },
    commentary: { text: { text: "body" } },
  }],
});
const identity = { included: [{ "*vieweeProfile": subject, entityUrn: subject }] };

function context(args: Record<string, unknown>) {
  return {
    args, flags: { noStore: false }, run: { runId: "run", log: vi.fn() },
  } as never;
}

describe("profile.posts composition", () => {
  it("includes the first capture whose seq equals the pre-capture cursor", () => {
    const captures = [{ seq: 3, body: "first" }, { seq: 4, body: "second" }];
    expect(capturesFromCursor(captures, 3).map((capture) => capture.body)).toEqual(["first", "second"]);
  });

  it("turns --limit into bounded scroll work before capture", async () => {
    expect(scrollPassesForLimit(1)).toBe(0);
    expect(scrollPassesForLimit(20)).toBe(0);
    expect(scrollPassesForLimit(21)).toBe(1);
    const capture = vi.fn(async () => ({ bodies: [JSON.stringify(identity), JSON.stringify(activity(7491197577439141888n))], sessionUrns: [] }));
    const cap = createProfilePostsCapability({ capture, store: vi.fn(async (rows) => rows.length) });
    await cap.run(context({ url: "subject", limit: 21 }));
    expect(capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scrolls: 1 }));
  });

  it("stores an inclusive --since boundary and no older rows", async () => {
    const id = 7491197577439141888n;
    const boundary = new Date(Number(id >> 22n)).toISOString();
    const store = vi.fn(async (rows) => rows.length);
    const cap = createProfilePostsCapability({
      capture: vi.fn(async () => ({ bodies: [JSON.stringify(identity), JSON.stringify(activity(id))], sessionUrns: [] })), store,
    });
    await cap.run(context({ url: "subject", limit: 20, since: boundary }));
    expect(store.mock.calls[0]![0]).toHaveLength(1);
    const capAfter = createProfilePostsCapability({
      capture: vi.fn(async () => ({ bodies: [JSON.stringify(identity), JSON.stringify(activity(id))], sessionUrns: [] })), store,
    });
    await capAfter.run(context({ url: "subject", limit: 20, since: new Date(Date.parse(boundary) + 1).toISOString() }));
    expect(store.mock.calls[1]![0]).toHaveLength(0);
  });

  it("refuses a session-owned or unresolved subject before storing", async () => {
    const store = vi.fn(async () => 0);
    const cap = createProfilePostsCapability({
      capture: vi.fn(async () => ({ bodies: [JSON.stringify(identity), JSON.stringify(activity(7491197577439141888n))], sessionUrns: [subject] })), store,
    });
    await expect(cap.run(context({ url: "subject", limit: 20 }))).rejects.toMatchObject({ code: "PROFILE_POSTS_SUBJECT_UNRESOLVED" });
    expect(store).not.toHaveBeenCalled();
  });

  it("refuses post permalinks before capture and costs no profile open", async () => {
    const capture = vi.fn();
    const cap = createProfilePostsCapability({ capture, store: vi.fn() });
    const permalink = "https://www.linkedin.com/feed/update/urn:li:activity:7491197577439141888/";
    expect(cap.cost({ url: permalink, limit: 20 })).toMatchObject({ profile_opens: 0 });
    await expect(cap.run(context({ url: permalink, limit: 20 }))).rejects.toMatchObject({ code: "PROFILE_POSTS_URL_INVALID" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("accounts since-filtered rows as skipped", async () => {
    const id = 7491197577439141888n;
    const cap = createProfilePostsCapability({
      capture: vi.fn(async () => ({ bodies: [JSON.stringify(identity), JSON.stringify(activity(id))], sessionUrns: [] })),
      store: vi.fn(async () => 0),
    });
    const receipt = await cap.run(context({ url: "subject", limit: 1, since: "2030-01-01T00:00:00.000Z" }));
    expect(receipt.counts).toMatchObject({ captured: 1, usable: 0, skipped: 1 });
  });
});
