import { CapabilityError, EXIT } from "../../core/run/receipt.js";

/**
 * The sub-pages of one company, in the order the probe loads them.
 *
 * `main` first because it is the page every other one is reached from and the
 * one a `company.get` would load; the rest in the order Tasks 22–25 consume
 * them. Each is a *separate document* here — the probe navigates to each url
 * cold rather than clicking LinkedIn's own tabs, and whether that is the only
 * way is one of the things it measures (see `surface.ts`, `tabs`).
 */
export const COMPANY_SUBPAGES = ["main", "about", "posts", "people", "jobs"] as const;
export type CompanySubPage = (typeof COMPANY_SUBPAGES)[number];

/** The path segment each sub-page hangs off the company base url. `main` has
 *  none — it *is* the base url. */
const SUBPAGE_SEGMENT: Readonly<Record<CompanySubPage, string>> = {
  main: "",
  about: "about/",
  posts: "posts/",
  people: "people/",
  jobs: "jobs/",
};

/**
 * A company target, canonicalized. Everything downstream — the navigation, the
 * ledger's dedupe ref, the receipt — reads these fields and never the
 * operator's raw input.
 */
export type CompanyTarget = {
  kind: "company";
  /** The `/company/<vanity>/` url. `main`'s navigation target. */
  url: string;
  /** Stable identity for this target. Prefixed by kind so it can never collide
   *  with `profile.capture`'s `in:`/`lead:` refs in the same ledger. */
  ref: string;
  /** Percent-decoded, for display and the ref. LinkedIn accepts a numeric
   *  company id in the same position, so this is not always a word. */
  vanity: string;
  /** The raw path segment, kept escaped exactly as LinkedIn's own links spell
   *  it — re-encoding a decoded slug is where a navigable url becomes a 404. */
  segment: string;
};

/** What a LinkedIn company slug can be: the vanity name, or the numeric id
 *  LinkedIn serves the same page under. */
const COMPANY_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,99}$/u;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_LINKEDIN_HOST = /^\/?(?:[a-z0-9-]+\.)*linkedin\.com\//i;

const ACCEPTED =
  "accepted forms: https://www.linkedin.com/company/<vanity>, a bare /company/<vanity> path, " +
  "or a bare <vanity> slug";

function invalid(input: string, why: string): CapabilityError {
  return new CapabilityError({
    code: "COMPANY_URL_INVALID",
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

/** Percent-decoding that cannot throw on a malformed escape. */
function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function companyTarget(input: string, rawSegment: string): CompanyTarget {
  const vanity = decodeSafely(rawSegment);
  if (!COMPANY_SLUG.test(vanity)) {
    throw invalid(input, `"${vanity}" is not a usable LinkedIn company slug`);
  }
  return {
    kind: "company",
    url: `https://www.linkedin.com/company/${rawSegment}/`,
    ref: `company:${vanity.toLowerCase()}`,
    vanity,
    segment: rawSegment,
  };
}

/**
 * Turns whatever the operator passed into one canonical company target, or
 * refuses it loudly.
 *
 * Pure and total: no I/O, no network, one error class, and it runs before
 * anything is navigated or spent, so a typo costs nothing.
 *
 * Canonicalization drops every query parameter and every sub-path, for
 * `normalizeProfileUrl`'s reason (D113): no company page needs a parameter to
 * decide what it renders, a tracking-key deny-list goes stale, and
 * `/company/acme/about/` is a different page of the same company — which this
 * probe loads deliberately, from `companySubPageUrl`, never by accident from
 * the operator pasting one.
 *
 * `/showcase/` and `/school/` render a related but *not* identical surface and
 * are refused by name rather than silently treated as companies. Nothing has
 * measured them, and a probe that reported a school page's field map as a
 * company's would be worse than one that refused.
 */
export function normalizeCompanyUrl(rawInput: string): CompanyTarget {
  const input = rawInput.trim();
  if (input === "") throw invalid(rawInput, "the company url is empty");

  // A bare `company/<slug>` or `/company/<slug>`, which is neither a url nor a slug.
  const barePath = /^\/?company\/([^/?#]+)/i.exec(input);
  if (barePath && !HAS_SCHEME.test(input)) return companyTarget(input, barePath[1]!);

  const looksLikeUrl = HAS_SCHEME.test(input) || BARE_LINKEDIN_HOST.test(input);
  if (!looksLikeUrl) {
    if (!COMPANY_SLUG.test(input)) {
      throw invalid(rawInput, `"${input}" is neither a url nor a usable LinkedIn company slug`);
    }
    return companyTarget(input, encodeURIComponent(input));
  }

  if (HAS_SCHEME.test(input) && !/^https?:/i.test(input)) {
    throw invalid(rawInput, "only http and https urls are accepted");
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

  if (head === "company") {
    const slug = segments[1];
    if (slug === undefined) throw invalid(rawInput, "the url has no company segment after /company/");
    return companyTarget(rawInput, slug);
  }

  if (head === "showcase" || head === "school") {
    throw invalid(
      rawInput,
      `/${head}/ is a related LinkedIn page family and nothing has measured it; this probe covers /company/ only`,
    );
  }

  throw invalid(rawInput, `${url.pathname} is not a company url`);
}

/**
 * The url one sub-page of a company is loaded from.
 *
 * Trailing slash always, because that is the form LinkedIn's own tab links use
 * and the form its canonical redirect settles on — and because the probe
 * records the url it *landed* on beside the one it asked for, a redirect away
 * from this shows up as a measurement rather than as a silent difference.
 */
export function companySubPageUrl(target: CompanyTarget, sub: CompanySubPage): string {
  return `https://www.linkedin.com/company/${target.segment}/${SUBPAGE_SEGMENT[sub]}`;
}

/** True for a name that is one of the five sub-pages. */
export function isCompanySubPage(value: string): value is CompanySubPage {
  return (COMPANY_SUBPAGES as readonly string[]).includes(value);
}

/**
 * Parses `--subpages=main,about` into a de-duplicated list in load order.
 *
 * Order is `COMPANY_SUBPAGES`' order, not the operator's: the loads are
 * sequential page loads on the one account, and which order they happen in is a
 * pacing property of the probe rather than something a flag should reshuffle.
 */
export function parseSubPages(raw: string | undefined): CompanySubPage[] {
  if (raw === undefined || raw.trim() === "") return [...COMPANY_SUBPAGES];
  const asked = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
  const unknown = asked.filter((s) => !isCompanySubPage(s));
  if (unknown.length > 0) {
    throw new CapabilityError({
      code: "COMPANY_SUBPAGE_UNKNOWN",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message:
        `unknown sub-page(s) ${unknown.join(", ")}; known sub-pages: ${COMPANY_SUBPAGES.join(", ")}`,
      evidence: raw,
    });
  }
  const wanted = new Set(asked);
  return COMPANY_SUBPAGES.filter((s) => wanted.has(s));
}
