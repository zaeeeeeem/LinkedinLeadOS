import { isLinkedInApiUrl, type TieredPattern } from "../profile.capture/patterns.js";
import type { CompanySubPage } from "./url.js";

/**
 * What the company page family is expected to fetch, and the nets that catch
 * what it actually fetches.
 *
 * Two tiers, exactly as `PROFILE_PATTERNS` (D110): the `specific` names are this
 * build's *guess*, and the `broad` nets are what make the guess checkable — a
 * company payload arriving on an endpoint nobody predicted is still archived,
 * still counted, and shows up on the receipt as `unmatched_profile_ish`. That
 * number is the probe's headline finding, not an error.
 *
 * The broad nets and the LinkedIn-api rule are imported from
 * `profile.capture/patterns` rather than restated. That rule (which hosts, which
 * paths, telemetry excluded) is one fact about LinkedIn, and a second copy of it
 * is a copy that drifts.
 */
export const COMPANY_PATTERNS: readonly TieredPattern[] = [
  // GraphQL operation ids. `queryId=voyagerOrganizationDash…` is the closest
  // thing LinkedIn has to a stable endpoint id for this surface.
  { name: "gql-org-companies", tier: "specific", match: "voyagerOrganizationDashCompanies" },
  { name: "gql-org-company-by-universal-name", tier: "specific", match: "CompaniesByUniversalName" },
  { name: "gql-org-modules", tier: "specific", match: "voyagerOrganizationDashOrganizationalPageModules" },
  { name: "gql-org-people", tier: "specific", match: "voyagerOrganizationDashPeople" },
  { name: "gql-org-insights", tier: "specific", match: "voyagerOrganizationDashInsights" },
  // The posts tab is served by the feed surface, not by an organization one.
  { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
  { name: "gql-feed-profile-updates", tier: "specific", match: "voyagerFeedDashProfileUpdates" },
  // Jobs.
  { name: "gql-jobs-search", tier: "specific", match: "voyagerJobsDashJobCards" },
  { name: "gql-jobs-postings", tier: "specific", match: "voyagerJobsDashJobPostingDetailSections" },
  // The pre-GraphQL REST surface. Still answered for some clients.
  { name: "rest-organization", tier: "specific", match: "/voyager/api/organization/" },
  { name: "rest-jobs", tier: "specific", match: "/voyager/api/jobs/" },
  // Sales Navigator's company endpoint, seen in the reference worker.
  { name: "salesapi-companies", tier: "specific", match: "salesApiCompanies" },

  // The nets.
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  { name: "linkedin-api", tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

/** The net every capture is measured against, and the one `waitFor` waits on.
 *  The same name `profile.capture` uses, because it is the same net. */
export const BROAD_PATTERN_NAME = "linkedin-api";

/** The watch name for one sub-page's own navigation response. One per sub-page,
 *  because five watches sharing a name would report as one row and could not
 *  answer which document carried what. */
export function documentPatternName(sub: CompanySubPage): string {
  return `document-${sub}`;
}

/**
 * Substrings that only appear in a body carrying *company-family* data.
 *
 * Content-based, for `isProfileIsh`'s reason: whether a response is about this
 * subject is a fact about its body, and asking the url instead would make the
 * "did our patterns match reality" answer depend on the same guess it exists to
 * check.
 *
 * Deliberately wider than one table. The four capabilities Task 21 feeds read
 * companies, posts and jobs off this same page family, and a marker list narrow
 * enough to be "company only" would report the posts and jobs sub-pages as
 * carrying nothing.
 */
const COMPANY_MARKERS = [
  "urn:li:fsd_company:",
  "urn:li:fs_normalized_company:",
  "urn:li:company:",
  "urn:li:organization:",
  "urn:li:fs_salesCompany:",
  '"universalName"',
  "urn:li:fsd_jobPosting:",
  "urn:li:jobPosting:",
  "urn:li:activity:",
  "urn:li:ugcPost:",
  "urn:li:share:",
  "urn:li:fsd_update:",
];

/** True when a captured body carries company-family data. */
export function isCompanyIsh(body: string): boolean {
  return COMPANY_MARKERS.some((marker) => body.includes(marker));
}
