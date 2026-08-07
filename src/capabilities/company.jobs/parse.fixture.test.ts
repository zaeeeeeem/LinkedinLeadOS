import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDirFor } from "../profile.capture/fixture.test-helper.js";
import { parseCompanyJobs, type CompanyCapture } from "./parse.js";

const jobsDir = fixturesDirFor("company.jobs");
const document = join(jobsDir, "438312a3d613045a-document.html");
const companyDir = fixturesDirFor("company.get");
const org = join(companyDir, "ffbecb25cb3b8d81.json");
const fixtureIt = [document, org].every(existsSync) ? it : it.skip;
describe("parseCompanyJobs — measured fixture", () => {
  fixtureIt("pins nine subject-scoped LISTED values and excludes ten unscoped stubs", () => {
    const captures: CompanyCapture[] = [
      { url: "https://www.linkedin.com/company/wisprflow/jobs/", body: readFileSync(document, "utf8") },
      { url: "https://www.linkedin.com/voyager/api/graphql?org", body: readFileSync(org, "utf8") },
    ];
    const got = parseCompanyJobs(captures, { targetVanity: "wisprflow", sessionUrns: [], limit: 100 });
    expect(got.ok).toBe(true); if (!got.ok) return;
    expect(got.jobs).toHaveLength(9); expect(new Set(got.jobs.map((row) => row.id))).toHaveLength(9);
    expect(got.jobs.every((row) => /^\d+$/.test(row.id) && row.company_urn === got.companyUrn)).toBe(true);
    expect(got.jobs.every((row) => row.title && row.location && row.posted_at && row.description)).toBe(true);
    expect(got.jobs.every((row) => !("workplace_type" in row))).toBe(true);
  });
});
