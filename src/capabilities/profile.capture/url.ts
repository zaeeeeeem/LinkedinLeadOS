import { CapabilityError, EXIT } from "../../core/run/receipt.js";

/**
 * A profile target, canonicalized. Everything downstream — the navigation, the
 * budget's `profile_open` dedupe key, the receipt — reads these three fields and
 * never the operator's raw input.
 */
export type ProfileTarget = {
  kind: "profile" | "sales-lead";
  /** The URL the worker tab navigates to. Query and fragment are always gone. */
  url: string;
  /**
   * Stable identity for this target: the `ref` §8's `profile_open` limit dedupes
   * on, and the item ref on events. Lower-cased, prefixed by kind, so a Sales
   * Navigator lead and an `/in/` vanity can never collide.
   */
  ref: string;
  /** Present for `kind: "profile"` — percent-decoded, for display and the ref. */
  vanity?: string;
  /** Present for `kind: "sales-lead"` — the member id, without the name tuple. */
  leadId?: string;
};

/** What a LinkedIn vanity slug can be. Letters (any script), digits, hyphens. */
const VANITY = /^[\p{L}\p{N}][\p{L}\p{N}-]{2,99}$/u;

/** `scheme:` at the front, per RFC 3986. Detected before anything else, because
 *  `javascript:` and `file:` must be refused rather than guessed at. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A bare `linkedin.com/...` or `xx.linkedin.com/...` with the scheme left off —
 *  what pasting from a browser's address bar produces. */
const BARE_LINKEDIN_HOST = /^\/?(?:[a-z0-9-]+\.)*linkedin\.com\//i;

const ACCEPTED =
  "accepted forms: https://www.linkedin.com/in/<vanity>, a bare <vanity> slug, " +
  "or https://www.linkedin.com/sales/lead/<leadId>";

function invalid(input: string, why: string): CapabilityError {
  return new CapabilityError({
    code: "PROFILE_URL_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `${why}; ${ACCEPTED}`,
    // The operator typed this, so echoing it back leaks nothing they do not
    // already have, and a receipt that omits it cannot be acted on.
    evidence: input.length > 300 ? `${input.slice(0, 300)}… (${input.length} chars)` : input,
  });
}

function isLinkedInHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "linkedin.com" || h.endsWith(".linkedin.com");
}

/** Percent-decoding that cannot throw on a malformed escape — a `%` that is not
 *  an escape is a character, not a reason to fail. */
function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function profileTarget(input: string, rawSegment: string): ProfileTarget {
  const vanity = decodeSafely(rawSegment);
  if (!VANITY.test(vanity)) {
    throw invalid(input, `"${vanity}" is not a usable LinkedIn vanity slug`);
  }
  return {
    kind: "profile",
    // The raw segment, not the decoded one: it is already in the escaped form
    // LinkedIn's own links use, and re-encoding a decoded string is where a
    // navigable URL turns into a 404.
    url: `https://www.linkedin.com/in/${rawSegment}/`,
    ref: `in:${vanity.toLowerCase()}`,
    vanity,
  };
}

/**
 * Turns whatever the operator passed into one canonical profile target, or
 * refuses it loudly.
 *
 * Pure and total: no I/O, no network, one error class. It runs before anything
 * is navigated or spent, so a typo costs nothing — which is the whole reason it
 * is a separate module with its own tests rather than a few lines inside `run`.
 *
 * Canonicalization drops **every** query parameter rather than a deny-list of
 * known tracking keys. No `/in/` or `/sales/lead/` page needs a parameter to
 * decide what it renders, and a deny list is a list that goes stale: `trk`,
 * `lipi`, `licu`, `original_referer` and `miniProfileUrn` are the ones seen
 * today, and the next one would arrive unhandled. Sub-paths (`/details/…`,
 * `/recent-activity/…`, `/overlay/…`) collapse to the base profile — they are
 * different pages of the same person, and this capability captures the profile.
 */
export function normalizeProfileUrl(rawInput: string): ProfileTarget {
  const input = rawInput.trim();
  if (input === "") throw invalid(rawInput, "the profile url is empty");

  // A bare `in/<vanity>` or `/in/<vanity>`, which is neither a URL nor a slug.
  const bareInPath = /^\/?in\/([^/?#]+)/i.exec(input);
  if (bareInPath && !HAS_SCHEME.test(input)) return profileTarget(input, bareInPath[1]!);

  const looksLikeUrl = HAS_SCHEME.test(input) || BARE_LINKEDIN_HOST.test(input);
  if (!looksLikeUrl) {
    // Nothing URL-shaped left: it is a vanity slug or it is a mistake.
    if (!VANITY.test(input)) {
      throw invalid(rawInput, `"${input}" is neither a url nor a usable LinkedIn vanity slug`);
    }
    return profileTarget(input, encodeURIComponent(input));
  }

  if (HAS_SCHEME.test(input) && !/^https?:/i.test(input)) {
    throw invalid(rawInput, `only http and https urls are accepted`);
  }

  const withScheme = HAS_SCHEME.test(input) ? input : `https://${input.replace(/^\//, "")}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalid(rawInput, "the url could not be parsed");
  }

  if (!isLinkedInHost(url.hostname)) {
    throw invalid(rawInput, `${url.hostname} is not a linkedin.com host`);
  }

  const segments = url.pathname.split("/").filter((s) => s !== "");
  const head = (segments[0] ?? "").toLowerCase();

  if (head === "in") {
    const vanitySegment = segments[1];
    if (vanitySegment === undefined) throw invalid(rawInput, "the url has no vanity segment after /in/");
    return profileTarget(rawInput, vanitySegment);
  }

  if (head === "sales" && (segments[1] ?? "").toLowerCase() === "lead") {
    const leadSegment = segments[2];
    if (leadSegment === undefined) throw invalid(rawInput, "the sales navigator url has no lead id");
    // `ACwAAA…,NAME_SEARCH,a1b2` — the first component is the member id and the
    // rest is provenance. The whole segment stays in the URL because that is the
    // form LinkedIn's own links use; only the id decides identity.
    const leadId = leadSegment.split(",")[0]!;
    if (leadId === "") throw invalid(rawInput, "the sales navigator url has no lead id");
    return {
      kind: "sales-lead",
      url: `https://www.linkedin.com/sales/lead/${leadSegment}`,
      ref: `lead:${decodeSafely(leadId).toLowerCase()}`,
      leadId: decodeSafely(leadId),
    };
  }

  if (head === "pub") {
    throw invalid(
      rawInput,
      "/pub/ is LinkedIn's legacy profile url form and this capability does not handle it",
    );
  }

  throw invalid(rawInput, `${url.pathname} is not a profile url`);
}
