/**
 * Vanity → author urn, for the post write path.
 *
 * D314 left `post.get` archive-only because the permalink's DOM carries no
 * author urn anywhere — twelve `urn:li:member:<id>` values on run
 * `01KZKXSGNE4XRQMJRK241YQS6Q`, none of them the author's. The one identifier
 * the page does carry is the vanity slug, so the urn is recovered from a
 * **stored `persons` row** rather than from the page.
 *
 * That makes the whole step a store read: zero page loads, zero profile opens.
 * A post whose author was never fetched with `profile.get` simply has no row,
 * and that is the ordinary case, not a failure (D332).
 */

/** What the lookup is allowed to tell us. Deliberately narrower than `StoredPerson`. */
export type VanityMatch = { urn: string; vanityMatches: number };

export type AuthorLookup = (vanity: string) => Promise<VanityMatch | null>;

export type AuthorResolution =
  /** The author urn came from a stored row whose `vanity` equals this exactly. */
  | { status: "resolved"; vanity: string; urn: string }
  /** The snapshot yielded no author vanity at all — the parser already warned. */
  | { status: "no-vanity"; vanity: null; urn: null }
  /** No stored person holds this vanity. The common case; a write is skipped. */
  | { status: "not-found"; vanity: string; urn: null }
  /** More than one stored person holds it. Refused rather than guessed (D331). */
  | { status: "ambiguous"; vanity: string; urn: null; matches: number };

/**
 * Resolve, or refuse. There is no branch that returns a urn the store did not
 * hand back, which is the whole point: attributing a post to the wrong person is
 * the expensive direction of this error, so ambiguity loses rather than the most
 * recent row winning.
 */
export async function resolveAuthor(
  vanity: string | null,
  lookup: AuthorLookup,
): Promise<AuthorResolution> {
  if (vanity === null) return { status: "no-vanity", vanity: null, urn: null };
  const match = await lookup(vanity);
  if (match === null) return { status: "not-found", vanity, urn: null };
  if (match.vanityMatches > 1) {
    return { status: "ambiguous", vanity, urn: null, matches: match.vanityMatches };
  }
  return { status: "resolved", vanity, urn: match.urn };
}

export type AuthorWarning = { code: string; n: number; field: string };

/**
 * The refusal, said out loud on the receipt. Every non-`resolved` outcome gets a
 * warning naming the vanity, because a silent skip is indistinguishable from a
 * write that worked.
 */
export function authorWarning(resolution: AuthorResolution): AuthorWarning | null {
  switch (resolution.status) {
    case "resolved":
      return null;
    case "no-vanity":
      // The parser's own PARSE_AUTHOR_* warning already carries the detail; this
      // one states the consequence, which is that nothing was stored.
      return {
        code: "POST_AUTHOR_NOT_STORED",
        n: 1,
        field: "the snapshot resolved no author vanity, so no post row was written",
      };
    case "not-found":
      return {
        code: "POST_AUTHOR_NOT_STORED",
        n: 1,
        field:
          `no stored person has vanity '${resolution.vanity}'; run profile.get on ` +
          `https://www.linkedin.com/in/${resolution.vanity}/ first if this post should be stored`,
      };
    case "ambiguous":
      return {
        code: "POST_AUTHOR_AMBIGUOUS",
        n: resolution.matches,
        field:
          `${resolution.matches} stored persons hold vanity '${resolution.vanity}' ` +
          `(LinkedIn reassigns handles); refusing to pick one, so no post row was written`,
      };
  }
}
