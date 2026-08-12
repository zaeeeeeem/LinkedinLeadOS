// portal/lib/dossier.test.ts
import { describe, expect, it } from "vitest";
import { buildDossier, type DossierData } from "./dossier";

const full: DossierData = {
  person: { urn: "urn:li:fsd_profile:X1", name: "Jane Doe", headline: "VP Eng",
            location: "Austin, TX", vanity: "janedoe", lastSeen: "2026-08-12" },
  status: "enriched", depth: 3,
  foundBy: { label: "US SaaS VPs 11-50", capturedAt: "2026-08-12" },
  experience: [{ title: "VP Engineering", companyName: "Acme", isCurrent: true }],
  posts: [{ postedAt: "2026-08-01", text: "Shipping is a feature", reactions: 14, comments: 3 }],
  company: { name: "Acme", sizeRange: "11-50", industry: "SaaS", hq: "Austin",
             website: "acme.com", about: "We do things", lastSeen: "2026-08-10", depth: 2 },
  companyPosts: [], jobs: [{ title: "Senior Backend Engineer", postedAt: "2026-08-02" }],
  note: "warm intro possible", rawPaths: ["runs/01ABC/raw/profile.json.gz"],
  missing: ["activity (D4)"],
};

describe("buildDossier full", () => {
  const md = buildDossier(full, "full");
  it("headline line carries name, title, company", () => {
    expect(md).toContain("# Jane Doe");
    expect(md).toContain("https://linkedin.com/in/janedoe");
  });
  it("uncaptured sections say not captured, never vanish silently", () => {
    expect(md).toContain("## Company posts");
    expect(md).toContain("not captured");
  });
  it("freshness footer always present, names what is missing", () => {
    expect(md).toContain("## Data freshness");
    expect(md).toContain("missing: activity (D4)");
  });
  it("raw archive paths listed for the agent to read directly", () => {
    expect(md).toContain("runs/01ABC/raw/profile.json.gz");
  });
  it("no LinkedIn url when vanity is unknown", () => {
    const noVanity = { ...full, person: { ...full.person, vanity: null } };
    expect(buildDossier(noVanity, "full")).not.toContain("linkedin.com/in/");
  });
  it("states 'Found by: not captured' rather than omitting the line when foundBy is null", () => {
    const noFoundBy = { ...full, foundBy: null };
    expect(buildDossier(noFoundBy, "full")).toContain("Found by: not captured");
  });
});

describe("buildDossier short", () => {
  const md = buildDossier(full, "short");
  it("keeps header, company, notes", () => {
    expect(md).toContain("# Jane Doe");
    expect(md).toContain("## Company: Acme");
    expect(md).toContain("warm intro possible");
  });
  it("drops posts and jobs", () => {
    expect(md).not.toContain("Shipping is a feature");
    expect(md).not.toContain("Senior Backend Engineer");
  });
  it("keeps the freshness footer", () => {
    expect(md).toContain("## Data freshness");
  });
});
