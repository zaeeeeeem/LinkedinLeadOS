import type { Capture, CaptureMiss, WatchPattern } from "../../core/tap/network-tap.js";

/**
 * A watched pattern plus how much it claims to know.
 *
 * `specific` patterns are this build's guess at which endpoints a profile page
 * fetches. `broad` patterns are the safety net that makes the guess *checkable*:
 * they match anything LinkedIn-API-shaped, so a profile payload arriving on an
 * endpoint nobody predicted is still archived and still counted, instead of
 * being invisible. The difference between the two tiers is the whole reason the
 * summary can answer "did the patterns describe reality".
 */
export type TieredPattern = WatchPattern & { tier: "specific" | "broad" };

/** Where LinkedIn's own API traffic lives. Anything under these is fair game
 *  for the broad net; static assets are served from other hosts entirely. */
const API_PATH_MARKERS = ["/voyager/api/", "/sales-api/", "/graphql", "/api/graphql"];

/** True for a LinkedIn URL that looks like an API call rather than a page, an
 *  asset, or a tracking beacon. Exported because the broad pattern is the one
 *  piece of this module whose behaviour on real traffic must be checkable. */
export function isLinkedInApiUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return false;
  const path = url.pathname.toLowerCase();
  // LinkedIn's own client telemetry. It is API-shaped, it is high volume, and it
  // never carries profile data — archiving it would bury the fixtures.
  if (path.startsWith("/li/track") || path.includes("/perftracker")) return false;
  return API_PATH_MARKERS.some((marker) => path.includes(marker));
}

/**
 * The endpoints a `/in/` profile page is *expected* to fetch, plus the nets that
 * catch what it actually fetches.
 *
 * The specific names are deliberately plausible-but-unproven: they come from the
 * shape of LinkedIn's current GraphQL surface (`voyagerIdentityDash*` query ids)
 * and from the reference worker's Sales Navigator experience. Task 15's live run
 * is what decides which of them are real. That is why every one of them is
 * reported with its own hit count on the receipt — a pattern with zero hits next
 * to a non-zero `unmatched_profile_ish` is the finding, not a silent no-op.
 */
export const PROFILE_PATTERNS: readonly TieredPattern[] = [
  // GraphQL query ids: the `queryId=voyagerIdentityDash…` parameter names the
  // operation, and it is the closest thing LinkedIn has to a stable endpoint id.
  { name: "gql-identity-profiles", tier: "specific", match: "voyagerIdentityDashProfiles" },
  { name: "gql-profile-cards", tier: "specific", match: "voyagerIdentityDashProfileCards" },
  { name: "gql-profile-components", tier: "specific", match: "voyagerIdentityDashProfileComponents" },
  { name: "gql-profile-positions", tier: "specific", match: "voyagerIdentityDashProfilePositionGroups" },
  // The pre-GraphQL REST surface. Still answered for some clients.
  { name: "rest-identity-dash-profiles", tier: "specific", match: "/voyager/api/identity/dash/profiles" },
  { name: "rest-identity-profiles", tier: "specific", match: "/voyager/api/identity/profiles/" },
  // Sales Navigator's profile endpoint, verified in the reference worker.
  { name: "salesapi-profiles", tier: "specific", match: "salesApiProfiles" },

  // The nets.
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  { name: "linkedin-api", tier: "broad", match: (url: string) => isLinkedInApiUrl(url) },
];

/** The net every capture is measured against, and the one `waitFor` waits on. */
export const BROAD_PATTERN_NAME = "linkedin-api";

/** The navigation response for the profile being captured. */
export const DOCUMENT_PATTERN_NAME = "profile-document";

/**
 * Identity of a LinkedIn *page* url, for comparing two spellings of one document.
 *
 * Query, fragment, trailing slash, host subdomain and case are all discarded:
 * LinkedIn appends `trk`/`lipi` to its own in-app links, serves `ca.linkedin.com`
 * and `www.linkedin.com` interchangeably, and a redirect can drop the trailing
 * slash. None of those change which document was served. `null` for anything
 * unparseable or not LinkedIn's, so a non-match is never a throw.
 */
function documentKey(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  return url.pathname.replace(/\/+$/, "").toLowerCase();
}

/**
 * Watches the initial document response for one specific profile url.
 *
 * `/in/<vanity>` is a page, not an API path, so `isLinkedInApiUrl` rejects it and
 * the broad net cannot see it — the document has to be named. D116 measured that
 * across two live loads of one profile, 24–25 API responses were captured and not
 * one carried the subject's content, while `urn:li:fsd_profile` was present in
 * `outerHTML` at 3.1s and gone at 4.6s. That is what a server-rendered payload
 * consumed on hydration looks like, and this pattern is what turns it from an
 * inference into a captured body.
 *
 * Reading fields out of that body is governed by D117: the JSON LinkedIn embeds
 * in the document is fair game, addressed by a path into the parsed JSON; markup,
 * element text and CSS selectors are not.
 *
 * The match is exact on the target document. It deliberately does not match the
 * profile's sub-pages or the API calls about the same person — the question it
 * answers is "did the payload arrive in the navigation response", and a pattern
 * that also caught the Voyager calls could not answer it.
 *
 * `name` exists because a run that loads several documents needs one watch per
 * document to tell their hit counts apart: five patterns all called
 * `profile-document` would report as one row and answer nothing (Task 21 loads
 * five company sub-pages). Omitted, the name is unchanged.
 */
export function documentPattern(targetUrl: string, name: string = DOCUMENT_PATTERN_NAME): TieredPattern {
  const wanted = documentKey(targetUrl);
  return {
    name,
    tier: "specific",
    match: (url: string) => wanted !== null && documentKey(url) === wanted,
  };
}

/** The `specific` names among a given pattern list. Derived from the list the
 *  caller actually watched, not from `PROFILE_PATTERNS`: a pattern built at run
 *  time for one target (`documentPattern`) is specific, and measuring it against
 *  the static constant would report every hit on it as an endpoint nobody
 *  predicted — a `PATTERN_MISMATCH` warning about the one pattern that matched. */
function specificNames(patterns: readonly TieredPattern[]): ReadonlySet<string> {
  return new Set(patterns.filter((p) => p.tier === "specific").map((p) => p.name));
}

/**
 * Substrings that only appear in a body carrying person data.
 *
 * This is content-based on purpose. Whether a response is *about a person* is a
 * fact about its body, and the body is the one thing the tap always has; asking
 * the URL instead would make the "did our patterns match reality" answer depend
 * on the same guess it is supposed to be checking.
 */
const PROFILE_MARKERS = [
  "urn:li:fsd_profile:",
  "urn:li:fs_profile:",
  "urn:li:fsd_profilePosition:",
  "urn:li:member:",
  '"publicIdentifier"',
  "urn:li:fs_salesProfile:",
];

/** True when a captured body carries person data. */
export function isProfileIsh(body: string): boolean {
  return PROFILE_MARKERS.some((marker) => body.includes(marker));
}

/** One endpoint the page actually hit, in a form that is safe on stdout. */
export type EndpointRow = {
  /** Path only. The query string carries `variables=(vanityName:…)`, which is
   *  captured LinkedIn data and does not belong on a receipt. */
  path: string;
  /** The GraphQL operation name, when the URL named one. An endpoint id, not data. */
  query_id: string | null;
  status: number;
  bytes: number;
  shape_hash: string;
  /** The archived filename, so the operator can go read the body. */
  file: string;
  patterns: string[];
  profile_ish: boolean;
  /** True when no `specific` pattern matched — the responses this build did not
   *  predict. Combined with `profile_ish`, this is the pattern-vs-reality answer. */
  unpredicted: boolean;
};

export type PatternReport = {
  name: string;
  tier: "specific" | "broad";
  hits: number;
  profile_ish: number;
  misses: number;
};

export type CaptureSummary = {
  patterns: PatternReport[];
  captured: number;
  profile_ish: number;
  /**
   * Profile-carrying responses that no `specific` pattern matched. Zero means
   * the watched patterns describe reality; anything else names exactly how many
   * endpoints moved, and `endpoints` says which.
   */
  unmatched_profile_ish: number;
  misses: number;
  endpoints: EndpointRow[];
};

/** Pulls the GraphQL operation id out of a Voyager URL, when there is one. */
export function queryIdOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get("queryId");
  } catch {
    return null;
  }
}

function pathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "(unparseable url)";
  }
}

/**
 * Turns what the tap saw into the receipt's capture summary.
 *
 * Pure: it reads captures and misses and touches nothing. The counts it produces
 * are the acceptance evidence for this whole task, so they are computed in one
 * tested function rather than inline in the capability where nothing checks them.
 *
 * `isRelevant` decides which bodies count as carrying the subject's data — the
 * `profile_ish` columns below. It is injectable because "a body about a person"
 * and "a body about a company" are different questions asked of the same
 * machinery, and a second copy of this function is how the two would drift
 * apart. Omitted, it is `isProfileIsh` and nothing changes.
 */
export function summarizeCaptures(
  captures: readonly Capture[],
  misses: readonly CaptureMiss[],
  patterns: readonly TieredPattern[] = PROFILE_PATTERNS,
  o: { isRelevant?: (body: string) => boolean } = {},
): CaptureSummary {
  const isRelevant = o.isRelevant ?? isProfileIsh;
  const specific = specificNames(patterns);
  const endpoints: EndpointRow[] = captures.map((c) => {
    const profileIsh = isRelevant(c.body);
    return {
      path: pathOf(c.url),
      query_id: queryIdOf(c.url),
      status: c.status,
      bytes: c.bytes,
      shape_hash: c.archived.shapeHash,
      file: c.archived.file,
      patterns: c.patterns,
      profile_ish: profileIsh,
      unpredicted: !c.patterns.some((name) => specific.has(name)),
    };
  });

  const report: PatternReport[] = patterns.map((p) => {
    const hit = endpoints.filter((e) => e.patterns.includes(p.name));
    return {
      name: p.name,
      tier: p.tier,
      hits: hit.length,
      profile_ish: hit.filter((e) => e.profile_ish).length,
      misses: misses.filter((m) => m.patterns.includes(p.name)).length,
    };
  });

  return {
    patterns: report,
    captured: endpoints.length,
    profile_ish: endpoints.filter((e) => e.profile_ish).length,
    unmatched_profile_ish: endpoints.filter((e) => e.profile_ish && e.unpredicted).length,
    misses: misses.length,
    endpoints,
  };
}
