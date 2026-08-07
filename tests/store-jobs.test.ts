import { describe, expect, it, vi } from "vitest";
import { StoreWriteError, upsertJobs, type StoreClient } from "../src/core/store/index.js";

function client(result: { data: unknown[] | null; error: unknown; status: number }) {
  const select = vi.fn(async () => result); const upsert = vi.fn(() => ({ select })); const from = vi.fn(() => ({ upsert }));
  return { value: { from } as unknown as StoreClient, from, upsert };
}
describe("jobs store", () => {
  it("dedupes ids before one batch and writes last_seen last without first_seen", async () => {
    const fake = client({ data: [{ id: "1" }], error: null, status: 200 });
    const got = await upsertJobs([{ id: "1", company_urn: "urn:li:fsd_company:42", title: "first" }, { id: "1", title: "last", workplace_type: undefined }], { client: fake.value, now: 0 });
    expect(got.rows).toBe(1); expect(fake.from).toHaveBeenCalledWith("jobs");
    const [rows, opts] = fake.upsert.mock.calls[0] as unknown as [Record<string, unknown>[], { onConflict: string }];
    expect(opts).toEqual({ onConflict: "id" }); expect(rows).toHaveLength(1); expect(rows[0]?.title).toBe("last");
    expect(rows[0]).not.toHaveProperty("workplace_type"); expect(rows[0]).not.toHaveProperty("first_seen"); expect(Object.keys(rows[0]!).at(-1)).toBe("last_seen");
  });
  it("reports zero stored without exposing the database error", async () => {
    const fake = client({ data: null, error: { message: "database secret" }, status: 500 });
    await upsertJobs([{ id: "1" }], { client: fake.value }).catch((error) => { expect(error).toBeInstanceOf(StoreWriteError); expect(error).toMatchObject({ stored: 0 }); expect(error.message).not.toContain("database secret"); });
  });
});
