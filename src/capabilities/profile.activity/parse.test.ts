import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../core/run/root.js";
import { parseProfileActivity } from "./parse.js";

const fixtureDir = join(repoRoot(), "fixtures/profile.activity");
const identityPath = join(fixtureDir, "30086ec2248fe8f5.json");
const commentsPath = join(fixtureDir, "b22c2aa005ce273c.json");
const reactionsPath = join(fixtureDir, "fe401a30d3cad86d.json");
const fixturesPresent = [identityPath, commentsPath, reactionsPath].every(existsSync);

function fixtures() {
  const identity = JSON.parse(readFileSync(identityPath, "utf8")) as { included: Record<string, unknown>[] };
  const subjectUrn = identity.included.map((x) => x["*vieweeProfile"])
    .find((x): x is string => typeof x === "string")!;
  return {
    subjectUrn,
    comments: readFileSync(commentsPath, "utf8"),
    reactions: readFileSync(reactionsPath, "utf8"),
  };
}

describe.skipIf(!fixturesPresent)("profile.activity promoted fixtures", () => {
  it("keeps the activity actor distinct from the target post author", () => {
    const f = fixtures();
    const parsed = parseProfileActivity(f.reactions, { subjectUrn: f.subjectUrn, sessionUrns: [] });
    expect(parsed.rows).toHaveLength(20);
    expect(parsed.rows.every((row) => row.actor_urn === f.subjectUrn)).toBe(true);
    expect(parsed.rows.some((row) => row.target_author_urn !== row.actor_urn)).toBe(true);
  });

  it("excludes a session-owned activity actor", () => {
    const f = fixtures();
    const parsed = parseProfileActivity(f.comments, {
      subjectUrn: f.subjectUrn,
      sessionUrns: [f.subjectUrn],
    });
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.excludedSessionActors).toBe(20);
  });

  it("asserts every projected field on comments and reactions", () => {
    const f = fixtures();
    const comments = parseProfileActivity(f.comments, { subjectUrn: f.subjectUrn, sessionUrns: [] });
    const reactions = parseProfileActivity(f.reactions, { subjectUrn: f.subjectUrn, sessionUrns: [] });
    expect(comments.rows).toHaveLength(20);
    expect(reactions.rows).toHaveLength(20);
    expect(comments.rows.every((row) => row.kind === "comment")).toBe(true);
    expect(reactions.rows.every((row) => row.kind === "reaction")).toBe(true);
    for (const row of [...comments.rows, ...reactions.rows]) {
      expect(row.urn).toMatch(/^urn:li:activity:\d+$/);
      expect(row.actor_urn).toBe(f.subjectUrn);
      expect(row.target_author_urn).toMatch(/^urn:li:fsd_profile:/);
      expect(row.posted_at).toMatch(/^20\d\d-/);
      expect(row.reactions).toEqual(expect.any(Number));
      expect(row.comments).toEqual(expect.any(Number));
      expect(row.text === null || typeof row.text === "string").toBe(true);
    }
    expect([...comments.rows, ...reactions.rows].some((row) => typeof row.text === "string")).toBe(true);
  });

  it("applies inclusive --since and an examination work bound", () => {
    const f = fixtures();
    const first = parseProfileActivity(f.comments, { subjectUrn: f.subjectUrn, sessionUrns: [], limit: 1 });
    expect(first.examined).toBe(1);
    expect(first.rows).toHaveLength(1);
    const boundary = first.rows[0]!.posted_at;
    expect(parseProfileActivity(f.comments, {
      subjectUrn: f.subjectUrn, sessionUrns: [], limit: 1, since: boundary,
    }).rows).toHaveLength(1);
    expect(parseProfileActivity(f.comments, {
      subjectUrn: f.subjectUrn, sessionUrns: [], limit: 1,
      since: new Date(Date.parse(boundary) + 1).toISOString(),
    }).rows).toHaveLength(0);
  });

  it("finds the subject actor anywhere in header attributes", () => {
    const f = fixtures();
    const body = JSON.parse(f.comments) as { data: { data: { feedDashProfileUpdatesByMemberComments: { "*elements": string[] } } }; included: Record<string, unknown>[] };
    const ref = body.data.data.feedDashProfileUpdatesByMemberComments["*elements"][0]!;
    const update = body.included.find((x) => x.entityUrn === ref)!;
    const text = (update.header as { text: { attributesV2: unknown[] } }).text;
    text.attributesV2.unshift({ detailData: { "*profileFullName": "urn:li:fsd_profile:other" } });
    const parsed = parseProfileActivity(JSON.stringify(body), { subjectUrn: f.subjectUrn, sessionUrns: [], limit: 1 });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.actor_urn).toBe(f.subjectUrn);
  });

  it("counts a missing actor as unresolved rather than another person's activity", () => {
    const f = fixtures();
    const body = JSON.parse(f.comments) as { data: { data: { feedDashProfileUpdatesByMemberComments: { "*elements": string[] } } }; included: Record<string, unknown>[] };
    const ref = body.data.data.feedDashProfileUpdatesByMemberComments["*elements"][0]!;
    const update = body.included.find((x) => x.entityUrn === ref)!;
    delete update.header;
    const parsed = parseProfileActivity(JSON.stringify(body), { subjectUrn: f.subjectUrn, sessionUrns: [], limit: 1 });
    expect(parsed).toMatchObject({ examined: 1, unresolved: 1, excludedActors: 0 });
  });

  it("does no work for unrelated envelopes or non-JSON bodies", () => {
    const f = fixtures();
    const shareFeed = f.comments.replaceAll("feedDashProfileUpdatesByMemberComments", "feedDashProfileUpdatesByMemberShareFeed");
    expect(parseProfileActivity(shareFeed, { subjectUrn: f.subjectUrn, sessionUrns: [] }))
      .toMatchObject({ examined: 0, totalFeedItems: 0, rows: [] });
    expect(parseProfileActivity("<html>feedDashProfileUpdatesByMemberComments</html>", { subjectUrn: f.subjectUrn, sessionUrns: [] }))
      .toMatchObject({ examined: 0, totalFeedItems: 0, rows: [] });
  });
});
