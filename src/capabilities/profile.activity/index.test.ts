import { describe, expect, it, vi } from "vitest";
import { createProfileActivityCapability, scrollPassesForActivityLimit } from "./index.js";

const subject = "urn:li:fsd_profile:subject";
const identity = JSON.stringify({ included: [{ "*vieweeProfile": subject }] });
const activityBody = (kind: "Comments" | "Reactions", id: bigint) => JSON.stringify({
  data: { data: { [`feedDashProfileUpdatesByMember${kind}`]: {
    "*elements": [`urn:li:fsd_update:(urn:li:activity:${id},PROFILE_${kind.toUpperCase()},DEBUG_REASON,DEFAULT,false)`],
  } } },
  included: [{
    entityUrn: `urn:li:fsd_update:(urn:li:activity:${id},PROFILE_${kind.toUpperCase()},DEBUG_REASON,DEFAULT,false)`,
    metadata: { backendUrn: `urn:li:activity:${id}` },
    header: { text: { attributesV2: [{ detailData: { "*profileFullName": subject } }] } },
    actor: { name: { attributesV2: [{ detailData: { "*profileFullName": "urn:li:fsd_profile:target" } }] } },
    commentary: { text: { text: "target body" } },
  }],
});

function context(args: Record<string, unknown>) {
  return { args, flags: { noStore: false }, run: { runId: "run", log: vi.fn() } } as never;
}

describe("profile.activity composition", () => {
  it("prices two page loads and refuses a post permalink before capture", async () => {
    const capture = vi.fn();
    const cap = createProfileActivityCapability({ capture });
    expect(cap.cost({ url: "subject", limit: 20 })).toMatchObject({ page_loads: 2, profile_opens: 1 });
    const permalink = "https://www.linkedin.com/feed/update/urn:li:activity:7491197577439141888/";
    expect(cap.cost({ url: permalink, limit: 20 })).toMatchObject({ page_loads: 0, profile_opens: 0 });
    await expect(cap.run(context({ url: permalink, limit: 20 })))
      .rejects.toMatchObject({ code: "PROFILE_ACTIVITY_URL_INVALID" });
    expect(capture).not.toHaveBeenCalled();
  });

  it("captures both tabs with work bounded from --limit and performs no store write", async () => {
    expect(scrollPassesForActivityLimit(20)).toBe(0);
    expect(scrollPassesForActivityLimit(21)).toBe(1);
    const capture = vi.fn(async (_ctx, args: { surface: "comments" | "reactions" }) => ({
      bodies: [identity, activityBody(args.surface === "comments" ? "Comments" : "Reactions", 7491197577439141888n)],
      sessionUrns: [],
    }));
    const cap = createProfileActivityCapability({ capture });
    const receipt = await cap.run(context({ url: "subject", limit: 21 }));
    expect(capture).toHaveBeenCalledTimes(2);
    expect(capture).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ surface: "comments", scrolls: 1 }));
    expect(capture).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ surface: "reactions", scrolls: 1 }));
    expect(receipt).not.toHaveProperty("stored");
    expect(receipt.data).toMatchObject({ source: "voyager-json", storage: { mode: "archive-only" } });
  });

  it("refuses a session-owned subject before returning activity", async () => {
    const capture = vi.fn(async () => ({ bodies: [identity], sessionUrns: [subject] }));
    const cap = createProfileActivityCapability({ capture });
    await expect(cap.run(context({ url: "subject", limit: 20 })))
      .rejects.toMatchObject({ code: "PROFILE_ACTIVITY_SUBJECT_UNRESOLVED" });
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("reports per-kind counts and accounts since-filtered work", async () => {
    const capture = vi.fn(async (_ctx, args: { surface: "comments" | "reactions" }) => ({
      bodies: [identity, activityBody(args.surface === "comments" ? "Comments" : "Reactions", 7491197577439141888n)],
      sessionUrns: [],
    }));
    const cap = createProfileActivityCapability({ capture });
    const receipt = await cap.run(context({ url: "subject", limit: 1, since: "2030-01-01T00:00:00.000Z" }));
    expect(receipt.counts).toMatchObject({ requested: 2, captured: 2, usable: 0, skipped: 2 });
    expect(receipt.data).toMatchObject({ activity: { comments: 0, reactions: 0 }, from_archive: true });
  });
});
