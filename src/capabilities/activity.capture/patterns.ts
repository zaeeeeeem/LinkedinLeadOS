import { documentPattern, isLinkedInApiUrl, type TieredPattern } from "../profile.capture/patterns.js";

/**
 * The endpoints a `/in/<vanity>/recent-activity/…` page or a post permalink is
 * *expected* to fetch, plus the nets that catch what it actually fetches.
 *
 * Every `specific` name here is a guess and is labelled as one — they come from
 * the shape of LinkedIn's current GraphQL surface, not from a measurement. The
 * two-tier scheme (D110) is what makes the guess checkable: the broad nets
 * archive everything LinkedIn-API-shaped anyway, so a payload arriving on an
 * endpoint nobody predicted is still on disk and still counted. A specific
 * pattern with zero hits next to a non-zero `unmatched_relevant` is the
 * finding this probe exists to produce.
 */
export const ACTIVITY_PATTERNS: readonly TieredPattern[] = [
  // The feed/updates GraphQL surface — what a person's own posts most likely
  // arrive on.
  { name: "gql-feed-profile-updates", tier: "specific", match: "voyagerFeedDashProfileUpdates" },
  { name: "gql-feed-updates", tier: "specific", match: "voyagerFeedDashUpdates" },
  { name: "gql-feed-profile-recent-activity", tier: "specific", match: "voyagerFeedDashProfileRecentActionUpdates" },
  // Reactions and comments the person *made* — `profile.activity` (spec §9).
  { name: "gql-social-reactions", tier: "specific", match: "voyagerSocialDashReactions" },
  { name: "gql-social-comments", tier: "specific", match: "voyagerSocialDashComments" },
  // A single post's own detail plus its reactor / commenter lists — `post.get`.
  { name: "gql-social-activity-counts", tier: "specific", match: "voyagerSocialDashSocialActivityCounts" },
  { name: "gql-social-detail", tier: "specific", match: "voyagerSocialDashSocialDetails" },
  // The pre-GraphQL REST surface. Still answered for some clients.
  { name: "rest-feed-updates", tier: "specific", match: "/voyager/api/feed/updates" },
  { name: "rest-social-comments", tier: "specific", match: "/voyager/api/feed/comments" },

  // The nets.
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  { name: "linkedin-api", tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

/** The net every capture is measured against, and the one `waitFor` waits on.
 *  Same name as `profile.capture`'s so the two summaries read alike. */
export const BROAD_PATTERN_NAME = "linkedin-api";

/**
 * Substrings that only appear in a body carrying post, comment or reaction data.
 *
 * Content-based, for the same reason `isProfileIsh` is: whether a response is
 * *about activity* is a fact about its body, and asking the URL instead would
 * make the pattern-vs-reality answer depend on the guess it is checking.
 *
 * Note what is deliberately **absent**: `urn:li:fsd_profile`. Every post card
 * names its author, so a person-urn marker would call every body relevant and
 * the summary would say the same thing on every run.
 */
const ACTIVITY_MARKERS = [
  "urn:li:activity:",
  "urn:li:ugcPost:",
  "urn:li:share:",
  "urn:li:comment:",
  "urn:li:fsd_update:",
  "urn:li:fsd_comment:",
  "urn:li:fsd_reaction:",
  '"socialDetail"',
  '"reactionTypeCounts"',
  '"numComments"',
];

/** True when a captured body carries post/comment/reaction data. */
export function isActivityIsh(body: string): boolean {
  return ACTIVITY_MARKERS.some((marker) => body.includes(marker));
}

/** The urn families this probe inventories, and the pattern that finds each. */
const URN_FAMILIES: Readonly<Record<string, RegExp>> = {
  activity: /urn:li:activity:\d+/g,
  ugcPost: /urn:li:ugcPost:\d+/g,
  share: /urn:li:share:\d+/g,
  comment: /urn:li:(?:fsd_)?comment:[^"'\s,)\]]+/g,
  person: /urn:li:(?:fsd_profile|fs_profile|fs_salesProfile|member):[A-Za-z0-9_-]+/g,
  company: /urn:li:(?:fsd_company|fs_normalized_company|company):[A-Za-z0-9_-]+/g,
};

/**
 * How many *distinct* urns of each family a text carries. Never the urns.
 *
 * Bounded: at most `MAX_URNS_PER_FAMILY` distinct values are retained per
 * family, and `truncated` says when that bit. A 1MB activity page holds
 * thousands of urns, and an unbounded set built once per captured body is the
 * kind of quiet growth review has already caught here once.
 */
export const MAX_URNS_PER_FAMILY = 500;

export type UrnInventory = {
  /** Distinct urns seen per family, capped at `MAX_URNS_PER_FAMILY`. */
  distinct: Record<string, number>;
  /** Total occurrences per family, uncapped — a count, not a set. */
  total: Record<string, number>;
  /** Families whose distinct set hit the cap. */
  truncated: string[];
};

export function urnInventory(text: string): UrnInventory {
  const distinct: Record<string, number> = {};
  const total: Record<string, number> = {};
  const truncated: string[] = [];

  for (const [family, pattern] of Object.entries(URN_FAMILIES)) {
    const seen = new Set<string>();
    let count = 0;
    let capped = false;
    for (const match of text.matchAll(pattern)) {
      count++;
      if (seen.size < MAX_URNS_PER_FAMILY) seen.add(match[0]);
      else if (!seen.has(match[0])) capped = true;
    }
    distinct[family] = seen.size;
    total[family] = count;
    if (capped) truncated.push(family);
  }
  return { distinct, total, truncated };
}

/**
 * How many of a text's person urns are the *session's* own.
 *
 * The whole subject-vs-stranger question on this surface runs through here.
 * `sessionUrns` is always `sessionUrnsOf`'s output — never re-derived — and a
 * page whose only resolvable person is the operator is the D119/D126 trap
 * reported rather than parsed.
 */
export function sessionUrnHits(text: string, sessionUrns: readonly string[]): number {
  return sessionUrns.filter((urn) => urn !== "" && text.includes(urn)).length;
}

/** The document watches for one activity target. */
export const ACTIVITY_DOCUMENT_NAME = "activity-document";
export const ACTIVITY_DOCUMENT_CANONICAL_NAME = "activity-document-canonical";

/** `/posts/<slug>` and `/feed/update/<urn>/` are the same post, and LinkedIn
 *  redirects the first to the second. */
const POSTS_PERMALINK = /^https:\/\/[a-z0-9.-]*linkedin\.com\/posts\//i;

/**
 * The document responses to watch for one target — one watch, or two.
 *
 * A `/posts/<slug>` permalink commonly 302s to `/feed/update/<urn>/`, so the
 * document that actually answers is at a path the target url never named. The
 * broad net cannot cover the gap: it matches API paths, and this is a page. One
 * pattern would therefore capture no document at all on exactly the surface
 * where a server-rendered payload is most likely (D116/D117), and the probe
 * would report "nothing was server-rendered" about a body it never watched for.
 *
 * Both are `specific`, so neither shows up as an endpoint nobody predicted.
 */
export function activityDocumentPatterns(target: {
  url: string;
  postUrn?: string | undefined;
}): TieredPattern[] {
  const patterns = [documentPattern(target.url, ACTIVITY_DOCUMENT_NAME)];
  if (target.postUrn !== undefined && POSTS_PERMALINK.test(target.url)) {
    patterns.push(
      documentPattern(
        `https://www.linkedin.com/feed/update/${target.postUrn}/`,
        ACTIVITY_DOCUMENT_CANONICAL_NAME,
      ),
    );
  }
  return patterns;
}
