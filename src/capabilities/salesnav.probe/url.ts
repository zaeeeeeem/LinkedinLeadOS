import { CapabilityError, EXIT } from "../../core/run/receipt.js";

/**
 * The Sales Navigator surfaces this probe loads, in load order.
 *
 * `home` is first and is the **seat check**: `/sales/` either renders the app or
 * an upsell page, and an upsell page ends the task rather than being worked
 * around (Task 36). Everything after it is a metered results page.
 */
export const SALESNAV_SURFACES = ["home", "leads", "leads2", "accounts"] as const;
export type SalesNavSurface = (typeof SALESNAV_SURFACES)[number];

/** Surfaces that cost a metered `search_page` on top of their page load.
 *  `home` is the app shell — a page load, and no search runs (D343). */
const SEARCH_PAGE_SURFACES: ReadonlySet<SalesNavSurface> = new Set(["leads", "leads2", "accounts"]);

/** True when loading this surface runs a search and must be metered as one. */
export function isSearchPage(surface: SalesNavSurface): boolean {
  return SEARCH_PAGE_SURFACES.has(surface);
}

/** The Sales Navigator app root. The seat check's target and nothing else. */
export const SALESNAV_HOME_URL = "https://www.linkedin.com/sales/";

/**
 * Where a bare, unfiltered search lands when the operator names no target.
 *
 * These are LinkedIn's own default search tabs, not invented filter urls —
 * M6 owns filter building (`salesnav.filters.build`), and a probe that
 * synthesized a filter query would be measuring a page the product does not
 * itself produce.
 */
export const DEFAULT_LEADS_SEARCH_URL = "https://www.linkedin.com/sales/search/people";
export const DEFAULT_ACCOUNTS_SEARCH_URL = "https://www.linkedin.com/sales/search/company";

/**
 * One Sales Navigator search target, canonicalized.
 *
 * **Query parameters are preserved, unlike every other target in this repo.**
 * `normalizeProfileUrl` and `normalizeCompanyUrl` drop them on D113's reasoning:
 * no profile or company page needs a parameter to decide what it renders. A
 * search is the opposite — `query=`, `savedSearchId=` and `sessionId=` *are*
 * the target, and stripping them would silently probe a different search than
 * the operator named. What is dropped is the fragment and nothing else.
 */
export type SalesNavTarget = {
  kind: "salesnav-search";
  /** The url to navigate to, parameters intact. */
  url: string;
  /** Stable identity for the ledger's dedupe ref and the run log. Prefixed by
   *  kind so it can never collide with `in:` / `company:` refs in one ledger. */
  ref: string;
  /** `people` or `company` — the path segment after `/sales/search/`. */
  vertical: string;
  /**
   * The `sessionId` this url pins, when it carries one.
   *
   * Sales Navigator pins a result set — and the instant its filters were
   * evaluated — to `sessionId`. Same session, and page numbers mean the same
   * thing; new session, and they have moved. Task 39's resume turns on this, so
   * the probe measures whether it is present and where it lives rather than
   * assuming a page number is stable on its own.
   */
  sessionId: string | null;
  /** The `savedSearchId` this url names, when it names one. */
  savedSearchId: string | null;
  /** The `page` parameter already on the operator's url, if any. */
  page: number | null;
};

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_LINKEDIN_HOST = /^\/?(?:[a-z0-9-]+\.)*linkedin\.com\//i;

/** The query parameter Sales Navigator paginates on. Measured by the probe
 *  before it is ever navigated (see `index.ts`), never assumed to work. */
export const PAGE_PARAM = "page";

/** How far a `page` parameter may be from 1 before this refuses to build it. A
 *  probe reads pages 1 and 2; a reader is bounded by `MAX_PAGES_PER_RUN`. */
export const MAX_PAGE_NUMBER = 100;

const ACCEPTED =
  "accepted forms: https://www.linkedin.com/sales/search/people?…, " +
  "https://www.linkedin.com/sales/search/company?…, or a bare /sales/search/… path";

function invalid(input: string, why: string): CapabilityError {
  return new CapabilityError({
    code: "SALESNAV_URL_INVALID",
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

/**
 * Finds a parameter that may sit either as its own query key or inside the
 * percent-encoded `query=` blob Sales Navigator packs its filters into.
 *
 * Both placements are real — the reference worker hit both — and a reader that
 * checked only the query string would report `sessionId: null` on a url that
 * carries one. Bounded and total: no captured value, no throw.
 */
export function findSearchParam(rawUrl: string, name: string): string | null {
  const direct = new RegExp(`${name}(?:=|%3D)([^&%\\s"']+)`, "i");
  const hit = direct.exec(rawUrl);
  if (hit?.[1] !== undefined) return hit[1];
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    return null;
  }
  const second = direct.exec(decoded);
  return second?.[1] ?? null;
}

/** The verticals `/sales/search/<vertical>` is known to serve. Anything else is
 *  refused by name rather than probed as if it were understood. */
const KNOWN_VERTICALS = new Set(["people", "company"]);

/**
 * Turns whatever the operator passed into one canonical Sales Navigator search
 * target, or refuses it loudly.
 *
 * Pure and total: no I/O, no network, one error class, and it runs before
 * anything is navigated or spent, so a typo costs nothing — and on this surface
 * a typo would cost a metered search page, the scarcest budget in the system.
 */
export function normalizeSalesNavUrl(rawInput: string): SalesNavTarget {
  const input = rawInput.trim();
  if (input === "") throw invalid(rawInput, "the search url is empty");

  const looksLikeUrl = HAS_SCHEME.test(input) || BARE_LINKEDIN_HOST.test(input);
  const withScheme = looksLikeUrl
    ? (HAS_SCHEME.test(input) ? input : `https://${input.replace(/^\//, "")}`)
    // A bare `/sales/search/people?…` path, which is neither a url nor a slug.
    : `https://www.linkedin.com${input.startsWith("/") ? "" : "/"}${input}`;

  if (HAS_SCHEME.test(input) && !/^https?:/i.test(input)) {
    throw invalid(rawInput, "only http and https urls are accepted");
  }

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
  if ((segments[0] ?? "").toLowerCase() !== "sales") {
    throw invalid(rawInput, `${url.pathname} is not a Sales Navigator url`);
  }
  if ((segments[1] ?? "").toLowerCase() !== "search") {
    throw invalid(
      rawInput,
      `${url.pathname} is a Sales Navigator page but not a search; this probe covers /sales/search/ only`,
    );
  }
  const vertical = (segments[2] ?? "").toLowerCase();
  if (!KNOWN_VERTICALS.has(vertical)) {
    throw invalid(
      rawInput,
      `/sales/search/${vertical || "(nothing)"} is not a search vertical this probe has measured; ` +
        `known verticals: ${[...KNOWN_VERTICALS].join(", ")}`,
    );
  }

  // The fragment is dropped and the query is not — see `SalesNavTarget`.
  url.hash = "";

  const rawPage = url.searchParams.get(PAGE_PARAM);
  const page = rawPage === null ? null : Number.parseInt(rawPage, 10);
  if (rawPage !== null && (!Number.isInteger(page) || page! < 1 || page! > MAX_PAGE_NUMBER)) {
    throw invalid(rawInput, `${PAGE_PARAM}=${rawPage} is not a page number between 1 and ${MAX_PAGE_NUMBER}`);
  }

  const href = url.toString();
  const savedSearchId = findSearchParam(href, "savedSearchId");

  return {
    kind: "salesnav-search",
    url: href,
    // The saved-search id when there is one, else the vertical: a stable,
    // operator-owned handle. The full query blob is deliberately not in the ref
    // — it is long, it changes per session, and the ref reaches the run log.
    ref: `salesnav:${vertical}${savedSearchId === null ? "" : `:${savedSearchId}`}`,
    vertical,
    sessionId: findSearchParam(href, "sessionId"),
    savedSearchId,
    page,
  };
}

/**
 * The url for page N of a search, built by setting `page=N` and changing
 * nothing else.
 *
 * **Building this url is not permission to navigate it.** M5 CONTEXT rule 4:
 * a url form is a legitimate navigation only if the UI itself produces it, and
 * the reference worker refused this exact form on live-risk grounds ("jumping
 * it is the teleporting pattern that gets flagged") while still confirming the
 * url carries `page=N`. The probe measures whether page 1's own pager offers
 * this href before it spends anything on page 2 — that measurement is the
 * D350-range decision, and this function only renders the candidate.
 */
export function searchPageUrl(target: SalesNavTarget, page: number): string {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE_NUMBER) {
    throw invalid(target.url, `page ${page} is not between 1 and ${MAX_PAGE_NUMBER}`);
  }
  const url = new URL(target.url);
  url.searchParams.set(PAGE_PARAM, String(page));
  return url.toString();
}

/** True for a name that is one of the probe's surfaces. */
export function isSalesNavSurface(value: string): value is SalesNavSurface {
  return (SALESNAV_SURFACES as readonly string[]).includes(value);
}

/**
 * Parses `--surfaces=home,leads` into a de-duplicated list in load order.
 *
 * Order is `SALESNAV_SURFACES`' order, not the operator's, for
 * `parseSubPages`' reason — and for one more here: `home` is the seat check and
 * must run before anything metered, so surface order is a safety property
 * rather than a preference a flag may reshuffle.
 */
export function parseSurfaces(raw: string | undefined): SalesNavSurface[] {
  if (raw === undefined || raw.trim() === "") return [...SALESNAV_SURFACES];
  const asked = raw.split(",").map((s) => s.trim().toLowerCase()).filter((s) => s !== "");
  const unknown = asked.filter((s) => !isSalesNavSurface(s));
  if (unknown.length > 0) {
    throw new CapabilityError({
      code: "SALESNAV_SURFACE_UNKNOWN",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: `unknown surface(s) ${unknown.join(", ")}; known surfaces: ${SALESNAV_SURFACES.join(", ")}`,
      evidence: raw,
    });
  }
  const wanted = new Set(asked);
  return SALESNAV_SURFACES.filter((s) => wanted.has(s));
}
