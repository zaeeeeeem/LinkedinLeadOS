import { describe, expect, it, vi } from "vitest";
import { StoreWriteError, upsertCompanyPosts, type StoreClient } from "../src/core/store/index.js";

function client(result: { data: unknown[] | null; error: unknown; status: number }) {
  const select = vi.fn(async () => result); const upsert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ upsert }));
  return { value: { from } as unknown as StoreClient, from, upsert };
}
describe("company_posts store", () => {
  it("batch upserts by urn with first_seen absent and last_seen last", async () => {
    const fake = client({ data: [{ urn: "urn:li:activity:1" }], error: null, status: 200 });
    const result = await upsertCompanyPosts([{ urn: "urn:li:activity:1", company_urn: "urn:li:fsd_company:42", text: undefined, comments: null }], { client: fake.value, now: 0 });
    expect(result.rows).toBe(1); expect(fake.from).toHaveBeenCalledWith("company_posts");
    const [rows, opts] = fake.upsert.mock.calls[0] as unknown as [Record<string, unknown>[], { onConflict: string }]; expect(opts).toEqual({ onConflict: "urn" });
    const row = rows[0]!;
    expect(Object.keys(row).at(-1)).toBe("last_seen"); expect(row).not.toHaveProperty("first_seen"); expect(row).not.toHaveProperty("text"); expect(row.comments).toBeNull();
  });
  it("reports zero stored and hides the database error string", async () => {
    const fake = client({ data: null, error: { message: "database secret" }, status: 500 });
    await expect(upsertCompanyPosts([{ urn: "urn:li:activity:1", company_urn: "urn:li:fsd_company:42" }], { client: fake.value })).rejects.toMatchObject({ stored: 0 });
    await upsertCompanyPosts([{ urn: "urn:li:activity:1", company_urn: "urn:li:fsd_company:42" }], { client: fake.value }).catch((error) => { expect(error).toBeInstanceOf(StoreWriteError); expect(error.message).not.toContain("database secret"); });
  });
});
