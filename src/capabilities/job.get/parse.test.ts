import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDirFor } from "../profile.capture/fixture.test-helper.js";
import { parseJobSnapshot } from "./parse.js";

const ID = "4450930857";
const URL = `https://www.linkedin.com/jobs/view/${ID}/`;
const fixtureDir = fixturesDirFor("job.get");
const fixtureFile = existsSync(fixtureDir)
  ? readdirSync(fixtureDir).sort().find((file) => file.endsWith("-dom-snapshot.html"))
  : undefined;
const fixture = fixtureFile === undefined ? null : readFileSync(join(fixtureDir, fixtureFile), "utf8");
if (fixture === null) process.stderr.write("\n[skip] job parser fixture test — fixtures/job.get has no promoted DOM snapshot.\n");

function synthetic(content: string, extra = ""): string {
  return `<html><body><a href="?entity=urn%3Ali%3Afsd_jobPosting%3A${ID}">report</a>${extra}<section><h2>About the job</h2><p><span data-testid="expandable-text-box"></span>Opening sentence.</p>${content}</section></body></html>`;
}

describe("parseJobSnapshot", () => {
  it.skipIf(fixture === null)("reads the full description from the promoted outerHTML and tags it DOM-sourced", () => {
    if (fixture === null) return;
    const parsed = parseJobSnapshot(fixture, { url: URL });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.source).toBe("dom-snapshot");
    expect(parsed.job.value.description).toContain("We're hiring a Full Stack Developer.");
    expect(parsed.job.value.description).toContain("Let's build it together.");
    expect(parsed.job.value.description!.length).toBeGreaterThan(500);
  });

  it("stores nothing when the normalized URL and document urn disagree", () => {
    expect(parseJobSnapshot(synthetic("<p>Body</p>"), { url: "https://www.linkedin.com/jobs/view/9999999999/" }).ok).toBe(false);
  });

  it("accepts the target when recommendation rails name other jobs", () => {
    const html = synthetic("<p>Body</p>", '<a href="?entity=urn%3Ali%3Afsd_jobPosting%3A9999999999">more job</a>');
    expect(parseJobSnapshot(html, { url: URL }).ok).toBe(true);
  });

  it("keeps opening text and bullet-list content without relying on child position", () => {
    const parsed = parseJobSnapshot(synthetic("<ul><li>TypeScript</li><li>Postgres</li></ul><p>Closing.</p>"), { url: URL });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.job.value.description).toBe("Opening sentence.\n- TypeScript\n- Postgres\nClosing.");
  });

  it("refuses every unscoped company urn, including a session/trap-shaped candidate", () => {
    const company = "urn:li:fsd_company:12345";
    const withCompany = synthetic("<p>Body</p>", `<aside data-x="${company}">recommendation</aside>`);
    const accepted = parseJobSnapshot(withCompany, { url: URL });
    expect(accepted.ok && accepted.job.value).not.toHaveProperty("company_urn");
    expect(accepted.warnings).toContainEqual({ code: "PARSE_COMPANY_IDENTITY_REFUSED", field: "company_urn", n: 1 });
  });
});
