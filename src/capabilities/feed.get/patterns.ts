import { documentPattern, isLinkedInApiUrl, type TieredPattern } from "../profile.capture/patterns.js";
import { FEED_URL } from "./constants.js";

/**
 * What the operator's own `/feed/` is *expected* to fetch, plus the nets that
 * catch what it actually fetches.
 *
 * Every `specific` name is a guess and is labelled as one. The two-tier scheme
 * (D110) is what makes a guess checkable: the broad nets archive everything
 * LinkedIn-API-shaped anyway, so a payload arriving on an endpoint nobody
 * predicted is still on disk and still counted, and a specific pattern with
 * zero hits next to a non-zero `unmatched_relevant` is a finding.
 *
 * This matters more here than on the surfaces before it. D325 granted the DOM
 * exception *ahead of* the measurement, on the condition that the probe still
 * measures and that a labeled network body still wins. Two of these names —
 * `voyagerFeedDashUpdates` and `/voyager/api/feed/updates` — are already watched
 * by `activity.capture` and are plausibly the main feed's own endpoints. If they
 * answer with feed items, the DOM exception goes unused and the tap rule wins.
 */
export const FEED_PATTERNS: readonly TieredPattern[] = [
  // The main-feed GraphQL surface, in the spellings LinkedIn's current build
  // uses on adjacent surfaces.
  { name: "gql-feed-main-updates", tier: "specific", match: "voyagerFeedDashMainFeedUpdates" },
  { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
  { name: "gql-feed-updates-v2", tier: "specific", match: "voyagerFeedDashFeedUpdatesV2" },
  // The counts a feed card hangs its reaction / comment totals off.
  { name: "gql-social-activity-counts", tier: "specific", match: "voyagerSocialDashSocialActivityCounts" },
  { name: "gql-social-detail", tier: "specific", match: "voyagerSocialDashSocialDetails" },
  // The pre-GraphQL REST surface. Still answered for some clients.
  { name: "rest-feed-updates", tier: "specific", match: "/voyager/api/feed/updates" },

  // The nets.
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  { name: "linkedin-api", tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

/** The net every capture is measured against, and one of the two the readiness
 *  gate waits on. Same name as `profile.capture`'s so the summaries read alike. */
export const BROAD_PATTERN_NAME = "linkedin-api";

/** The feed's own document. Watched because D321 measured three runs that
 *  answered with a fully populated document and no Voyager call at all, and
 *  failed `CAPTURE_TIMEOUT` holding exactly what they came for. */
export const FEED_DOCUMENT_NAME = "feed-document";

/** The document watch for `/feed/`. One url, so one pattern — unlike the post
 *  permalink, this page redirects nowhere. */
export function feedDocumentPattern(): TieredPattern {
  return documentPattern(FEED_URL, FEED_DOCUMENT_NAME);
}

/**
 * Substrings that only appear in a body carrying feed-item data.
 *
 * Content-based, for the same reason `isProfileIsh` and `isActivityIsh` are:
 * whether a response carries feed items is a fact about its body, and asking
 * the url instead would make the pattern-vs-reality answer depend on the guess
 * it is checking.
 *
 * `urn:li:fsd_profile` is deliberately **absent**. Every feed card names its
 * author, so a person-urn marker would call every body relevant and the summary
 * would say the same thing on every run.
 */
const FEED_MARKERS = [
  "urn:li:activity:",
  "urn:li:ugcPost:",
  "urn:li:share:",
  "urn:li:fsd_update:",
  '"socialDetail"',
  '"reactionTypeCounts"',
  '"numComments"',
];

/** True when a captured body carries feed-item data. */
export function isFeedIsh(body: string): boolean {
  return FEED_MARKERS.some((marker) => body.includes(marker));
}
