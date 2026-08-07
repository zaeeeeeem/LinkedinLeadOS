import { describe, expect, it } from "vitest";
import { MAX_COMPANY_POST_NODES, MAX_COMPANY_POST_TEXT_CHARS, parseCompanyPosts, postedAtFromActivityUrn, type CompanyCapture } from "./parse.js";

const company = "urn:li:fsd_company:42";
const activity = "urn:li:activity:7400000000000000000";
function island(value: unknown) { return `<code id="bpr-guid-1">${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</code>`; }
function update(o: { urn?: string; author?: string; authorKey?: "*companyName" | "*profileFullName"; text?: string; countsId?: string } = {}) {
  const urn = o.urn ?? activity; const countsId = o.countsId ?? "urn:li:ugcPost:999";
  const social = `urn:li:fsd_socialDetail:(${countsId},${urn})`; const counts = `urn:li:fsd_socialActivityCounts:${countsId}`;
  return [{ entityUrn: `ranked:${urn}`, metadata: { backendUrn: urn }, actor: { name: { attributesV2: [{ detailData: { [o.authorKey ?? "*companyName"]: o.author ?? company } }] } }, commentary: { text: { text: o.text ?? "hello" } }, "*socialDetail": social },
    { entityUrn: social, "*totalSocialActivityCounts": counts }, { entityUrn: counts, numLikes: 7, numComments: 3 }];
}
function captures(included: unknown[]): CompanyCapture[] { return [
  { url: "https://www.linkedin.com/company/acme/posts/", body: island({ included: [{ entityUrn: company, universalName: "acme" }] }) },
  { url: "https://www.linkedin.com/voyager/api/graphql?org=1", body: JSON.stringify({ included: [{ entityUrn: company, name: "Acme" }] }) },
  { url: "https://www.linkedin.com/voyager/api/graphql?feed=1", body: JSON.stringify({ included }) },
]; }
function parse(included: unknown[], o: { limit?: number; since?: number } = {}) { return parseCompanyPosts(captures(included), { targetVanity: "acme", sessionUrns: [], limit: o.limit ?? 100, ...(o.since === undefined ? {} : { since: o.since }) }); }

describe("parseCompanyPosts — pure contracts", () => {
  it("uses backend activity urn, typed company author, and two-hop counts", () => {
    const result = parse(update({ countsId: "urn:li:ugcPost:123" })); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.posts).toEqual([expect.objectContaining({ urn: activity, company_urn: company, text: "hello", reactions: 7, comments: 3 })]);
  });
  it("excludes a profile actor even when its value text resembles the subject", () => {
    const result = parse(update({ authorKey: "*profileFullName", author: company })); expect(result.ok && result.posts).toEqual([]);
  });
  it("refuses a subject present in the session trap set", () => {
    const result = parseCompanyPosts(captures(update()), { targetVanity: "acme", sessionUrns: [company], limit: 100 });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_IDENTITY_IS_SESSION", exit: 5 }));
  });
  it("keeps the inclusive since boundary and excludes one millisecond before it", () => {
    const boundary = Date.parse(postedAtFromActivityUrn(activity)!);
    expect(parse(update(), { since: boundary }).posts).toHaveLength(1);
    expect(parse(update(), { since: boundary + 1 }).posts).toHaveLength(0);
  });
  it("stops update work as soon as the accepted limit is reached", () => {
    const rows = [...update({ urn: "urn:li:activity:7400000000000000000" }), ...update({ urn: "urn:li:activity:7400000004194304000" })];
    const result = parse(rows, { limit: 1 }); expect(result.ok).toBe(true); if (result.ok) { expect(result.posts).toHaveLength(1); expect(result.inspectedUpdates).toBe(1); }
  });
  it("stores one row when overlapping feed pages carry the same activity twice", () => {
    const result = parse([...update(), ...update()], { limit: 100 });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.posts.map((post) => post.urn)).toEqual([activity]);
  });
  it("truncates text with typed exit-5 drift", () => {
    const result = parse(update({ text: "x".repeat(MAX_COMPANY_POST_TEXT_CHARS + 9) })); expect(result.posts[0]?.text).toHaveLength(MAX_COMPANY_POST_TEXT_CHARS);
    expect(result.warnings).toContainEqual(expect.objectContaining({ field: "text", n: 9, exit: 5 }));
  });
  it("bounds capture bodies", () => {
    const result = parseCompanyPosts([...captures(update()), ...Array.from({ length: 260 }, () => ({ url: "https://x.invalid", body: "{}" }))], { targetVanity: "acme", sessionUrns: [], limit: 2 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ field: "captures", exit: 5 }));
  });
  it("bounds JSON nodes", () => {
    const huge = { url: "https://www.linkedin.com/voyager/api/graphql", body: JSON.stringify(Array.from({ length: MAX_COMPANY_POST_NODES + 1 }, () => null)) };
    const result = parseCompanyPosts([...captures(update()), huge], { targetVanity: "acme", sessionUrns: [], limit: 2 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ field: "nodes", exit: 5 }));
  });
});
