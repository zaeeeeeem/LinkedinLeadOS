import { describe, expect, it, vi } from "vitest";
import type { StoreClient } from "../../core/store/index.js";
import { createCompanyJobsCapability, type CompanyJobsDeps } from "./index.js";

const company = "urn:li:fsd_company:42";
const island = `<code id="bpr-guid-1">${JSON.stringify({ included: [
  { entityUrn: company, universalName: "acme" },
  { entityUrn: "urn:li:fsd_geo:1", fullLocalizedName: "Remote" },
  { entityUrn: "urn:li:fsd_jobPosting:101", companyDetails: { jobCompany: { "*company": company } }, "*location": "urn:li:fsd_geo:1", jobState: "LISTED", listedAt: 1_700_000_000_000, title: "Engineer", description: { text: "Full description" } },
] }).replaceAll('"', "&quot;")}</code>`;
const captures = [
  { url: "https://www.linkedin.com/company/acme/jobs/", body: island },
  { url: "https://www.linkedin.com/voyager/api/graphql?org", body: JSON.stringify({ included: [{ entityUrn: company }] }) },
];
function setup(noStore = false) {
  const deps: CompanyJobsDeps = { storeConfigured: () => true, store: () => ({} as StoreClient),
    upsert: vi.fn(async (rows) => ({ rows: rows.length })), recordDrift: vi.fn(async () => 0),
    capture: vi.fn(async () => ({ captures, sessionUrns: [], result: { counts: { requested: 1, captured: 2, usable: 1, skipped: 0 } } })) };
  const ctx = { args: { url: "acme", limit: 1 }, flags: { noStore }, run: { runId: "run", paths: { raw: "/tmp/raw" }, log: vi.fn() } } as never;
  return { deps, ctx };
}
describe("company.jobs composition", () => {
  it("captures, parses and stores bounded subject jobs without returning identifiers", async () => {
    const { deps, ctx } = setup(); const got = await createCompanyJobsCapability(deps).run(ctx);
    expect(deps.upsert).toHaveBeenCalledWith([expect.objectContaining({ id: "101", company_urn: company })], expect.anything());
    expect(got.stored).toEqual({ table: "jobs", run_ref: "run", rows: 1 });
    expect(JSON.stringify(got)).not.toContain(company); expect(JSON.stringify(got)).not.toContain("101");
  });
  it("keeps capture and parse active under --no-store", async () => {
    const { deps, ctx } = setup(true); const got = await createCompanyJobsCapability(deps).run(ctx);
    expect(deps.capture).toHaveBeenCalledOnce(); expect(deps.upsert).not.toHaveBeenCalled(); expect(got.stored).toBeUndefined();
  });
});
