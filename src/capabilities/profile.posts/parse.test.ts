import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../core/run/root.js";
import { activityPostedAt, parseProfilePosts } from "./parse.js";

const fixturePath = join(repoRoot(), "fixtures/profile.posts/6707f4b83c44b7e8.json");
const fixture = readFileSync(fixturePath, "utf8");
const subject = "urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA";

describe("profile.posts fixture parser", () => {
  it("reads value-bearing included nodes, never microSchema declarations", () => {
    const parsed = parseProfilePosts(fixture, { subjectUrn: subject });
    expect(parsed.rows.length).toBeGreaterThan(0);
    expect(parsed.rows.some((row) => row.text?.includes("This week marks 5 years"))).toBe(true);
    expect(parsed.rows.some((row) => row.text === "string" || row.text === "{type: string}")).toBe(false);
  });

  it("resolves reaction and comment counts through activity and ugcPost social-detail keys", () => {
    const rows = parseProfilePosts(fixture, { subjectUrn: subject }).rows;
    expect(rows).toHaveLength(14);
    expect(rows.every((row) => row.reactions !== null && row.comments !== null)).toBe(true);
    expect(rows.find((row) => row.urn === "urn:li:activity:7491547315707695105"))
      .toMatchObject({ reactions: expect.any(Number), comments: expect.any(Number) });
  });

  it("excludes interleaved reposts whose actor is not the subject", () => {
    const parsed = parseProfilePosts(fixture, { subjectUrn: subject });
    expect(parsed.examined).toBe(20);
    expect(parsed.excludedAuthors).toBe(6);
    expect(parsed.rows).toHaveLength(14);
    expect(parsed.rows.map((row) => row.urn)).not.toContain("urn:li:activity:7475637109408571394");
    expect(new Set(parsed.rows.map((row) => row.person_urn))).toEqual(new Set([subject]));
  });

  it("pins snowflake-derived timestamps across all 11 distinct activity labels", () => {
    const parsed = parseProfilePosts(fixture, { subjectUrn: subject });
    expect(parsed.rows.length).toBeGreaterThanOrEqual(11);
    expect(activityPostedAt("urn:li:activity:7491547315707695105").toISOString())
      .toBe("2026-08-07T17:34:26.283Z");
    expect(activityPostedAt("urn:li:activity:7475801102756589568").toISOString())
      .toBe("2026-06-25T06:44:36.565Z");
  });

  it("applies --since inclusively to the timestamp that is stored", () => {
    const all = parseProfilePosts(fixture, { subjectUrn: subject }).rows;
    const boundary = all[4]!.posted_at;
    const atBoundary = parseProfilePosts(fixture, { subjectUrn: subject, since: boundary }).rows;
    expect(atBoundary.some((row) => row.posted_at === boundary)).toBe(true);
    const after = new Date(new Date(boundary).getTime() + 1).toISOString();
    expect(parseProfilePosts(fixture, { subjectUrn: subject, since: after }).rows)
      .not.toContainEqual(all[4]);
  });

  it("uses --limit as an examination/work bound, not an output slice", () => {
    const limited = parseProfilePosts(fixture, { subjectUrn: subject, limit: 4 });
    expect(limited.examined).toBe(4);
    expect(limited.rows.length).toBeLessThanOrEqual(4);
    expect(limited.totalFeedItems).toBe(20);
  });

  it("falls back from a non-activity backendUrn to the update entityUrn", () => {
    const id = "7491547315707695105";
    const body = JSON.parse(fixture) as { included: Record<string, unknown>[] };
    const update = body.included.find((x) => String(x.entityUrn).includes(`activity:${id}`) && x.metadata);
    (update!.metadata as Record<string, unknown>).backendUrn = "urn:li:ugcPost:123";
    const parsed = parseProfilePosts(JSON.stringify(body), { subjectUrn: subject });
    expect(parsed.rows.some((row) => row.urn === `urn:li:activity:${id}`)).toBe(true);
  });

  it("skips malformed refs and snowflakes without aborting other rows", () => {
    const body = JSON.parse(fixture) as { data: { data: { feedDashProfileUpdatesByMemberShareFeed: { "*elements": unknown[] } } }; included: Record<string, unknown>[] };
    const refs = body.data.data.feedDashProfileUpdatesByMemberShareFeed["*elements"];
    refs.unshift(null);
    const validRef = String(refs[1]);
    const malformedRef = validRef.replace(/activity:\d+/, "activity:9999999999999999999999999");
    refs.splice(1, 0, malformedRef);
    const source = body.included.find((x) => x.entityUrn === validRef)!;
    body.included.push({ ...source, entityUrn: malformedRef, metadata: { backendUrn: "urn:li:activity:9999999999999999999999999" } });
    const parsed = parseProfilePosts(JSON.stringify(body), { subjectUrn: subject });
    expect(parsed.unresolved).toBeGreaterThanOrEqual(2);
    expect(parsed.rows.length).toBeGreaterThan(0);
  });
});
