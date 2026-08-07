import { describe, expect, it, vi } from "vitest";
import type { StoreClient } from "../../core/store/index.js";
import { createCompanyPostsCapability, type CompanyPostsDeps } from "./index.js";

const company = "urn:li:fsd_company:42"; const activity = "urn:li:activity:7400000000000000000";
const island = `<code id="bpr-guid-1">${JSON.stringify({ included: [{ entityUrn: company, universalName: "acme" }] }).replaceAll('"', "&quot;")}</code>`;
const social = "social:different"; const counts = "counts:also-different";
const captures = [
  { url: "https://www.linkedin.com/company/acme/posts/", body: island },
  { url: "https://www.linkedin.com/voyager/api/graphql?org", body: JSON.stringify({ included: [{ entityUrn: company }] }) },
  { url: "https://www.linkedin.com/voyager/api/graphql?feed", body: JSON.stringify({ included: [
    { metadata: { backendUrn: activity }, actor: { name: { attributesV2: [{ detailData: { "*companyName": company } }] } }, commentary: { text: { text: "hello" } }, "*socialDetail": social },
    { entityUrn: social, "*totalSocialActivityCounts": counts }, { entityUrn: counts, numLikes: 2, numComments: 1 },
  ] }) },
];
function setup(noStore = false) {
  const deps: CompanyPostsDeps = { storeConfigured: () => true, store: () => ({} as StoreClient),
    upsert: vi.fn(async (posts) => ({ rows: posts.length })), recordDrift: vi.fn(async () => 0),
    capture: vi.fn(async () => ({ captures, sessionUrns: [], result: { counts: { requested: 1, captured: 3, usable: 1, skipped: 0 } } })) };
  const ctx = { args: { url: "acme", limit: 1 }, flags: { noStore }, run: { runId: "run", paths: { raw: "/tmp/raw" }, log: vi.fn() } } as never;
  return { deps, ctx };
}
describe("company.posts composition", () => {
  it("captures, parses, and stores only bounded subject posts", async () => {
    const { deps, ctx } = setup(); const result = await createCompanyPostsCapability(deps).run(ctx);
    expect(deps.upsert).toHaveBeenCalledWith([expect.objectContaining({ urn: activity, company_urn: company })], expect.anything());
    expect(result.stored).toEqual({ table: "company_posts", run_ref: "run", rows: 1 });
    expect(result.data).not.toHaveProperty("company_urn");
    expect(JSON.stringify(result)).not.toContain(company);
  });
  it("keeps capture and parsing active under --no-store", async () => {
    const { deps, ctx } = setup(true); const result = await createCompanyPostsCapability(deps).run(ctx);
    expect(deps.capture).toHaveBeenCalledOnce(); expect(deps.upsert).not.toHaveBeenCalled(); expect(result.stored).toBeUndefined();
  });
});
