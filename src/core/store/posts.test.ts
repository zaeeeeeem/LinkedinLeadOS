import { describe, expect, it, vi } from "vitest";
import { upsertPostRows } from "./posts.js";

describe("shared post write path", () => {
  it("batch-upserts person post projections on activity urn", async () => {
    const select = vi.fn(async () => ({ data: [{ urn: "urn:li:activity:1" }], error: null, status: 200 }));
    const upsert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ upsert }));
    const rows = [{ urn: "urn:li:activity:1", person_urn: "urn:li:fsd_profile:p", text: "x", posted_at: "2026-08-01T00:00:00.000Z", reactions: 1, comments: 2 }];
    await expect(upsertPostRows("person_urn", rows, { client: { from } as never, now: 0 })).resolves.toBe(1);
    expect(from).toHaveBeenCalledWith("person_posts");
    expect(upsert).toHaveBeenCalledWith([expect.objectContaining({ urn: rows[0]!.urn, last_seen: "1970-01-01T00:00:00.000Z" })], { onConflict: "urn" });
  });

  it("uses the same projection for company_posts", async () => {
    const select = vi.fn(async () => ({ data: [], error: null, status: 200 }));
    const upsert = vi.fn(() => ({ select }));
    const from = vi.fn(() => ({ upsert }));
    await upsertPostRows("company_urn", [{ urn: "urn:li:activity:1", company_urn: "urn:li:fsd_company:1", text: null, posted_at: "2026-08-01T00:00:00.000Z", reactions: null, comments: null }], { client: { from } as never });
    expect(from).toHaveBeenCalledWith("company_posts");
  });
});
