import { describe, expect, it } from "vitest";
import {
  ACTIVITY_PATTERNS,
  BROAD_PATTERN_NAME,
  activityDocumentPatterns,
  MAX_URNS_PER_FAMILY,
  isActivityIsh,
  sessionUrnHits,
  urnInventory,
} from "../src/capabilities/activity.capture/patterns.js";
import {
  isProfileIsh,
  summarizeCaptures,
  type TieredPattern,
} from "../src/capabilities/profile.capture/patterns.js";
import type { Capture } from "../src/core/tap/network-tap.js";

/** One captured body, as much of it as the summary reads. */
function capture(url: string, body: string, patterns: string[]): Capture {
  return {
    url,
    body,
    status: 200,
    bytes: body.length,
    patterns,
    archived: { file: "f.json.gz", shapeHash: "sh", bytes: body.length, path: "/tmp/f.json.gz" },
  } as unknown as Capture;
}

describe("ACTIVITY_PATTERNS", () => {
  it("keeps a broad net, so an unpredicted endpoint is still archived", () => {
    const broad = ACTIVITY_PATTERNS.filter((p) => p.tier === "broad").map((p) => p.name);
    expect(broad).toContain(BROAD_PATTERN_NAME);
    expect(ACTIVITY_PATTERNS.some((p) => p.tier === "specific")).toBe(true);
  });

  it("names every pattern uniquely — the tap keys watches by name", () => {
    const names = ACTIVITY_PATTERNS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("its broad net matches a linkedin graphql call and not a tracking beacon", () => {
    const net = ACTIVITY_PATTERNS.find((p) => p.name === BROAD_PATTERN_NAME)!;
    const match = net.match as (url: string) => boolean;
    expect(match("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashUpdates.1")).toBe(true);
    expect(match("https://www.linkedin.com/li/track")).toBe(false);
    expect(match("https://example.com/voyager/api/graphql")).toBe(false);
  });
});

describe("isActivityIsh", () => {
  it("recognises post, comment and reaction bodies", () => {
    expect(isActivityIsh('{"urn":"urn:li:activity:7123"}')).toBe(true);
    expect(isActivityIsh('{"urn":"urn:li:ugcPost:7123"}')).toBe(true);
    expect(isActivityIsh('{"socialDetail":{"numComments":3}}')).toBe(true);
  });

  it("does not call a body relevant merely for naming a person", () => {
    // The whole reason this is not `isProfileIsh`: every post card names its
    // author, so a person marker would make the pattern-vs-reality answer
    // identical on every run.
    const body = '{"entityUrn":"urn:li:fsd_profile:ACoAAA","firstName":"Jane"}';
    expect(isProfileIsh(body)).toBe(true);
    expect(isActivityIsh(body)).toBe(false);
  });
});

describe("summarizeCaptures with an activity relevance predicate", () => {
  const patterns: TieredPattern[] = [
    { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
    { name: "linkedin-api", tier: "broad", match: () => true },
  ];

  it("counts an activity body as relevant and a bare profile body as not", () => {
    const summary = summarizeCaptures(
      [
        capture("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashUpdates.1",
          '{"u":"urn:li:activity:1"}', ["gql-feed-updates", "linkedin-api"]),
        capture("https://www.linkedin.com/voyager/api/me",
          '{"entityUrn":"urn:li:fsd_profile:ACoAAA"}', ["linkedin-api"]),
      ],
      [],
      patterns,
      { isRelevant: isActivityIsh },
    );
    expect(summary.captured).toBe(2);
    expect(summary.profile_ish).toBe(1);
    expect(summary.unmatched_profile_ish).toBe(0);
  });

  it("reports an activity payload no specific pattern predicted", () => {
    const summary = summarizeCaptures(
      [capture("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSomethingNew.9",
        '{"u":"urn:li:activity:1"}', ["linkedin-api"])],
      [],
      patterns,
      { isRelevant: isActivityIsh },
    );
    // The finding the probe exists to produce: archived, counted, and flagged.
    expect(summary.unmatched_profile_ish).toBe(1);
  });

  it("still defaults to person data, so profile.capture is unchanged", () => {
    const summary = summarizeCaptures(
      [capture("https://www.linkedin.com/voyager/api/me",
        '{"entityUrn":"urn:li:fsd_profile:ACoAAA"}', ["linkedin-api"])],
      [],
      patterns,
    );
    expect(summary.profile_ish).toBe(1);
  });
});

describe("urnInventory", () => {
  it("counts distinct and total per family, never returning the urns", () => {
    const text = "urn:li:activity:1 urn:li:activity:1 urn:li:activity:2 urn:li:fsd_profile:ACoAAAx";
    const inv = urnInventory(text);
    expect(inv.distinct["activity"]).toBe(2);
    expect(inv.total["activity"]).toBe(3);
    expect(inv.distinct["person"]).toBe(1);
    expect(JSON.stringify(inv)).not.toContain("ACoAAAx");
  });

  it("reports zero for a family that is absent rather than omitting it", () => {
    const inv = urnInventory("nothing here");
    expect(inv.distinct["activity"]).toBe(0);
    expect(inv.truncated).toEqual([]);
  });

  it("bounds the distinct set and says when it bit", () => {
    // Exceeded, not assumed roomy: a feed page holds thousands of urns and this
    // set is built once per captured body.
    const over = MAX_URNS_PER_FAMILY + 25;
    const text = Array.from({ length: over }, (_, i) => `urn:li:activity:${i}`).join(" ");
    const inv = urnInventory(text);
    expect(inv.distinct["activity"]).toBe(MAX_URNS_PER_FAMILY);
    expect(inv.total["activity"]).toBe(over);
    expect(inv.truncated).toContain("activity");
  });
});

describe("sessionUrnHits", () => {
  it("counts the operator's own urns in a body and nothing else", () => {
    const session = ["urn:li:fsd_profile:ACoAAAoperator", "urn:li:member:306907360"];
    const body = '{"a":"urn:li:fsd_profile:ACoAAAoperator","b":"urn:li:fsd_profile:ACoAAAstranger"}';
    expect(sessionUrnHits(body, session)).toBe(1);
    expect(sessionUrnHits(body, [])).toBe(0);
  });

  it("ignores an empty string in the session set", () => {
    // An empty urn is a substring of every body; counting it would report every
    // page as the operator's.
    expect(sessionUrnHits('{"a":1}', [""])).toBe(0);
  });
});

describe("activityDocumentPatterns", () => {
  const POSTS = "https://www.linkedin.com/posts/jane-doe_hiring-activity-7123456789012345678-Ab1c";
  const CANONICAL = "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/";

  function matchers(target: { url: string; postUrn?: string }) {
    return activityDocumentPatterns(target).map((p) => ({
      name: p.name,
      hit: (url: string) => (p.match as (u: string) => boolean)(url),
    }));
  }

  it("watches the canonical permalink too, because /posts/ redirects to it", () => {
    // The broad net matches API paths and this is a page, so a missed document
    // is a document nobody captured — on the one surface where a server-rendered
    // payload is most likely (D116/D117). One pattern would have reported
    // "nothing was server-rendered" about a body it never watched for.
    const both = matchers({ url: POSTS, postUrn: "urn:li:activity:7123456789012345678" });
    expect(both).toHaveLength(2);
    expect(both.some((m) => m.hit(POSTS))).toBe(true);
    expect(both.some((m) => m.hit(CANONICAL))).toBe(true);
  });

  it("names the two watches apart — the tap keys watches by name", () => {
    const names = matchers({ url: POSTS, postUrn: "urn:li:activity:7123456789012345678" })
      .map((m) => m.name);
    expect(new Set(names).size).toBe(2);
  });

  it("watches one document when the target is already the canonical form", () => {
    const one = matchers({ url: CANONICAL, postUrn: "urn:li:activity:7123456789012345678" });
    expect(one).toHaveLength(1);
    expect(one[0]!.hit(CANONICAL)).toBe(true);
  });

  it("watches one document on a person surface", () => {
    const one = matchers({ url: "https://www.linkedin.com/in/jane-doe/recent-activity/all/" });
    expect(one).toHaveLength(1);
  });

  it("does not match another post", () => {
    const both = matchers({ url: POSTS, postUrn: "urn:li:activity:7123456789012345678" });
    const other = "https://www.linkedin.com/feed/update/urn:li:activity:9999999999999999999/";
    expect(both.some((m) => m.hit(other))).toBe(false);
  });
});
