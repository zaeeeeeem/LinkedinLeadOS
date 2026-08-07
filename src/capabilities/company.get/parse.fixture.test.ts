import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDirFor } from "../profile.capture/fixture.test-helper.js";
import { parseCompanyCaptures, type CompanyCapture } from "./parse.js";

const directory = fixturesDirFor("company.get");
const required = ["438312a3d613045a-document.html.gz", "ffbecb25cb3b8d81.json"];
const available = required.every((file) => existsSync(join(directory, file)));
const fixtureIt = available ? it : it.skip;
const vanity = "wisprflow";
const urn = "urn:li:fsd_company:79835899";

function fixtureCaptures(): CompanyCapture[] {
  const document = gunzipSync(readFileSync(join(directory, required[0]!))).toString("utf8");
  const voyager = readFileSync(join(directory, required[1]!), "utf8");
  return [
    { url: "https://www.linkedin.com/company/wisprflow/", body: document },
    { url: "https://www.linkedin.com/voyager/api/graphql", body: voyager },
  ];
}

describe("parseCompanyCaptures — measured fixture", () => {
  fixtureIt("pins every §7 company field and formats structured composites", () => {
    const result = parseCompanyCaptures(fixtureCaptures(), { targetVanity: vanity, sessionUrns: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.company.value).toMatchObject({
      urn, name: "Wispr Flow", vanity, website: "https://wisprflow.ai/",
      industry: "Technology, Information and Internet", size_range: "11-50 employees",
      hq: "San Francisco, California",
    });
    expect(result.company.value.about).toContain("lets you speak naturally");
  });

  fixtureIt("refuses a candidate urn present in the session/trap set", () => {
    const result = parseCompanyCaptures(fixtureCaptures(), { targetVanity: vanity, sessionUrns: [urn] });
    expect(result.ok).toBe(false);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_IDENTITY_IS_SESSION", field: "urn" }));
  });
});
