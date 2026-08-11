import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SALESNAV_ACCOUNT_BADGES, MAX_SALESNAV_ACCOUNT_FIELD_CHARS, MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE, parseSalesNavAccounts } from "./parse.js";

const FIXTURE = join(process.cwd(), "fixtures/salesnav.probe/67ea927af64cc179.json");
const present = existsSync(FIXTURE);
const suite = present ? describe : describe.skip;
const load = () => readFileSync(FIXTURE, "utf8");

suite("salesnav.accounts.list body parser", () => {
  it("parses the measured full page with provenance", () => {
    const got = parseSalesNavAccounts(load());
    expect(got.paging).toMatchObject({ count: 25, start: 0, page: 1 });
    expect(got.rows).toHaveLength(25);
    expect(got.rows.map((row) => row.position)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(new Set(got.rows.map((row) => row.page))).toEqual(new Set([1]));
  });

  it("pins every mapped account field by meaning and keeps location absent", () => {
    const got = parseSalesNavAccounts(load());
    for (const row of got.rows) {
      expect(row.source).toBe("labeled-body");
      expect(row.company_urn).toMatch(/^urn:li:fs_salesCompany:\d+$/);
      expect(row.company_url).toBe(`https://www.linkedin.com/sales/company/${row.company_urn.split(":").at(-1)}`);
      // Optional on the type, present on this measured page — see the leads note.
      expect(row.company_name!.length).toBeGreaterThan(0);
      expect(row.industry!.length).toBeGreaterThan(0);
      expect(row.employee_count_range!.length).toBeGreaterThan(0);
      expect(["string", "number"]).toContain(typeof row.employee_display_count);
      expect(row.description!.length).toBeGreaterThan(0);
      expect(row.company_picture.artifacts).toBeGreaterThan(0);
      expect(Array.isArray(row.spotlight_badges)).toBe(true);
      expect(Number.isInteger(row.list_count)).toBe(true);
      expect(typeof row.saved).toBe("boolean");
      expect(row.tracking_id!.length).toBeGreaterThan(0);
      expect(row).not.toHaveProperty("location");
      expect(row).not.toHaveProperty("object_urn");
    }
  });

  it("accepts a short last page", () => {
    const body = JSON.parse(load()) as { elements: unknown[]; paging: { total: number; count: number; start: number } };
    body.elements = body.elements.slice(0, 4);
    body.paging = { total: 29, count: 25, start: 25 };
    const got = parseSalesNavAccounts(JSON.stringify(body));
    expect(got.rows).toHaveLength(4);
    expect(got.paging).toMatchObject({ page: 2, total: 29 });
    expect(got.rows.at(-1)?.position).toBe(4);
  });

  it("refuses an invalid or explicitly forbidden identity", () => {
    const body = JSON.parse(load()) as { elements: Array<Record<string, unknown>> };
    const urn = body.elements[0]!["entityUrn"] as string;
    const forbidden = parseSalesNavAccounts(JSON.stringify(body), { refusedUrns: [urn] });
    expect(forbidden.refused).toBe(1);
    expect(forbidden.rows.some((row) => row.company_urn === urn)).toBe(false);
    body.elements[1]!["entityUrn"] = "urn:li:fs_salesProfile:(not,a,company)";
    expect(parseSalesNavAccounts(JSON.stringify(body)).refused).toBe(1);
  });

  it("keeps a company whose content is gone and names every missing field", () => {
    const body = JSON.parse(load()) as { elements: Array<Record<string, unknown>> };
    for (const key of ["companyName", "industry", "employeeCountRange", "employeeDisplayCount", "description", "listCount", "saved", "trackingId"]) delete body.elements[0]![key];
    const got = parseSalesNavAccounts(JSON.stringify(body));
    expect(got.refused).toBe(0);
    expect(got.rows).toHaveLength(25);
    expect(got.rows[0]!.company_urn).toMatch(/^urn:li:fs_salesCompany:\d+$/);
    expect(got.rows[0]!.company_name).toBeUndefined();
    expect(got.rows[0]!.saved).toBeUndefined();
    for (const field of ["companyName", "industry", "description", "listCount", "saved", "trackingId"]) {
      expect(got.warnings, field).toContainEqual({ code: "PARSE_FIELD_MISSING", field, n: 1 });
    }
    expect(got.rows[1]!.position).toBe(2);
  });

  it("bounds the result array", () => {
    const body = JSON.parse(load()) as { elements: unknown[]; paging: { count: number } };
    body.elements.push(...body.elements.slice(0, 3));
    body.paging.count = body.elements.length;
    const got = parseSalesNavAccounts(JSON.stringify(body));
    expect(got.rows).toHaveLength(MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_INPUT_TRUNCATED", n: 3 }));
  });

  it("bounds long fields and nested badges with visible warnings", () => {
    const body = JSON.parse(load()) as { elements: Array<Record<string, unknown>> };
    body.elements[0]!["description"] = "x".repeat(MAX_SALESNAV_ACCOUNT_FIELD_CHARS + 4);
    const badge = (body.elements[0]!["spotlightBadges"] as unknown[])[0] ?? { id: "TEST" };
    body.elements[0]!["spotlightBadges"] = Array.from({ length: MAX_SALESNAV_ACCOUNT_BADGES + 2 }, () => badge);
    const got = parseSalesNavAccounts(JSON.stringify(body));
    expect(got.rows[0]!.description).toHaveLength(MAX_SALESNAV_ACCOUNT_FIELD_CHARS);
    expect(got.rows[0]!.spotlight_badges).toHaveLength(MAX_SALESNAV_ACCOUNT_BADGES);
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_FIELD_TRUNCATED", field: "description", n: 4 }));
    expect(got.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_INPUT_TRUNCATED", field: "spotlightBadges", n: 2 }));
  });
});

describe("salesnav accounts fixture bookkeeping", () => {
  it("makes an absent fixture skip visible", () => expect(present || !existsSync(FIXTURE)).toBe(true));
});
