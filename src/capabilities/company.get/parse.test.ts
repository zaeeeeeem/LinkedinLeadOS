import { describe, expect, it } from "vitest";
import { MAX_COMPANY_FIELD_CHARS, parseCompanyCaptures, type CompanyCapture } from "./parse.js";

const urn = "urn:li:fsd_company:42";
const vanity = "acme";
function island(value: unknown): string {
  return `<code id="bpr-guid-1">${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</code>`;
}
function captures(o: { voyager?: Record<string, unknown>; embedded?: Record<string, unknown> } = {}): CompanyCapture[] {
  const voyager = { entityUrn: urn, name: "Acme", url: "https://www.linkedin.com/company/acme/", ...o.voyager };
  const embedded = { entityUrn: urn, universalName: vanity, ...o.embedded };
  return [
    { url: "https://www.linkedin.com/voyager/api/graphql", body: JSON.stringify({ included: [voyager] }) },
    { url: "https://www.linkedin.com/company/acme/", body: island({ included: [embedded] }) },
  ];
}

describe("parseCompanyCaptures — pure contracts", () => {
  it("falls back to the legal Big Pipe name when the Voyager record is a stub", () => {
    const result = parseCompanyCaptures(captures({ voyager: { name: undefined }, embedded: { name: "Island Acme" } }), { targetVanity: vanity, sessionUrns: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.value.name).toBe("Island Acme");
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ field: "name" }));
  });

  it("accepts an exact numeric target id without laundering that id into vanity", () => {
    const result = parseCompanyCaptures(captures({
      voyager: { url: undefined }, embedded: { universalName: "renamed-company" },
    }), { targetVanity: "42", sessionUrns: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.value.urn).toBe(urn);
    expect(result.company.value.vanity).toBeUndefined();
  });

  it("uses the real slug from a numeric target's Voyager company URL", () => {
    const result = parseCompanyCaptures(captures({ embedded: { universalName: "renamed-company" } }), { targetVanity: "42", sessionUrns: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.company.value.vanity).toBe("acme");
  });

  it("emits typed drift when a required name is absent from both sources", () => {
    const result = parseCompanyCaptures(captures({ voyager: { name: undefined }, embedded: { name: undefined } }), { targetVanity: vanity, sessionUrns: [] });
    expect(result.ok).toBe(true);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_FIELD_MISSING", field: "name", exit: 5 }));
  });

  it("truncates an over-bound about field and reports exactly what was dropped", () => {
    const result = parseCompanyCaptures(captures({ embedded: { description: "x".repeat(MAX_COMPANY_FIELD_CHARS + 17) } }), { targetVanity: vanity, sessionUrns: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.value.about).toHaveLength(MAX_COMPANY_FIELD_CHARS);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_FIELD_TRUNCATED", field: "about", n: 17, exit: 5 }));
  });

  it("bounds captured bodies and reports the exact remainder", () => {
    const result = parseCompanyCaptures([...captures(), ...Array.from({ length: 260 }, (_, i) => ({ url: `https://example.invalid/${i}`, body: "{}" }))], { targetVanity: vanity, sessionUrns: [] });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_INPUT_TRUNCATED", field: "captures", n: 6, exit: 5 }));
  });

  it("bounds a JSON walk and makes the incomplete walk visible", () => {
    const result = parseCompanyCaptures([...captures(), { url: "https://example.invalid/huge", body: JSON.stringify(Array.from({ length: 200_001 }, () => null)) }], { targetVanity: vanity, sessionUrns: [] });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_INPUT_TRUNCATED", field: "nodes", exit: 5 }));
  });
});
