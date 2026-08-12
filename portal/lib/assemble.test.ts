// portal/lib/assemble.test.ts
import { describe, expect, it } from "vitest";
import { assembleDossierData, assembleLeadList } from "./assemble";
import type { LeadDetailRaw, LeadRowRaw } from "./queries";

function row(overrides: Partial<LeadRowRaw> = {}): LeadRowRaw {
  return {
    personUrn: "urn:li:fsd_profile:X1",
    name: "Jane Doe",
    headline: null,
    location: "Austin, TX",
    companyUrn: null,
    companyName: null,
    hasExperience: false,
    hasPosts: false,
    status: null,
    contactedAt: null,
    searchLabel: "US SaaS VPs 11-50",
    searchCapturedAt: "2026-08-01T00:00:00+00:00",
    lastActivity: "2026-08-01T00:00:00+00:00",
    ...overrides,
  };
}

describe("assembleLeadList", () => {
  it("a lead with only a search row is depth 1, status new, needsResearch true", () => {
    const [item] = assembleLeadList([row()], new Date("2026-08-12T00:00:00Z"));
    expect(item.depth).toBe(1);
    expect(item.status).toBe("new");
    expect(item.needsResearch).toBe(true);
  });

  it("a lead with experience rows and stored status new is effective enriched, needsResearch false", () => {
    const [item] = assembleLeadList(
      [row({ hasExperience: true, status: "new" })],
      new Date("2026-08-12T00:00:00Z"),
    );
    expect(item.status).toBe("enriched");
    expect(item.depth).toBe(3);
    expect(item.needsResearch).toBe(false);
  });

  it("a lead contacted 5 days before now yields contactedDaysAgo: 5", () => {
    const now = new Date("2026-08-12T00:00:00Z");
    const [item] = assembleLeadList(
      [row({ status: "contacted", contactedAt: "2026-08-07T00:00:00Z" })],
      now,
    );
    expect(item.contactedDaysAgo).toBe(5);
  });

  it("contactedDaysAgo is null when there is no contacted_at", () => {
    const [item] = assembleLeadList([row()], new Date("2026-08-12T00:00:00Z"));
    expect(item.contactedDaysAgo).toBeNull();
  });

  it("duplicate search rows for one person collapse to one list item, keeping the newest search label", () => {
    const items = assembleLeadList(
      [
        row({ searchLabel: "Older search", searchCapturedAt: "2026-08-01T00:00:00+00:00" }),
        row({ searchLabel: "Newer search", searchCapturedAt: "2026-08-10T00:00:00+00:00" }),
      ],
      new Date("2026-08-12T00:00:00Z"),
    );
    expect(items).toHaveLength(1);
    expect(items[0].searchLabel).toBe("Newer search");
  });
});

function detail(overrides: Partial<LeadDetailRaw> = {}): LeadDetailRaw {
  return {
    person: {
      urn: "urn:li:fsd_profile:X1",
      name: "Jane Doe",
      headline: "VP Eng",
      location: "Austin, TX",
      vanity: "janedoe",
      lastSeen: "2026-08-12",
    },
    status: "enriched",
    note: "warm intro possible",
    experience: [{ title: "VP Engineering", companyName: "Acme", isCurrent: true }],
    posts: [],
    companyUrn: "urn:li:company:C1",
    company: {
      name: "Acme",
      sizeRange: "11-50",
      industry: "SaaS",
      hq: "Austin",
      website: "acme.com",
      about: "We do things",
      lastSeen: "2026-08-10",
    },
    companyPosts: [],
    jobs: [],
    hasCompanyPeople: false,
    foundBy: { label: "US SaaS VPs 11-50", capturedAt: "2026-08-12" },
    rawPaths: ["runs/01ABC/raw/profile.json.gz"],
    ...overrides,
  };
}

describe("assembleDossierData", () => {
  it("fills missing correctly: no posts means 'activity (D4)' is present", () => {
    const d = assembleDossierData(detail());
    expect(d.missing).toContain("activity (D4)");
    expect(d.missing).not.toContain("SN profile (D2)");
    expect(d.missing).not.toContain("full profile (D3)");
  });

  it("also names uncaptured company levels, person-then-company ascending", () => {
    const d = assembleDossierData(detail());
    // company has detail (sizeRange/industry/about) but no posts/jobs -> C2 reached, C3 missing.
    expect(d.missing).toEqual(["activity (D4)", "company activity (C3)"]);
  });

  it("omits company-missing labels entirely when the lead has no company urn", () => {
    const d = assembleDossierData(detail({ companyUrn: null, company: null }));
    expect(d.missing.some((m) => m.startsWith("company"))).toBe(false);
  });

  it("company_people presence alone counts toward C3 activity, even with no posts/jobs", () => {
    const d = assembleDossierData(detail({ hasCompanyPeople: true }));
    expect(d.company?.depth).toBe(3);
    expect(d.missing).not.toContain("company activity (C3)");
  });

  it("passes raw paths through verbatim", () => {
    const d = assembleDossierData(detail());
    expect(d.rawPaths).toEqual(["runs/01ABC/raw/profile.json.gz"]);
  });

  it("computes person depth and effective status from raw presence", () => {
    const d = assembleDossierData(detail({ status: "new" }));
    expect(d.depth).toBe(3); // has experience, no posts
    expect(d.status).toBe("enriched");
  });

  it("passes person, foundBy, note through verbatim", () => {
    const d = assembleDossierData(detail());
    expect(d.person.name).toBe("Jane Doe");
    expect(d.foundBy).toEqual({ label: "US SaaS VPs 11-50", capturedAt: "2026-08-12" });
    expect(d.note).toBe("warm intro possible");
  });
});
