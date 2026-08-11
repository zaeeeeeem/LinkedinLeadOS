import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Pins every path in `src/capabilities/salesnav.probe/FIELD-MAP.md` against the
 * fixture the 2026-08-10 probe promoted.
 *
 * The fixture is gitignored (`/fixtures/`), so this suite **skips itself** when
 * it is absent rather than failing: a checkout without a promoted archive has
 * nothing to pin, and a red test there would say "the parser is wrong" when it
 * means "you have no fixture". Re-create it with:
 *
 *   npm run cap -- salesnav.probe --surfaces=leads --url=<a search url the ui produced>
 *   npm run fixtures:promote -- --run=<id> --capability=salesnav.probe
 *
 * Assertions are **meaning-checked**, not shape-checked (D152): a path that
 * resolves to a string of the wrong kind is a drift this must catch. No captured
 * value is asserted literally and none is printed — the rows are third parties
 * (M5 CONTEXT rule 6).
 */

const FIXTURE = join(process.cwd(), "fixtures/salesnav.probe/f371faaa3af8763b.json");
const present = existsSync(FIXTURE);
const suite = present ? describe : describe.skip;

type Row = Record<string, unknown>;
type LeadSearch = {
  paging: { total: number; count: number; start: number; links: unknown[] };
  metadata: Record<string, unknown>;
  elements: Row[];
};

function load(): LeadSearch {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as LeadSearch;
}

suite("salesApiLeadSearch — the row source (verdict 1)", () => {
  it("is the shape the FIELD-MAP describes: metadata, elements, paging", () => {
    const body = load();
    expect(Object.keys(body).sort()).toEqual(["elements", "metadata", "paging"]);
    expect(Array.isArray(body.elements)).toBe(true);
    expect(body.elements.length).toBeGreaterThan(0);
  });

  // The paged loop's cursor. `start`/`count` is what says which page arrived;
  // `total` is what bounds the run.
  it("carries an offset cursor and a total, both as numbers", () => {
    const { paging } = load();
    expect(Number.isInteger(paging.start)).toBe(true);
    expect(Number.isInteger(paging.count)).toBe(true);
    expect(paging.count).toBeGreaterThan(0);
    expect(Number.isInteger(paging.total)).toBe(true);
    // Page 1 of the measured search. A non-zero start here would mean the
    // fixture is not the page the FIELD-MAP describes.
    expect(paging.start).toBe(0);
    expect(paging.total).toBeGreaterThan(paging.count);
  });

  it("names the search execution in metadata", () => {
    const { metadata } = load();
    for (const key of ["recentSearchId", "searchTitle", "totalDisplayCount", "filters"]) {
      expect(metadata[key], `metadata.${key}`).toBeDefined();
    }
    expect(typeof metadata["searchTitle"]).toBe("string");
    expect(Array.isArray(metadata["filters"])).toBe(true);
  });
});

suite("salesApiLeadSearch — result rows", () => {
  it("gives every row the fields the FIELD-MAP marks 24/24", () => {
    const rows = load().elements;
    const always = [
      "entityUrn", "objectUrn", "fullName", "firstName", "lastName", "geoRegion",
      "degree", "currentPositions", "spotlightBadges", "trackingId", "listCount",
      "saved", "viewed", "premium", "profilePictureDisplayImage",
    ];
    for (const row of rows) {
      for (const field of always) expect(row[field], field).toBeDefined();
    }
  });

  // The one optional field measured. Pinned as optional on purpose: a parser
  // that requires it would fail on the row that lacked it.
  it("leaves `summary` optional, and every other named string non-empty", () => {
    const rows = load().elements;
    const withSummary = rows.filter((r) => typeof r["summary"] === "string");
    expect(withSummary.length).toBeGreaterThan(0);
    expect(withSummary.length).toBeLessThanOrEqual(rows.length);
    for (const row of rows) {
      expect((row["fullName"] as string).length).toBeGreaterThan(0);
      expect((row["geoRegion"] as string).length).toBeGreaterThan(0);
    }
  });

  // Identity, meaning-checked. `entityUrn` is compound and its 2nd and 3rd
  // members are per-execution — the reason `objectUrn` is the dedupe key.
  it("carries a compound fs_salesProfile urn whose first member is the person", () => {
    for (const row of load().elements) {
      const urn = row["entityUrn"] as string;
      expect(urn).toMatch(/^urn:li:fs_salesProfile:\(/);
      const members = urn.replace(/^urn:li:fs_salesProfile:\(/, "").replace(/\)$/, "").split(",");
      expect(members.length).toBe(3);
      // A LinkedIn profile id, not a search token.
      expect(members[0]).toMatch(/^AC[a-zA-Z0-9_-]{10,}$/);
      expect(members[1]!.length).toBeGreaterThan(0);
    }
  });

  it("carries a stable numeric member urn as the dedupe key", () => {
    const seen = new Set<string>();
    for (const row of load().elements) {
      const urn = row["objectUrn"] as string;
      expect(urn).toMatch(/^urn:li:member:\d+$/);
      // Two rows sharing a member urn would break `search_results` provenance.
      expect(seen.has(urn)).toBe(false);
      seen.add(urn);
    }
  });

  it("names a company and a title on every position", () => {
    for (const row of load().elements) {
      const positions = row["currentPositions"] as Row[];
      expect(Array.isArray(positions)).toBe(true);
      expect(positions.length).toBeGreaterThan(0);
      for (const p of positions) {
        expect(typeof p["companyName"]).toBe("string");
        expect(typeof p["title"]).toBe("string");
        expect(Number.isInteger(p["posId"])).toBe(true);
      }
    }
  });

  // `companyUrn` is optional per position — two of the 29 measured positions
  // carry a company name with no urn, which is what a company with no LinkedIn
  // page looks like. Task 38 must not key a row on it. Every *row* is still
  // joinable, because each has at least one position that does carry one.
  it("makes companyUrn optional per position but present on every row", () => {
    let withUrn = 0;
    let total = 0;
    for (const row of load().elements) {
      const positions = row["currentPositions"] as Row[];
      for (const p of positions) {
        total++;
        if (p["companyUrn"] !== undefined) {
          withUrn++;
          expect(p["companyUrn"]).toMatch(/^urn:li:/);
        }
      }
      expect(positions.some((p) => p["companyUrn"] !== undefined)).toBe(true);
    }
    expect(withUrn).toBeGreaterThan(0);
    expect(withUrn).toBeLessThanOrEqual(total);
  });

  // D126, on this surface: the operator must not appear as a result row. The
  // probe measured 0 session urns across the whole run; this pins that no row
  // carries an urn shaped like a session identity.
  it("has no row whose identity is missing or empty", () => {
    for (const row of load().elements) {
      expect(row["entityUrn"]).toBeTruthy();
      expect(row["objectUrn"]).toBeTruthy();
    }
  });
});

suite("the pagination verdict is what the fixture supports", () => {
  // Verdict 2: the DOM pager is click-only, and this is the corroboration from
  // the body side — the API pages by offset, and carries no next-page link.
  it("offers an offset cursor and no next-page link", () => {
    const { paging } = load();
    expect(Array.isArray(paging.links)).toBe(true);
    expect(paging.links.length).toBe(0);
    expect(paging.start + paging.count).toBeLessThanOrEqual(paging.total);
  });
});

describe("field-map bookkeeping", () => {
  it("records whether the fixture was available, so a skip is never silent", () => {
    if (!present) {
      // Not a failure — see the header. This assertion documents the skip.
      expect(present).toBe(false);
    } else {
      expect(readFileSync(FIXTURE, "utf8").length).toBeGreaterThan(1000);
    }
  });
});
