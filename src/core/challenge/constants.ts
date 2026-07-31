/**
 * Where the challenge gate's knowledge of LinkedIn lives. Every pattern here is
 * either quoted from LinkedIn's own surface or carried forward from the
 * reference worker's live experience; anything guessed is marked UNVERIFIED and
 * is Task 15's live run to confirm or delete.
 */

/** Hosts whose pages this gate has an opinion about at all. */
export const LINKEDIN_HOST_SUFFIX = ".linkedin.com";
export const LINKEDIN_HOSTS = ["linkedin.com", "www.linkedin.com"] as const;

/**
 * How much of `document.body.innerText` the probe pulls back. A feed page's text
 * runs to tens of thousands of characters and none of it is ever logged (only a
 * matched marker is), but it still crosses the CDP socket on every gate call, so
 * it is bounded. Challenge pages are short by construction — an interstitial that
 * needs 20,000 characters before it says what it wants does not exist.
 */
export const PROBE_TEXT_LIMIT = 20_000;

/**
 * Path prefixes that are a challenge, checked before anything else and matched
 * longest-first so `/checkpoint/lg/login` (log in again, exit 4) is never read as
 * `/checkpoint/` (verification interstitial, exit 2).
 *
 * `kind` here is the URL's opinion only; the DOM can sharpen `checkpoint` into
 * `captcha` afterwards.
 */
export const CHALLENGE_PATHS: ReadonlyArray<{
  prefix: string;
  kind: "captcha" | "checkpoint" | "login" | "restricted";
  detail: string;
}> = [
  // The login flow that lives *under* /checkpoint/. Ordered before the generic
  // /checkpoint/ rule below, which is the whole reason this list is ordered.
  { prefix: "/checkpoint/lg/", kind: "login", detail: "checkpoint login form" },
  { prefix: "/checkpoint/rp/", kind: "login", detail: "checkpoint password reset" },
  // Verified in the reference worker's live runs.
  { prefix: "/checkpoint/challenge", kind: "checkpoint", detail: "checkpoint challenge" },
  // UNVERIFIED: the newer challenge surface. Harmless if it never appears — it is
  // covered by the generic /checkpoint/ rule below either way.
  { prefix: "/checkpoint/challengesV2", kind: "checkpoint", detail: "checkpoint challenge (v2)" },
  // Everything else under /checkpoint/ is a verification interstitial we have not
  // named yet. Deliberately a challenge rather than a miss.
  { prefix: "/checkpoint/", kind: "checkpoint", detail: "unnamed checkpoint interstitial" },
  // Verified in the reference worker: the logged-out wall on a public profile.
  { prefix: "/authwall", kind: "login", detail: "authwall (logged out)" },
  { prefix: "/uas/login", kind: "login", detail: "uas login" },
  { prefix: "/uas/authenticate", kind: "login", detail: "uas authenticate" },
  { prefix: "/login", kind: "login", detail: "login page" },
  { prefix: "/signup", kind: "login", detail: "signup page" },
  { prefix: "/m/login", kind: "login", detail: "mobile login" },
];

/**
 * Exact paths that are a challenge. Kept apart from the prefix list because `/`
 * as a prefix would match every URL on the site.
 *
 * Bare `/` and `/home` are the logged-out guest homepage: a logged-in session
 * redirects `/` to `/feed/`, and every URL this toolkit navigates to is a deep
 * link, so landing here means we were bounced. UNVERIFIED as a bounce signal —
 * it is reasoned from LinkedIn's redirect behaviour, not observed by us.
 */
export const CHALLENGE_EXACT_PATHS: ReadonlyArray<{
  path: string;
  kind: "login";
  detail: string;
}> = [
  { path: "/", kind: "login", detail: "logged-out guest homepage" },
  { path: "/home", kind: "login", detail: "logged-out guest homepage" },
];

/**
 * The app surface: paths a working, logged-in session legitimately sits on.
 *
 * This list is what makes an unrecognized page a halt instead of a shrug (D60).
 * It is deliberately coarse — one entry per product area, not per page — because
 * every miss here is friction on a clean run, while every miss in
 * `CHALLENGE_PATHS` is a run that keeps driving a flagged session.
 */
export const APP_PATH_PREFIXES: readonly string[] = [
  "/feed",
  "/in/",
  "/pub/",
  "/company/",
  "/school/",
  "/showcase/",
  "/groups/",
  "/jobs/",
  "/search/",
  "/posts/",
  "/pulse/",
  "/events/",
  "/newsletters/",
  "/mynetwork",
  "/messaging",
  "/notifications",
  "/my-items",
  "/premium/",
  "/services/",
  "/learning/",
  "/talent/",
  "/sales/", // Sales Navigator's whole app surface
  "/help/",
  "/legal/",
];

/**
 * Text markers, ordered most specific first within each kind. Every phrase is
 * quoted from LinkedIn's own wording (the `restricted` and `rate-limited` sets
 * come verbatim from the reference worker, which took them from LinkedIn's help
 * pages); the `captcha` set is UNVERIFIED against a live challenge page.
 *
 * Only the matched substring is ever put on a verdict or a receipt — never the
 * page text, which is captured LinkedIn data.
 */
export const TEXT_MARKERS: ReadonlyArray<{
  kind: "captcha" | "checkpoint" | "restricted" | "rate-limited";
  pattern: RegExp;
}> = [
  // UNVERIFIED — LinkedIn's security-check wording.
  { kind: "captcha", pattern: /let'?s do a quick security check/i },
  { kind: "captcha", pattern: /verify (that )?you'?re (a human|not a robot)/i },
  { kind: "captcha", pattern: /complete this security check/i },
  { kind: "captcha", pattern: /security verification/i },

  // UNVERIFIED — the two-step / email-code interstitial.
  { kind: "checkpoint", pattern: /enter the (code|pin) (we )?sent/i },
  { kind: "checkpoint", pattern: /two-?step verification/i },
  { kind: "checkpoint", pattern: /confirm your identity/i },

  // Verbatim from the reference worker's hard-block set.
  { kind: "restricted", pattern: /we noticed unusual activity from your account/i },
  { kind: "restricted", pattern: /your ability to view profiles has been temporarily restricted/i },
  { kind: "restricted", pattern: /profile viewing temporarily restricted/i },

  // Verbatim from the reference worker's soft-throttle set.
  { kind: "rate-limited", pattern: /couldn'?[’']?t load this content/i },
  { kind: "rate-limited", pattern: /too many requests/i },
  { kind: "rate-limited", pattern: /try again later/i },
];

/**
 * Selectors whose presence means a captcha widget is mounted. UNVERIFIED —
 * LinkedIn fronts its challenge with a third-party captcha in an iframe, and
 * these are the shapes that vendor uses; Task 15 is the first real check.
 */
export const CAPTCHA_SELECTORS: readonly string[] = [
  'iframe[src*="captcha" i]',
  'iframe[src*="arkoselabs" i]',
  'iframe[src*="funcaptcha" i]',
  'iframe[title*="captcha" i]',
  "#captcha-internal",
];

/**
 * LinkedIn's legacy "request denied" status, served to traffic it believes is
 * automated. Not a standard code, so it gets its own constant rather than
 * hiding as a magic number next to 429.
 */
export const LINKEDIN_DENIED_STATUS = 999;
