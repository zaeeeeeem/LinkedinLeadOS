import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJobSnapshot } from "./parse.js";

const ID = "4450930857";
const URL = `https://www.linkedin.com/jobs/view/${ID}/`;
const fixture = readFileSync("/Users/talhat/Claude/Projects/StartupStruggle/LinkedinLeadsOS/fixtures/job.get/438312a3d613045a-dom-snapshot.html", "utf8");

describe("parseJobSnapshot", () => {
  it("reads the full description from the promoted outerHTML and tags it DOM-sourced", () => {
    const parsed = parseJobSnapshot(fixture, { url: URL });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.source).toBe("dom-snapshot");
    expect(parsed.job.value.description).toContain("We're hiring a Full Stack Developer.");
    expect(parsed.job.value.description).toContain("Let's build it together.");
    expect(parsed.job.value.description!.length).toBeGreaterThan(500);
  });

  it("stores nothing when the normalized URL and document urn disagree", () => {
    expect(parseJobSnapshot(fixture, { url: "https://www.linkedin.com/jobs/view/9999999999/" }).ok).toBe(false);
  });

  it("normalizes one company urn but refuses a session/trap urn", () => {
    const company = "urn:li:fsd_company:12345";
    const withCompany = fixture.replace("</body>", `<i data-x="${company}"></i></body>`);
    const accepted = parseJobSnapshot(withCompany, { url: URL });
    expect(accepted.ok && accepted.job.value.company_urn).toBe(company);
    const refused = parseJobSnapshot(withCompany, { url: URL, sessionUrns: [company] });
    expect(refused.ok && refused.job.value).not.toHaveProperty("company_urn");
    expect(refused.warnings).toContainEqual({ code: "PARSE_COMPANY_IDENTITY_REFUSED", field: "company_urn", n: 1 });
  });
});
