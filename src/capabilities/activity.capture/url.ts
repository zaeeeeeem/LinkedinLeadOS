import { CapabilityError, EXIT } from "../../core/run/receipt.js";

/**
 * Which page of the person-activity family a target names.
 *
 * These are four *pages*, not four capabilities. Task 26 exists to measure
 * whether they are four captures or one: `posts` is what the person published,
 * `comments` and `reactions` are what they did to other people's content
 * (spec §9 `profile.activity`), and `post` is one permalink, which is the only
 * surface `post.get` can read a reactor or commenter list from.
 */
export type ActivitySurface = "posts" | "comments" | "reactions" | "post";

/** The three surfaces that belong to a person rather than to one post. */
export type PersonSurface = Exclude<ActivitySurface, "post">;

/** The four surfaces, in the order the probe walks them. */
export const ACTIVITY_SURFACES: readonly ActivitySurface[] = [
  "posts", "comments", "reactions", "post",
];

/**
 * A person-activity or single-post target, canonicalized.
 *
 * Everything downstream reads these fields and never the operator's raw input:
 * `url` is navigated, `ref` is the event item ref, and `personRef` is the
 * `profile_open` dedupe key — deliberately the *same* `in:<vanity>` spelling
 * `profile.capture` uses, so opening someone's activity after opening their
 * profile on the same day does not count as a second distinct person (D223).
 */
export type ActivityTarget = {
  surface: ActivitySurface;
  /** The URL the worker tab navigates to. Query and fragment are always gone. */
  url: string;
  /** Stable identity for this target, prefixed by surface so two pages of one
   *  person can never collide on an event or in a receipt. */
  ref: string;
  /** Present for the three person surfaces. */
  vanity?: string;
  /** Present for the three person surfaces: the `profile_open` dedupe key. */
  personRef?: string;
  /** Present for `surface: "post"` — the activity urn the permalink names. */
  postUrn?: string;
};

/** What a LinkedIn vanity slug can be. Same rule as `profile.capture`'s. */
const VANITY = /^[\p{L}\p{N}][\p{L}\p{N}-]{2,99}$/u;

/** `scheme:` at the front, per RFC 3986. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** A bare `linkedin.com/...` with the scheme left off. */
const BARE_LINKEDIN_HOST = /^\/?(?:[a-z0-9-]+\.)*linkedin\.com\//i;

/**
 * The `/recent-activity/<tab>/` segment, mapped to a surface.
 *
 * `all` and `shares` both list the person's own posts — LinkedIn renamed the
 * tab and kept the old path working. Anything else is refused rather than
 * guessed at: a tab this build has not seen is a page whose contents nobody has
 * measured, and navigating to it would spend a load to find out.
 */
const ACTIVITY_TABS: Readonly<Record<string, PersonSurface>> = {
  all: "posts",
  shares: "posts",
  posts: "posts",
  comments: "comments",
  reactions: "reactions",
};

/** The canonical tab segment for each person surface, for building the url. */
const TAB_SEGMENT: Readonly<Record<PersonSurface, string>> = {
  posts: "all",
  comments: "comments",
  reactions: "reactions",
};

/** A post's own urn, in the two spellings a permalink carries. */
const POST_URN = /^urn:li:(activity|ugcPost|share):\d+$/;

/** `…-activity-7123456789012345678-abcd` — the id inside a `/posts/` slug. */
const POSTS_SLUG_ACTIVITY = /-activity-(\d{6,25})(?:-|$)/;

const ACCEPTED =
  "accepted forms: https://www.linkedin.com/in/<vanity>/recent-activity/all|comments|reactions/, " +
  "a bare <vanity> slug (with --surface), " +
  "https://www.linkedin.com/feed/update/urn:li:activity:<id>/, " +
  "or https://www.linkedin.com/posts/<slug>-activity-<id>-<hash>";

function invalid(input: string, why: string): CapabilityError {
  return new CapabilityError({
    code: "ACTIVITY_URL_INVALID",
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

function personTarget(
  input: string,
  rawSegment: string,
  surface: PersonSurface,
): ActivityTarget {
  const vanity = decodeSafely(rawSegment);
  if (!VANITY.test(vanity)) {
    throw invalid(input, `"${vanity}" is not a usable LinkedIn vanity slug`);
  }
  const key = vanity.toLowerCase();
  return {
    surface,
    // The raw segment, not the decoded one: it is already in the escaped form
    // LinkedIn's own links use.
    url: `https://www.linkedin.com/in/${rawSegment}/recent-activity/${TAB_SEGMENT[surface]}/`,
    ref: `${surface}:in:${key}`,
    vanity,
    personRef: `in:${key}`,
  };
}

function postTarget(input: string, urn: string, url: string): ActivityTarget {
  if (!POST_URN.test(urn)) throw invalid(input, `"${urn}" is not a post urn`);
  return { surface: "post", url, ref: `post:${urn.toLowerCase()}`, postUrn: urn };
}

/**
 * Turns whatever the operator passed into one canonical activity target, or
 * refuses it loudly.
 *
 * Pure and total: no I/O, no network, one error class. It runs before anything
 * is navigated or spent.
 *
 * It is deliberately **not** `normalizeProfileUrl`. That function collapses
 * `/recent-activity/…` onto the base profile on purpose — it captures the
 * profile — so reusing it here would navigate every probe to the same page and
 * measure nothing. The two live side by side; neither is the other's default.
 *
 * `surface` names the tab when the url does not: a bare vanity, or an `/in/`
 * url with no `/recent-activity/` segment. When the url *does* name a tab and
 * `surface` disagrees, that is refused rather than silently resolved — the two
 * would spend a page load on whichever one this function happened to prefer.
 */
export function normalizeActivityUrl(
  rawInput: string,
  o: { surface?: ActivitySurface } = {},
): ActivityTarget {
  const input = rawInput.trim();
  if (input === "") throw invalid(rawInput, "the activity url is empty");

  const wanted = o.surface;
  if (wanted === "post") {
    throw invalid(rawInput, "--surface=post names no page on its own; pass the permalink url");
  }

  // A bare `in/<vanity>` or `/in/<vanity>[/recent-activity/<tab>]`.
  const bareInPath = /^\/?in\/([^/?#]+)(?:\/(.*))?$/i.exec(input);
  if (bareInPath !== null && !HAS_SCHEME.test(input)) {
    return fromProfilePath(rawInput, bareInPath[1]!, (bareInPath[2] ?? "").split(/[?#]/)[0]!, wanted);
  }

  const looksLikeUrl = HAS_SCHEME.test(input) || BARE_LINKEDIN_HOST.test(input);
  if (!looksLikeUrl) {
    // Nothing URL-shaped left: it is a vanity slug or it is a mistake.
    if (!VANITY.test(input)) {
      throw invalid(rawInput, `"${input}" is neither a url nor a usable LinkedIn vanity slug`);
    }
    return personTarget(rawInput, encodeURIComponent(input), wanted ?? "posts");
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

  if (head === "in") {
    const vanitySegment = segments[1];
    if (vanitySegment === undefined) throw invalid(rawInput, "the url has no vanity segment after /in/");
    return fromProfilePath(rawInput, vanitySegment, segments.slice(2).join("/"), wanted);
  }

  // `/feed/update/urn:li:activity:<id>/` — the canonical permalink.
  if (head === "feed" && (segments[1] ?? "").toLowerCase() === "update") {
    const urnSegment = segments[2];
    if (urnSegment === undefined) throw invalid(rawInput, "the permalink has no activity urn");
    const urn = decodeSafely(urnSegment);
    return postTarget(rawInput, urn, `https://www.linkedin.com/feed/update/${urn}/`);
  }

  // `/posts/<slug>-activity-<id>-<hash>` — what LinkedIn's share button copies.
  if (head === "posts") {
    const slug = segments[1];
    if (slug === undefined) throw invalid(rawInput, "the /posts/ url has no slug");
    const m = POSTS_SLUG_ACTIVITY.exec(decodeSafely(slug));
    if (m === null) {
      throw invalid(rawInput, "the /posts/ slug carries no -activity-<id>- component");
    }
    // Navigated in its own `/posts/` form rather than rewritten to
    // `/feed/update/`: the whole point of the probe is to measure the page
    // LinkedIn actually serves, and a rewrite would measure a redirect.
    return {
      ...postTarget(rawInput, `urn:li:activity:${m[1]!}`, `https://www.linkedin.com/posts/${slug}`),
    };
  }

  throw invalid(rawInput, `${url.pathname} is not a person-activity or post url`);
}

/** The tail after `/in/<vanity>/`, resolved against an explicit `--surface`. */
function fromProfilePath(
  input: string,
  vanitySegment: string,
  tail: string,
  wanted: PersonSurface | undefined,
): ActivityTarget {
  const parts = tail.split("/").filter((s) => s !== "");
  const head = (parts[0] ?? "").toLowerCase();

  if (head === "") {
    return personTarget(input, vanitySegment, wanted ?? "posts");
  }
  if (head !== "recent-activity") {
    throw invalid(input, `/in/<vanity>/${head}/ is not a recent-activity page`);
  }

  const tab = (parts[1] ?? "").toLowerCase();
  if (tab === "") return personTarget(input, vanitySegment, wanted ?? "posts");

  const surface = ACTIVITY_TABS[tab];
  if (surface === undefined) {
    throw invalid(
      input,
      `/recent-activity/${tab}/ is a tab this build has not measured (known: ` +
        `${Object.keys(ACTIVITY_TABS).join(", ")})`,
    );
  }
  if (wanted !== undefined && wanted !== surface) {
    // Refused, not resolved. Silently preferring one would spend a page load on
    // a page the operator did not ask for and report it as the one they did.
    throw invalid(
      input,
      `the url names the ${surface} tab but --surface=${wanted} was passed; they must agree`,
    );
  }
  return personTarget(input, vanitySegment, surface);
}

/**
 * Whether an input names a single post rather than a person's activity tab.
 *
 * Total: it answers for anything, including garbage, and never throws. That is
 * the whole reason it exists — `cost()` runs before the runner has anywhere to
 * put a good error, and a throw there is reported as `COST_ESTIMATE_FAILED`
 * with `ACTIVITY_URL_INVALID`'s message lost. The estimate needs one bit; the
 * refusal happens later, inside `run`, where it reads properly.
 */
export function looksLikePostPermalink(rawInput: string): boolean {
  try {
    return normalizeActivityUrl(rawInput).surface === "post";
  } catch {
    // Not a target at all. Estimated as a person surface, which is the more
    // expensive of the two: preflight erring high is the direction section 8
    // requires, and this input is about to be refused anyway.
    return false;
  }
}
