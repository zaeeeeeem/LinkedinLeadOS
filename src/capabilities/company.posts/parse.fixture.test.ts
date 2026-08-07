import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDirFor } from "../profile.capture/fixture.test-helper.js";
import { parseCompanyPosts, type CompanyCapture } from "./parse.js";

const file = join(fixturesDirFor("company.get"), "12e39516db5656f4.json");
const fixtureIt = existsSync(file) ? it : it.skip;
const urn = "urn:li:fsd_company:79835899";
const expected = ["urn:li:activity:7460406123112689664", "urn:li:activity:7477806646233300992", "urn:li:activity:7485405402449379328", "urn:li:activity:7482539040118964224"];
function island(value: unknown) { return `<code id="bpr-guid-1">${JSON.stringify(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}</code>`; }
function captures(): CompanyCapture[] { return [
  { url: "https://www.linkedin.com/company/wisprflow/posts/", body: island({ included: [{ entityUrn: urn, universalName: "wisprflow" }] }) },
  { url: "https://www.linkedin.com/voyager/api/graphql?org=1", body: JSON.stringify({ included: [{ entityUrn: urn, name: "Wispr Flow" }] }) },
  { url: "https://www.linkedin.com/voyager/api/graphql?feed=1", body: readFileSync(file, "utf8") },
]; }
describe("parseCompanyPosts — measured fixture", () => {
  fixtureIt("stores exactly the four subject-authored activities, never seven strangers", () => {
    const result = parseCompanyPosts(captures(), { targetVanity: "wisprflow", sessionUrns: [], limit: 100 });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.posts.map((post) => post.urn)).toEqual(expected);
  });
});
