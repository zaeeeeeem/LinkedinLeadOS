import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RawArchive } from "../src/core/archive/raw.js";
import { promoteFixtures } from "../src/core/fixtures/promote.js";
import { domMapOf, familyOf, probesOf, relevanceOf, renderDomMapOf, subjectFor } from "../src/core/fixtures/families.js";

const JOB_ID = "4012345678";
const JOB_URL = `https://www.linkedin.com/jobs/view/${JOB_ID}/`;
const JOB_BODY = JSON.stringify({
  data: { entityUrn: `urn:li:fsd_jobPosting:${JOB_ID}`, title: "Senior Engineer", formattedLocation: "Austin, TX" },
});
/** Another posting entirely — the "similar jobs" body every job page carries. */
const OTHER_JOB_BODY = JSON.stringify({
  data: { entityUrn: "urn:li:fsd_jobPosting:9999999999", title: "Someone else's role" },
});
const PERSON_BODY = JSON.stringify({ data: { entityUrn: "urn:li:fsd_profile:ACwAAA", firstName: "Jane" } });

let root: string;
let archiveDir: string;
let fixturesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "families-"));
  archiveDir = join(root, "raw");
  fixturesDir = join(root, "fixtures", "job.get");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("familyOf", () => {
  it("routes the job capabilities to the job family and everything else to profile", () => {
    expect(familyOf("job.get")).toBe("job");
    expect(familyOf("job.capture")).toBe("job");
    expect(familyOf("profile.get")).toBe("profile");
    // The conservative direction: an unknown name promotes less, not more.
    expect(familyOf("company.get")).toBe("profile");
    expect(familyOf("")).toBe("profile");
  });
});

describe("job DOM-map routing", () => {
  const html = `<html><body>
    <a href="/x?entity=urn%3Ali%3Afsd_jobPosting%3A${JOB_ID}">report</a>
    <section><h2>About the job</h2><p><span data-testid="expandable-text-box"></span></p><p>Build reliable systems.</p></section>
  </body></html>`;

  it("uses the job data-testid rule, not the profile card-ref rule", () => {
    const map = domMapOf("job", html);
    expect(map.scope).toMatchObject({ resolvedId: JOB_ID });
    expect(map.probes.find((p) => p.name === "description")?.hits[0]?.path).toBe('[data-testid="expandable-text-box"]');
    const rendered = renderDomMapOf("job", { file: "x.html", bytes: html.length, sourceRun: "r", map });
    expect(rendered).toContain("DOM-sourced job fixture");
    expect(rendered).not.toContain("No subject scope could be resolved");
  });

  it("reports every posting candidate so the parser can cross-check the requested target", () => {
    const map = domMapOf("job", html.replace("</body>", `urn:li:jobPosting:9999999999</body>`));
    expect(map.scope).toMatchObject({ resolvedId: null });
    expect("jobIds" in map.scope && map.scope.jobIds).toEqual([JOB_ID, "9999999999"]);
    const rendered = renderDomMapOf("job", { file: "x", bytes: 1, sourceRun: "r", map });
    expect(rendered).toContain("normalized requested URL");
    expect(rendered).not.toContain("Do not write a parser");
  });
});

describe("subjectFor", () => {
  it("turns a job url into both spellings a body may name it by (D260)", () => {
    expect(subjectFor("job", JOB_URL)).toEqual({ urns: [`urn:li:fsd_jobPosting:${JOB_ID}`, JOB_ID] });
    expect(subjectFor("job", JOB_ID)).toEqual({ urns: [`urn:li:fsd_jobPosting:${JOB_ID}`, JOB_ID] });
  });

  it("returns null rather than a guess for a url the family cannot read", () => {
    // The caller reports it: promoting with no subject falls back to "any
    // relevant body", which is the D118 failure.
    expect(subjectFor("job", "https://www.linkedin.com/jobs/collections/recommended/")).toBeNull();
    expect(subjectFor("job", "tankots")).toBeNull();
  });

  it("leaves the profile family's behaviour exactly as it was", () => {
    expect(subjectFor("profile", "https://www.linkedin.com/in/tankots/")).toEqual({ vanity: "tankots" });
    expect(subjectFor("profile", "tankots")).toEqual({ vanity: "tankots" });
    expect(subjectFor("profile", "https://example.com/")).toBeNull();
  });
});

describe("promoting a job archive with the job family's rules", () => {
  async function seed(bodies: Array<{ body: string; url: string }>): Promise<void> {
    const archive = new RawArchive(archiveDir);
    for (const b of bodies) await archive.archive({ body: b.body, url: b.url, status: 200 });
  }

  it("promotes the posting that was asked for and nothing else", async () => {
    await seed([
      { body: JOB_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashJobPostings.1" },
      { body: OTHER_JOB_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=similar" },
      { body: PERSON_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=identity" },
    ]);

    const family = familyOf("job.get");
    const result = await promoteFixtures({
      archiveDir,
      fixturesDir,
      capability: "job.get",
      sourceRun: "01JOBRUN",
      isRelevant: relevanceOf(family),
      subject: subjectFor(family, JOB_URL)!,
      ...(probesOf(family) === undefined ? {} : { probes: probesOf(family)! }),
      now: () => new Date("2026-08-09T10:00:00.000Z"),
    });

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]!.subject_match).toBe(true);
    // Another posting is job-ish but not *this* posting; a person body is
    // neither. Both are counted, not silently dropped.
    expect(result.skipped.not_subject).toBe(1);
    expect(result.skipped.not_profile).toBe(1);
    // Byte-identical to what came off the wire (D2).
    expect(readFileSync(join(fixturesDir, result.promoted[0]!.file), "utf8")).toBe(JOB_BODY);
  });

  it("builds the field map with the job probes, so §7's columns are what it looks for", async () => {
    await seed([{ body: JOB_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=jobs" }]);
    const family = familyOf("job.get");
    const result = await promoteFixtures({
      archiveDir, fixturesDir, capability: "job.get", sourceRun: "01JOBRUN",
      isRelevant: relevanceOf(family),
      subject: subjectFor(family, JOB_URL)!,
      probes: probesOf(family)!,
    });

    const map = readFileSync(result.fieldMapPath, "utf8");
    for (const probe of ["job_urn", "title", "location", "posted_at", "workplace_type", "description"]) {
      expect(map, probe).toContain(probe);
    }
    // A profile probe would mean the wrong family's map was generated.
    expect(map).not.toContain("position_company");
    // Present in the body: found. Absent from it: reported as not found rather
    // than assumed — which is the whole difference D152 draws.
    expect(map).toContain("$.data.title");
    expect(map).toMatch(/\*\*Not found in this body:\*\*[^\n]*`description`/);
  });
});
