import { isLinkedInDataUrl, type TieredPattern } from "../profile.capture/patterns.js";
import type { SalesNavSurface } from "./url.js";

/**
 * What a Sales Navigator search is expected to fetch, and the nets that catch
 * what it actually fetches.
 *
 * Two tiers, exactly as `PROFILE_PATTERNS` (D110): the `specific` names are this
 * build's *guess*, and the `broad` nets are what make the guess checkable — a
 * lead payload arriving on an endpoint nobody predicted is still archived, still
 * counted, and shows up on the receipt as unmatched. That number is the probe's
 * headline finding, not an error.
 *
 * The specific names come from the reference worker, which lived on this surface
 * — `salesApiProfiles` is the one it captured by name. They are a starting
 * guess and nothing more: this task exists because the worker read its *result
 * rows* from the DOM and only ever saw `salesApiProfiles` after clicking a lead
 * panel open, so whether a cold search page carries a labeled body at all is
 * unmeasured.
 */
export const SALESNAV_PATTERNS: readonly TieredPattern[] = [
  // The search endpoints themselves — what a results page would fetch if the
  // rows come from the network at all.
  { name: "salesapi-lead-search", tier: "specific", match: "salesApiLeadSearch" },
  { name: "salesapi-account-search", tier: "specific", match: "salesApiAccountSearch" },
  { name: "salesapi-people-search", tier: "specific", match: "salesApiPeopleSearch" },
  // Per-entity endpoints. The reference worker captured `salesApiProfiles` only
  // after opening a lead panel — an interaction this toolkit does not perform —
  // so a hit here on a cold load would itself be a finding.
  { name: "salesapi-profiles", tier: "specific", match: "salesApiProfiles" },
  { name: "salesapi-companies", tier: "specific", match: "salesApiCompanies" },
  // Saved searches. Task 37's surface; watched here because a search page that
  // fetches them for free tells Task 37 where to look for nothing.
  { name: "salesapi-saved-searches", tier: "specific", match: "salesApiSavedSearches" },
  // Sales Navigator's GraphQL surface, if this build serves one.
  { name: "gql-sales", tier: "specific", match: "voyagerSalesDash" },

  // The nets.
  { name: "sales-api-any", tier: "broad", match: "/sales-api/" },
  { name: "gql-any", tier: "broad", match: "/voyager/api/graphql" },
  // The **widest** net, and deliberately wider than `company.probe`'s.
  //
  // `isLinkedInApiUrl` only matches paths this repo already believes LinkedIn
  // serves data from, which is a guess wearing a safety net's clothes — the
  // `/jobs/view/` probe reported `misses: 0` with no job endpoint captured,
  // and the honest reading was "nothing was watching outside `/voyager/`".
  // This probe's entire product is a source verdict, so it takes the noisier
  // net that can prove its own prediction wrong.
  { name: "linkedin-data", tier: "broad", match: (url: string) => isLinkedInDataUrl(url) },
];

/** The net every capture is measured against, and the one `waitFor` waits on. */
export const BROAD_PATTERN_NAME = "linkedin-data";

/** The watch name for one surface's own navigation response. One per surface,
 *  because watches sharing a name report as one row and could not answer which
 *  document carried what (D120). */
export function documentPatternName(surface: SalesNavSurface): string {
  return `document-${surface}`;
}

/**
 * Substrings that only appear in a body carrying *Sales Navigator* data.
 *
 * Content-based, for `isProfileIsh`'s reason: whether a response is about this
 * surface is a fact about its body, and asking the url instead would make the
 * "did our patterns match reality" answer depend on the same guess it exists to
 * check.
 *
 * Both the Sales-Nav-only urn namespaces and the ordinary Voyager ones are
 * listed. A search result row may well carry a plain `fsd_profile` urn — that is
 * one of the things Task 38 needs to know — and a marker list narrow enough to
 * be "Sales Nav only" would report a page full of leads as carrying nothing.
 */
const SALESNAV_MARKERS = [
  // Sales Navigator's own namespaces.
  "urn:li:fs_salesProfile:",
  "urn:li:fs_salesCompany:",
  "urn:li:fs_salesLead:",
  "urn:li:fs_salesAccount:",
  "urn:li:fs_salesSavedSearch:",
  "urn:li:fs_salesSearchHistory:",
  // The ordinary namespaces a row may carry instead.
  "urn:li:fsd_profile:",
  "urn:li:fsd_company:",
  "urn:li:member:",
  "urn:li:organization:",
  // The lead permalink form. `/sales/lead/<id>` is how the rendered card links
  // to a lead, so a body carrying one is carrying a result row.
  "/sales/lead/",
  "/sales/company/",
];

/** True when a captured body carries Sales Navigator result data. */
export function isSalesNavIsh(body: string): boolean {
  return SALESNAV_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Substrings that mark a body as an **upsell / no-seat** response.
 *
 * The seat check's second source of evidence. The first is the landed url —
 * `/sales/` redirecting away is the loud signal — and this catches the quieter
 * case where the app root renders a paywall in place at the same url.
 *
 * Deliberately not a challenge: a missing seat is a *product* state, not a
 * defence. It ends the task with a decision for the operator (Task 36), never
 * a retry and never a workaround.
 */
const UPSELL_MARKERS = [
  "/sales/gold/",
  "premiumUpsell",
  "salesApiUpsell",
  "free-trial",
  "checkout/subscribe",
];

/** True when a captured body or landed url looks like a Sales Navigator
 *  upsell rather than the app. Case-insensitive: these are marketing paths and
 *  their casing is not something to depend on. */
export function looksLikeUpsell(text: string): boolean {
  const lower = text.toLowerCase();
  return UPSELL_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
}
