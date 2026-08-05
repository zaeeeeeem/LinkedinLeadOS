import { describe, expect, it } from "vitest";
import {
  BROAD_PATTERN_NAME,
  PROFILE_PATTERNS,
  isLinkedInApiUrl,
  isProfileIsh,
  queryIdOf,
  summarizeCaptures,
} from "../src/capabilities/profile.capture/patterns.js";
import type { TieredPattern } from "../src/capabilities/profile.capture/patterns.js";
import type { Capture, CaptureMiss, WatchPattern } from "../src/core/tap/network-tap.js";

/** Compile-time: every tiered pattern is a pattern the tap accepts. A drift here
 *  would only show up at the live run, which is the one place it must not. */
const _patternsAreWatchable: readonly WatchPattern[] = PROFILE_PATTERNS;
void _patternsAreWatchable;

/** Matches a url against the pattern list the same way `NetworkTap` does. */
function match(url: string, patterns: readonly TieredPattern[] = PROFILE_PATTERNS): string[] {
  return patterns
    .filter((p) =>
      typeof p.match === "function"
        ? p.match(url)
        : typeof p.match === "string"
          ? url.includes(p.match)
          : p.match.test(url),
    )
    .map((p) => p.name);
}

function capture(o: Partial<Capture> & { url: string; body: string }): Capture {
  const patterns = o.patterns ?? match(o.url);
  return {
    seq: o.seq ?? 0,
    pattern: patterns[0] ?? "linkedin-api",
    patterns,
    requestId: o.requestId ?? "req-1",
    url: o.url,
    status: o.status ?? 200,
    body: o.body,
    bytes: Buffer.byteLength(o.body),
    capturedAt: "2026-08-08T00:00:00.000Z",
    archived: {
      seq: o.seq ?? 0,
      id: `000${o.seq ?? 0}-abc.json.gz`,
      file: `000${o.seq ?? 0}-abc.json.gz`,
      path: `/tmp/000${o.seq ?? 0}-abc.json.gz`,
      shapeHash: "abc",
      url: o.url,
      status: o.status ?? 200,
      capturedAt: "2026-08-08T00:00:00.000Z",
      bytes: Buffer.byteLength(o.body),
    },
  };
}

function miss(patterns: string[]): CaptureMiss {
  return {
    pattern: patterns[0]!,
    patterns,
    requestId: "req-x",
    url: "https://www.linkedin.com/voyager/api/graphql?queryId=q",
    reason: "body-unavailable",
    at: "2026-08-08T00:00:00.000Z",
  };
}

describe("isLinkedInApiUrl — the broad net", () => {
  it("matches LinkedIn's api surfaces", () => {
    for (const url of [
      "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.abc",
      "https://www.linkedin.com/voyager/api/identity/dash/profiles?q=memberIdentity",
      "https://www.linkedin.com/sales-api/salesApiProfiles/(profileId:ACw)",
    ]) {
      expect(isLinkedInApiUrl(url), url).toBe(true);
    }
  });

  it("does not match pages, assets, other hosts, or telemetry", () => {
    for (const url of [
      "https://www.linkedin.com/in/someone/",
      "https://static.licdn.com/aero-v1/sc/h/abc.js",
      "https://example.com/voyager/api/graphql",
      "https://www.linkedin.com/li/track",
      "https://www.linkedin.com/platform-telemetry/perftracker?a=1",
      "not a url at all",
    ]) {
      expect(isLinkedInApiUrl(url), url).toBe(false);
    }
  });

  it("is registered under the name the capability waits on", () => {
    const broad = PROFILE_PATTERNS.find((p) => p.name === BROAD_PATTERN_NAME);
    expect(broad?.tier).toBe("broad");
  });

  it("catches a profile response on an endpoint no specific pattern predicts", () => {
    // The case the whole two-tier design exists for: LinkedIn moves the profile
    // payload to an operation this build has never heard of.
    const url = "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashSomethingNew.9f";
    const names = match(url);
    expect(names).toContain(BROAD_PATTERN_NAME);
    expect(names.filter((n) => n.startsWith("gql-identity") || n.startsWith("rest-"))).toEqual([]);
  });
});

describe("isProfileIsh", () => {
  it("recognizes person payloads by their urns", () => {
    expect(isProfileIsh('{"entityUrn":"urn:li:fsd_profile:ACwAAA123"}')).toBe(true);
    expect(isProfileIsh('{"publicIdentifier":"someone"}')).toBe(true);
    expect(isProfileIsh('{"x":"urn:li:member:98765"}')).toBe(true);
  });

  it("does not recognize company, job or telemetry payloads", () => {
    expect(isProfileIsh('{"entityUrn":"urn:li:fsd_company:1234"}')).toBe(false);
    expect(isProfileIsh('{"events":[{"name":"pageView"}]}')).toBe(false);
    expect(isProfileIsh("")).toBe(false);
  });
});

describe("queryIdOf", () => {
  it("pulls the graphql operation id out of a voyager url", () => {
    expect(queryIdOf("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a")).toBe(
      "voyagerIdentityDashProfiles.7a",
    );
    expect(queryIdOf("https://www.linkedin.com/voyager/api/identity/dash/profiles")).toBeNull();
    expect(queryIdOf("::::")).toBeNull();
  });
});

describe("summarizeCaptures", () => {
  it("reports zero hits for a predicted pattern that never fired, next to the payload that did arrive", () => {
    // This is the finding shape the live run has to be able to produce: the
    // specific patterns all miss, the broad net catches a profile payload, and
    // the summary says so out loud rather than reporting a clean zero.
    const summary = summarizeCaptures(
      [
        capture({
          url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashSomethingNew.9f",
          body: '{"data":{"entityUrn":"urn:li:fsd_profile:ACwAAA"}}',
        }),
      ],
      [],
    );

    expect(summary.captured).toBe(1);
    expect(summary.profile_ish).toBe(1);
    expect(summary.unmatched_profile_ish).toBe(1);
    expect(summary.endpoints[0]!.unpredicted).toBe(true);
    for (const p of summary.patterns.filter((x) => x.tier === "specific")) {
      expect(p.hits, p.name).toBe(0);
    }
    expect(summary.patterns.find((p) => p.name === BROAD_PATTERN_NAME)!.hits).toBe(1);
  });

  it("counts a predicted endpoint as predicted", () => {
    const summary = summarizeCaptures(
      [
        capture({
          url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a",
          body: '{"data":{"entityUrn":"urn:li:fsd_profile:ACwAAA"}}',
        }),
      ],
      [],
    );
    expect(summary.unmatched_profile_ish).toBe(0);
    expect(summary.patterns.find((p) => p.name === "gql-identity-profiles")!.hits).toBe(1);
    expect(summary.endpoints[0]!.unpredicted).toBe(false);
  });

  it("does not count a non-profile response as an unmatched profile payload", () => {
    const summary = summarizeCaptures(
      [
        capture({
          url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashSomething.1",
          body: '{"data":{"entityUrn":"urn:li:fsd_company:1"}}',
        }),
      ],
      [],
    );
    expect(summary.captured).toBe(1);
    expect(summary.profile_ish).toBe(0);
    expect(summary.unmatched_profile_ish).toBe(0);
  });

  it("keeps query strings off the receipt but keeps the operation id", () => {
    const summary = summarizeCaptures(
      [
        capture({
          url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a&variables=(vanityName:jane-doe)",
          body: "{}",
        }),
      ],
      [],
    );
    const row = summary.endpoints[0]!;
    expect(row.path).toBe("/voyager/api/graphql");
    expect(row.query_id).toBe("voyagerIdentityDashProfiles.7a");
    expect(JSON.stringify(row)).not.toContain("jane-doe");
  });

  it("attributes misses to their patterns, so a lost body is never a silent zero", () => {
    const summary = summarizeCaptures([], [miss(["gql-identity-profiles", "linkedin-api"])]);
    expect(summary.captured).toBe(0);
    expect(summary.misses).toBe(1);
    expect(summary.patterns.find((p) => p.name === "gql-identity-profiles")!.misses).toBe(1);
    expect(summary.patterns.find((p) => p.name === "gql-profile-cards")!.misses).toBe(0);
  });

  it("reports every registered pattern, including the ones that never fired", () => {
    const summary = summarizeCaptures([], []);
    expect(summary.patterns.map((p) => p.name)).toEqual(PROFILE_PATTERNS.map((p) => p.name));
  });
});
