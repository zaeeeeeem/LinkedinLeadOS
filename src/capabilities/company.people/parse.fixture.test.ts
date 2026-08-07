import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturesDirFor } from "../profile.capture/fixture.test-helper.js";
import { parseCompanyPeople, type CompanyCapture } from "./parse.js";
const directory = fixturesDirFor("company.people"), search = join(directory, "6da50130b093a5d6.json");
const orgDirectory = fixturesDirFor("company.get"), document = join(orgDirectory, "438312a3d613045a-dom-snapshot.html"), org = join(orgDirectory, "ffbecb25cb3b8d81.json");
const fixtureIt = [search, document, org].every(existsSync) ? it : it.skip;
describe("parseCompanyPeople — measured fixture", () => { fixtureIt("pins 12 cluster-scoped people and usable profile URLs", () => { const captures: CompanyCapture[] = [{ url: "https://www.linkedin.com/company/wisprflow/people/", body: readFileSync(document, "utf8") }, { url: "https://www.linkedin.com/voyager/api/graphql?org", body: readFileSync(org, "utf8") }, { url: "https://www.linkedin.com/voyager/api/graphql?search", body: readFileSync(search, "utf8") }]; const got = parseCompanyPeople(captures, { targetVanity: "wisprflow", sessionUrns: [], limit: 100 }); expect(got.ok).toBe(true); if (!got.ok) return; expect(got.people).toHaveLength(12); expect(got.people.every((p) => /^https:\/\/www\.linkedin\.com\/in\/|^urn:li:fsd_profile:/.test(p.profile_url))).toBe(true); expect(new Set(got.people.map((p) => p.person_urn)).size).toBe(12); }); });
