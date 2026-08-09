import { describe, expect, it } from "vitest";
import {
  JOB_DOCUMENT_PATTERN_NAME,
  JOB_FIELD_PROBES,
  JOB_PATTERNS,
  isJobIsh,
  jobDocumentPattern,
  jobMarkerCounts,
  summarizeJobCaptures,
} from "../src/capabilities/job.capture/patterns.js";
import { isProfileIsh, summarizeCaptures } from "../src/capabilities/profile.capture/patterns.js";
import type { TieredPattern } from "../src/capabilities/profile.capture/patterns.js";
import type { Capture, CaptureMiss, WatchPattern } from "../src/core/tap/network-tap.js";

/** Compile-time: every tiered pattern is one the tap accepts, and every field
 *  probe is one the field map accepts. Both would otherwise only fail at the
 *  live run, which is the one place they must not. */
const _patternsAreWatchable: readonly WatchPattern[] = JOB_PATTERNS;
void _patternsAreWatchable;

const JOB_ID = "4012345678";
const JOB_URL = `https://www.linkedin.com/jobs/view/${JOB_ID}/`;
const JOB_BODY = JSON.stringify({ data: { entityUrn: `urn:li:fsd_jobPosting:${JOB_ID}` } });
const PERSON_BODY = JSON.stringify({ data: { entityUrn: "urn:li:fsd_profile:ACwAAA" } });

function match(url: string, patterns: readonly TieredPattern[]): string[] {
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

function capture(o: { url: string; body: string; seq?: number; patterns?: string[] }): Capture {
  const patterns = o.patterns ?? match(o.url, [...JOB_PATTERNS, jobDocumentPattern(JOB_URL)]);
  const seq = o.seq ?? 0;
  return {
    seq,
    pattern: patterns[0] ?? "linkedin-api",
    patterns,
    requestId: `req-${seq}`,
    url: o.url,
    status: 200,
    body: o.body,
    bytes: Buffer.byteLength(o.body),
    capturedAt: "2026-08-09T00:00:00.000Z",
    archived: {
      seq,
      id: `000${seq}-abc.json.gz`,
      file: `000${seq}-abc.json.gz`,
      path: `/tmp/000${seq}-abc.json.gz`,
      shapeHash: "abc",
      url: o.url,
      status: 200,
      capturedAt: "2026-08-09T00:00:00.000Z",
      bytes: Buffer.byteLength(o.body),
    },
  };
}

describe("isJobIsh recognizes a posting by its body, not by its url", () => {
  it("is true for every marker family and false for a person body", () => {
    expect(isJobIsh(JOB_BODY)).toBe(true);
    expect(isJobIsh('{"jobPostingId":4012345678}')).toBe(true);
    expect(isJobIsh('{"workRemoteAllowed":true}')).toBe(true);
    expect(isJobIsh(PERSON_BODY)).toBe(false);
    expect(isJobIsh("{}")).toBe(false);
  });

  it("counts which marker families a run saw, without printing any body", () => {
    const counts = jobMarkerCounts([JOB_BODY, '{"jobPostingId":1}', PERSON_BODY]);
    expect(counts["urn:li:fsd_jobPosting:"]).toBe(1);
    expect(counts['"jobPostingId"']).toBe(1);
    expect(counts["urn:li:jobPosting:"]).toBe(0);
  });
});

describe("jobDocumentPattern names the one document it watches", () => {
  const pattern = jobDocumentPattern(JOB_URL);
  const matches = (url: string): boolean =>
    typeof pattern.match === "function" ? pattern.match(url) : false;

  it("carries the job surface's own name, not the profile one", () => {
    expect(pattern.name).toBe(JOB_DOCUMENT_PATTERN_NAME);
    expect(pattern.name).not.toBe("profile-document");
    expect(pattern.tier).toBe("specific");
  });

  it("matches the same document however it is spelled", () => {
    expect(matches(JOB_URL)).toBe(true);
    expect(matches(`https://www.linkedin.com/jobs/view/${JOB_ID}`)).toBe(true);
    expect(matches(`https://ca.linkedin.com/jobs/view/${JOB_ID}/?refId=x#a`)).toBe(true);
  });

  it("does not match another posting, the api calls, or another host", () => {
    expect(matches("https://www.linkedin.com/jobs/view/9999999999/")).toBe(false);
    expect(matches("https://www.linkedin.com/voyager/api/graphql?queryId=x")).toBe(false);
    expect(matches("https://example.com/jobs/view/4012345678/")).toBe(false);
    expect(matches("not a url")).toBe(false);
  });
});

describe("the capture summary counts job relevance, and only job relevance", () => {
  const patterns: readonly TieredPattern[] = [...JOB_PATTERNS, jobDocumentPattern(JOB_URL)];

  it("counts a posting body as usable and a person body as not", () => {
    const summary = summarizeJobCaptures(
      [
        capture({ url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashJobPostings.1", body: JOB_BODY, seq: 1 }),
        capture({ url: "https://www.linkedin.com/voyager/api/me", body: PERSON_BODY, seq: 2 }),
      ],
      [],
      patterns,
    );
    // `profile_ish` on this shape means "relevant by the predicate given" (D261);
    // the capability renames it `job_ish` on its own receipt.
    expect(summary.captured).toBe(2);
    expect(summary.profile_ish).toBe(1);
  });

  it("names a posting that arrived on an endpoint no specific pattern predicted", () => {
    // The finding this whole capability exists to produce.
    const summary = summarizeJobCaptures(
      [capture({ url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashSomethingNew.9", body: JOB_BODY, seq: 3 })],
      [],
      patterns,
    );
    expect(summary.unmatched_profile_ish).toBe(1);
    expect(summary.endpoints[0]!.unpredicted).toBe(true);
    // Only the path reaches the receipt — the query string can carry captured data.
    expect(summary.endpoints[0]!.path).toBe("/voyager/api/graphql");
    expect(summary.endpoints[0]!.query_id).toBe("voyagerJobsDashSomethingNew.9");
  });

  it("reports the document pattern as specific, so its hit is not a mismatch", () => {
    const summary = summarizeJobCaptures(
      [capture({ url: JOB_URL, body: JOB_BODY, seq: 4, patterns: [JOB_DOCUMENT_PATTERN_NAME] })],
      [],
      patterns,
    );
    expect(summary.unmatched_profile_ish).toBe(0);
  });

  it("still counts misses so a lost body cannot look like one that never arrived", () => {
    const misses: CaptureMiss[] = [
      {
        seq: 9,
        requestId: "req-9",
        url: JOB_URL,
        status: 200,
        patterns: ["gql-any"],
        reason: "body-unavailable",
        detail: "no such request",
        seenAt: "2026-08-09T00:00:00.000Z",
      } as unknown as CaptureMiss,
    ];
    expect(summarizeJobCaptures([], misses, patterns).misses).toBe(1);
  });

  it("leaves the profile summariser's default untouched", () => {
    // The relevance predicate is an added optional parameter (D261). A caller
    // that does not pass one must behave exactly as it did before.
    const rows = [capture({ url: "https://www.linkedin.com/voyager/api/graphql", body: PERSON_BODY, seq: 5 })];
    expect(summarizeCaptures(rows, [], JOB_PATTERNS).profile_ish).toBe(1);
    expect(isProfileIsh(PERSON_BODY)).toBe(true);
    expect(summarizeJobCaptures(rows, [], JOB_PATTERNS).profile_ish).toBe(0);
  });
});

describe("the field probes cover every §7 jobs column", () => {
  it("names one probe per column the table holds", () => {
    // A missing probe is a column the generated field map would never look for,
    // and therefore a field Task 31 would have to guess at.
    const names = JOB_FIELD_PROBES.map((p) => p.name);
    for (const column of ["job_urn", "company_urn", "title", "location", "posted_at", "workplace_type", "description"]) {
      expect(names, column).toContain(column);
    }
  });
});
