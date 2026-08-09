import {
  BROAD_PATTERN_NAME,
  documentPattern,
  isLinkedInApiUrl,
  summarizeCaptures,
} from "../profile.capture/patterns.js";
import type { CaptureSummary, TieredPattern } from "../profile.capture/patterns.js";
import type { Capture, CaptureMiss } from "../../core/tap/network-tap.js";
import type { FieldProbe } from "../../core/fixtures/fieldmap.js";

/**
 * What a `/jobs/view/<id>` page is *expected* to fetch, plus the nets that catch
 * what it actually fetches.
 *
 * The tiering, and the reason for it, are `profile.capture`'s (see that module):
 * `specific` names are this build's guess, `broad` names are the safety net that
 * makes the guess checkable. Everything below is deliberately
 * plausible-but-unproven — the names come from the shape of LinkedIn's current
 * `voyagerJobsDash*` GraphQL surface — and the live probe is what decides which
 * are real. A specific pattern with zero hits next to a non-zero
 * `unmatched_job_ish` is the finding this capability exists to produce.
 */
export const JOB_PATTERNS: readonly TieredPattern[] = [
  { name: "gql-jobs-job-postings", tier: "specific", match: "voyagerJobsDashJobPostings" },
  { name: "gql-jobs-job-posting-cards", tier: "specific", match: "voyagerJobsDashJobPostingCards" },
  { name: "gql-jobs-job-posting-detail", tier: "specific", match: "voyagerJobsDashJobPostingDetail" },
  { name: "gql-jobs-job-description", tier: "specific", match: "JobDescription" },
  { name: "rest-jobs-job-postings", tier: "specific", match: "/voyager/api/jobs/jobPostings" },
  { name: "rest-jobs-dash-job-postings", tier: "specific", match: "/voyager/api/jobs/dash/jobPostings" },

  // The nets, shared verbatim with `profile.capture` so "an endpoint nobody
  // predicted" means the same thing on both surfaces.
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  { name: BROAD_PATTERN_NAME, tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

/** The net every capture is measured against, and the one `waitFor` waits on. */
export { BROAD_PATTERN_NAME };

/** The navigation response for the job detail page being captured. */
export const JOB_DOCUMENT_PATTERN_NAME = "job-document";

/**
 * Watches the initial document response for one specific job url.
 *
 * `/jobs/view/<id>` is a page rather than an API path, so no broad net can reach
 * it. The matching itself is `profile.capture`'s `documentPattern` — same
 * question (did the payload arrive server-rendered in the navigation response),
 * same normalization of trailing slash, query, fragment and subdomain — under a
 * name that says which surface it belongs to on the receipt.
 */
export function jobDocumentPattern(targetUrl: string): TieredPattern {
  return { ...documentPattern(targetUrl), name: JOB_DOCUMENT_PATTERN_NAME };
}

/**
 * Substrings that only appear in a body carrying job-posting data.
 *
 * Content-based, for `profile.capture`'s reason: whether a response is *about a
 * posting* is a fact about its body, and asking the URL instead would make the
 * "did our patterns match reality" answer depend on the guess it is checking.
 */
export const JOB_MARKERS = [
  "urn:li:fsd_jobPosting:",
  "urn:li:fs_normalized_jobPosting:",
  "urn:li:jobPosting:",
  '"jobPostingId"',
  '"workRemoteAllowed"',
  '"workplaceTypes"',
] as const;

/** True when a captured body carries job-posting data. */
export function isJobIsh(body: string): boolean {
  return JOB_MARKERS.some((marker) => body.includes(marker));
}

/** Which marker families a run actually saw, as counts. Names how a body was
 *  recognized without printing any of it — the receipt is the only place this
 *  measurement is read, and captured data never reaches stdout (§4.1, D3). */
export function jobMarkerCounts(bodies: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const marker of JOB_MARKERS) {
    counts[marker] = bodies.filter((b) => b.includes(marker)).length;
  }
  return counts;
}

/**
 * The capture summary for a job run.
 *
 * `summarizeCaptures` does the work; this only supplies the relevance predicate,
 * so "was this response about the thing we came for" is the one thing that
 * differs between surfaces and the counting is shared. Its `profile_ish` fields
 * therefore mean "job-ish" here, which is why the capability renames them on the
 * receipt rather than passing this shape through.
 */
export function summarizeJobCaptures(
  captures: readonly Capture[],
  misses: readonly CaptureMiss[],
  patterns: readonly TieredPattern[],
): CaptureSummary {
  return summarizeCaptures(captures, misses, patterns, isJobIsh);
}

/**
 * What a job parser (Task 31) has to locate in a JSON body, as field-map probes.
 *
 * These are **search terms, not a schema.** Each one reports its hits *and its
 * misses* against a real fixture, so a name that LinkedIn does not use shows up
 * as "not found" in the generated map rather than as an assumed path in a
 * parser — which is the whole difference D152 draws. Spec §7's `jobs` columns
 * are the list: id, company_urn, title, location, posted_at, workplace_type,
 * description.
 */
export const JOB_FIELD_PROBES: readonly FieldProbe[] = [
  {
    name: "job_urn",
    what: "the posting's stable identity — §7's `jobs.id` comes from this (D260)",
    value: /^urn:li:(fsd_jobPosting|fs_normalized_jobPosting|jobPosting):/,
  },
  { name: "job_id", what: "the bare numeric posting id", key: /^(jobPostingId|jobId|entityId)$/ },
  { name: "title", what: "the posting's title", key: /^(title|jobTitle|formattedTitle)$/ },
  {
    name: "company_urn",
    what: "the hiring company's urn — §7's `jobs.company_urn`",
    value: /^urn:li:(fsd_company|fs_normalized_company|company):/,
  },
  { name: "company_name", what: "the hiring company by name, for cross-checking the urn", key: /^(companyName|companyNameText)$/ },
  {
    name: "location",
    what: "where the job is — §7's `jobs.location`",
    key: /^(formattedLocation|locationName|geoLocationName|location)$/,
  },
  {
    name: "posted_at",
    what: "when it was posted — §7's `jobs.posted_at`; LinkedIn's epoch-ms spellings first",
    key: /^(listedAt|originalListedAt|postedAt|createdAt|postedOn)$/,
  },
  {
    name: "workplace_type",
    what: "on-site / hybrid / remote — §7's `jobs.workplace_type`",
    key: /^(workplaceTypes|workplaceType|workRemoteAllowed|workplaceTypesResolutionResults)$/,
  },
  {
    name: "description",
    what: "the full posting text — §7's `jobs.description`, the field a list card cannot carry",
    key: /^(description|descriptionText|jobDescription)$/,
  },
  { name: "apply_method", what: "how applications are taken; not stored, but it says how complete a body is", key: /^(applyMethod|companyApplyUrl|easyApplyUrl)$/ },
];
