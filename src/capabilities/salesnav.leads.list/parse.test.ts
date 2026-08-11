import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SALESNAV_BADGES_PER_ROW, MAX_SALESNAV_POSITIONS_PER_LEAD, MAX_SALESNAV_ROWS_PER_PAGE, parseSalesNavLeads } from "./parse.js";

const PAGE_ONE = join(process.cwd(), "fixtures/salesnav.probe/f371faaa3af8763b.json");
const PAGE_TWO = join(process.cwd(), "fixtures/salesnav.probe/3c9b9e47745e55bd.json");
const present = existsSync(PAGE_ONE) && existsSync(PAGE_TWO);
const suite = present ? describe : describe.skip;
const load = (path: string) => readFileSync(path, "utf8");

suite("salesnav.leads.list body parser", () => {
  it("parses the measured full page with page-relative provenance", () => {
    const got = parseSalesNavLeads(load(PAGE_TWO));
    expect(got.paging).toMatchObject({ count: 25, start: 25, page: 2 });
    expect(got.rows).toHaveLength(25);
    expect(got.refused).toBe(0);
    expect(got.rows.map((row) => row.position)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(got.rows.map((row) => row.page))).toEqual(new Set([2]));
  });

  it("accepts a short last page without inventing the missing position", () => {
    const body = JSON.parse(load(PAGE_ONE)) as { elements: unknown[]; paging: { total: number; count: number; start: number } };
    body.paging = { total: body.elements.length, count: 25, start: 0 };
    const got = parseSalesNavLeads(JSON.stringify(body));
    expect(got.rows).toHaveLength(body.elements.length);
    expect(got.rows.at(-1)?.position).toBe(body.elements.length);
    expect(got.paging).toMatchObject({ total: body.elements.length, page: 1 });
  });

  it("pins every mapped lead field by meaning, including optional company urns", () => {
    const got = parseSalesNavLeads(load(PAGE_ONE));
    expect(got.rows.length).toBeGreaterThan(0);
    for (const row of got.rows) {
      expect(row.source).toBe("labeled-body");
      expect(row.person_urn).toMatch(/^urn:li:member:\d+$/);
      expect(row.sales_profile_urn).toMatch(/^urn:li:fs_salesProfile:\(/);
      const profileId = /^urn:li:fs_salesProfile:\(([^,]+),/.exec(row.sales_profile_urn)?.[1];
      expect(row.profile_url).toContain(`/sales/lead/${profileId},`);
      expect(row.full_name.replace(/\s+/g, " ")).toBe(`${row.first_name} ${row.last_name}`.replace(/\s+/g, " "));
      expect(row.location.length).toBeGreaterThan(0);
      expect(Number.isInteger(row.degree)).toBe(true);
      expect(Number.isInteger(row.list_count)).toBe(true);
      expect(typeof row.tracking_id).toBe("string");
      for (const flag of [row.saved, row.viewed, row.premium, row.open_link, row.memorialized, row.pending_invitation, row.block_third_party_data_sharing]) expect(typeof flag).toBe("boolean");
      expect(row.profile_picture.artifacts).toBeGreaterThan(0);
      expect(Array.isArray(row.spotlight_badges)).toBe(true);
      expect(row.current_positions.length).toBeGreaterThan(0);
      for (const position of row.current_positions) {
        expect(position.company_name.length).toBeGreaterThan(0);
        expect(position.title.length).toBeGreaterThan(0);
        expect(Number.isInteger(position.position_id)).toBe(true);
        if (position.company_urn !== undefined) {
          expect(position.company_urn).toMatch(/^urn:li:fs_salesCompany:\d+$/);
          expect(position.company_url).toBe(`https://www.linkedin.com/sales/company/${position.company_urn.split(":").at(-1)}`);
        }
      }
    }
    expect(got.rows.some((row) => row.headline === undefined)).toBe(true);
    expect(got.rows.flatMap((row) => row.current_positions).some((position) => position.company_urn === undefined)).toBe(true);
  });

  it("refuses a session identity and stores no row for it", () => {
    const body = JSON.parse(load(PAGE_ONE)) as { elements: Array<Record<string, unknown>> };
    const sessionUrn = body.elements[0]!["objectUrn"] as string;
    const got = parseSalesNavLeads(JSON.stringify(body), { sessionUrns: [sessionUrn] });
    expect(got.refused).toBe(1);
    expect(got.rows.some((row) => row.person_urn === sessionUrn)).toBe(false);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_ROW_REFUSED" }));
  });

  it("refuses the compound entity identity when its profile id is the session's", () => {
    const body = JSON.parse(load(PAGE_ONE)) as { elements: Array<Record<string, unknown>> };
    const entity = body.elements[0]!["entityUrn"] as string;
    const profileId = /^urn:li:fs_salesProfile:\(([^,]+),/.exec(entity)![1]!;
    const got = parseSalesNavLeads(JSON.stringify(body), { sessionUrns: [`urn:li:fsd_profile:${profileId}`] });
    expect(got.refused).toBe(1);
    expect(got.rows.some((row) => row.sales_profile_urn === entity)).toBe(false);
  });

  it("bounds the result array even when the body claims more rows", () => {
    const body = JSON.parse(load(PAGE_TWO)) as { elements: unknown[]; paging: { count: number } };
    body.elements.push(...body.elements.slice(0, 5));
    const got = parseSalesNavLeads(JSON.stringify(body));
    expect(got.rows).toHaveLength(MAX_SALESNAV_ROWS_PER_PAGE);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_INPUT_TRUNCATED", field: "elements", n: 5 }));
  });

  it("bounds nested positions and badges and makes both losses visible", () => {
    const body = JSON.parse(load(PAGE_ONE)) as { elements: Array<Record<string, unknown>> };
    const row = body.elements[0]!;
    const position = (row["currentPositions"] as unknown[])[0]!;
    row["currentPositions"] = Array.from({ length: MAX_SALESNAV_POSITIONS_PER_LEAD + 2 }, () => position);
    const badge = (row["spotlightBadges"] as unknown[])[0] ?? { id: "TEST" };
    row["spotlightBadges"] = Array.from({ length: MAX_SALESNAV_BADGES_PER_ROW + 3 }, () => badge);
    const got = parseSalesNavLeads(JSON.stringify(body));
    expect(got.rows[0]!.current_positions).toHaveLength(MAX_SALESNAV_POSITIONS_PER_LEAD);
    expect(got.rows[0]!.spotlight_badges).toHaveLength(MAX_SALESNAV_BADGES_PER_ROW);
    expect(got.warnings).toContainEqual(expect.objectContaining({ field: "currentPositions", n: 2 }));
    expect(got.warnings).toContainEqual(expect.objectContaining({ field: "spotlightBadges", n: 3 }));
  });

  it("refuses drifted paging rather than guessing a page", () => {
    const body = JSON.parse(load(PAGE_ONE)) as { paging: { start: number } };
    body.paging.start = 1;
    expect(parseSalesNavLeads(JSON.stringify(body))).toMatchObject({ rows: [], paging: null, warnings: [expect.objectContaining({ code: "PARSE_PAGING_INVALID" })] });
  });
});

describe("salesnav leads fixture bookkeeping", () => {
  it("makes an absent fixture skip visible", () => expect(present || !existsSync(PAGE_ONE) || !existsSync(PAGE_TWO)).toBe(true));
});
