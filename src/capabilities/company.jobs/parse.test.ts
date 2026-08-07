import { describe, expect, it } from "vitest";
import {
  MAX_COMPANY_JOB_FIELD_CHARS, MAX_COMPANY_JOB_NODES, canonicalJobId,
  parseCompanyJobs, type CompanyCapture,
} from "./parse.js";

const company = "urn:li:fsd_company:42";
function island(value: unknown) {
  return `<code id="bpr-guid-1">${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</code>`;
}
function job(id: string, o: { company?: string; title?: unknown; description?: string; listedAt?: unknown } = {}) {
  return {
    entityUrn: `urn:li:fsd_jobPosting:${id}`,
    companyDetails: { jobCompany: { "*company": o.company ?? company } },
    "*location": "urn:li:fsd_geo:1", jobState: "LISTED",
    ...(o.title === undefined ? { title: `Role ${id}` } : { title: o.title }),
    ...(o.listedAt === undefined ? { listedAt: 1_700_000_000_000 } : { listedAt: o.listedAt }),
    description: { text: o.description ?? "Full labeled description" },
  };
}
function captures(values: unknown[]): CompanyCapture[] {
  return [
    { url: "https://www.linkedin.com/company/acme/jobs/", body: island({ included: [{ entityUrn: company, universalName: "acme" }, { entityUrn: "urn:li:fsd_geo:1", fullLocalizedName: "Remote" }, ...values] }) },
    { url: "https://www.linkedin.com/voyager/api/graphql?org", body: JSON.stringify({ included: [{ entityUrn: company }] }) },
  ];
}
const parse = (values: unknown[], limit = 100) => parseCompanyJobs(captures(values), { targetVanity: "acme", sessionUrns: [], limit });

describe("parseCompanyJobs — pure contracts", () => {
  it("accepts only LISTED value records explicitly scoped to the subject company", () => {
    const got = parse([job("101"), job("102", { company: "urn:li:fsd_company:99" }), { entityUrn: "urn:li:fsd_jobPosting:103", trackingUrn: "urn:li:jobPosting:103", title: "stub" }]);
    expect(got.jobs.map((row) => row.id)).toEqual(["101"]);
  });
  it("canonicalizes only exact recognized job urns to decimal ids", () => {
    expect(canonicalJobId("urn:li:fsd_jobPosting:123")).toBe("123");
    expect(canonicalJobId("urn:li:jobPosting:123")).toBe("123");
    expect(canonicalJobId("123")).toBeNull();
    expect(canonicalJobId("urn:li:fsd_jobPosting:123:trap")).toBeNull();
  });
  it("keeps measured list fields and leaves Task 31-only workplace_type absent", () => {
    const got = parse([job("101")]);
    expect(got.jobs[0]).toEqual({ id: "101", company_urn: company, title: "Role 101", location: "Remote", posted_at: "2023-11-14T22:13:20.000Z", description: "Full labeled description" });
    expect(got.jobs[0]).not.toHaveProperty("workplace_type");
  });
  it("warns on a missing labeled field and never substitutes another value", () => {
    const got = parse([job("101", { title: null })]);
    expect(got.jobs[0]).not.toHaveProperty("title");
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_FIELD_MISSING", field: "title", exit: 5 }));
  });
  it("stops capture work when the accepted limit is reached", () => {
    const got = parse([job("101"), job("102")], 1);
    expect(got.jobs).toHaveLength(1); expect(got.inspectedPostings).toBe(1);
  });
  it("reports company-scope drift instead of a silent empty result", () => {
    const got = parse([job("101", { company: "urn:li:fsd_company:99" })]);
    expect(got.jobs).toEqual([]);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_SCOPE_UNMATCHED", field: "job_company", exit: 5 }));
  });
  it("truncates an oversized field with typed exit-5 drift", () => {
    const got = parse([job("101", { description: "x".repeat(MAX_COMPANY_JOB_FIELD_CHARS + 4) })]);
    expect(got.jobs[0]?.description).toHaveLength(MAX_COMPANY_JOB_FIELD_CHARS);
    expect(got.warnings).toContainEqual(expect.objectContaining({ field: "description", n: 4, exit: 5 }));
  });
  it("bounds capture bodies", () => {
    const got = parseCompanyJobs([...captures([job("101")]), ...Array.from({ length: 130 }, () => ({ url: "https://x.invalid", body: "{}" }))], { targetVanity: "acme", sessionUrns: [], limit: 1 });
    expect(got.warnings).toContainEqual(expect.objectContaining({ field: "captures", exit: 5 }));
  });
  it("bounds decoded JSON nodes", () => {
    const huge = { url: "https://www.linkedin.com/voyager/api/graphql", body: JSON.stringify(Array.from({ length: MAX_COMPANY_JOB_NODES + 1 }, () => null)) };
    const got = parseCompanyJobs([...captures([job("101")]), huge], { targetVanity: "acme", sessionUrns: [], limit: 2 });
    expect(got.warnings).toContainEqual(expect.objectContaining({ field: "nodes", exit: 5 }));
  });

  it("calls a renamed listedAt drift, not a company with no openings", () => {
    const posting = { entityUrn: "urn:li:fsd_jobPosting:1", postedOn: 1, jobState: "LISTED", title: "Eng", companyDetails: { jobCompany: { "*company": company } } };
    const got = parseCompanyJobs([
      { url: "https://www.linkedin.com/company/acme/jobs/", body: island({ included: [{ entityUrn: company, universalName: "acme" }, posting] }) },
      { url: "https://www.linkedin.com/voyager/api/graphql?org", body: JSON.stringify({ included: [{ entityUrn: company, name: "Acme" }] }) },
    ], { targetVanity: "acme", sessionUrns: [], limit: 100 });
    expect(got.jobs).toEqual([]);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_SCOPE_UNMATCHED", field: "job_posting_shape", exit: 5 }));
  });

  it("stays silent when the company simply lists no jobs", () => {
    const got = parseCompanyJobs([
      { url: "https://www.linkedin.com/company/acme/jobs/", body: island({ included: [{ entityUrn: company, universalName: "acme" }] }) },
      { url: "https://www.linkedin.com/voyager/api/graphql?org", body: JSON.stringify({ included: [{ entityUrn: company, name: "Acme" }] }) },
    ], { targetVanity: "acme", sessionUrns: [], limit: 100 });
    expect(got.jobs).toEqual([]);
    expect(got.warnings.filter((w) => w.code === "PARSE_SCOPE_UNMATCHED")).toEqual([]);
  });
});
