import type { FieldProbe } from "./fieldmap.js";
import { looksEpochMs, looksEpochSeconds, looksIso8601, looksRelativeTime } from "./timeshape.js";

/**
 * What a post, activity or reaction parser (Tasks 27–29) has to locate in a
 * captured JSON body — expressed as probes, so every one of them reports
 * *found here* or *not found*, and none of them is an assumption a parser
 * inherits.
 *
 * The key regexes list alternatives rather than a single remembered name for
 * the same reason `PROFILE_PROBES` does: naming one key would turn a miss into
 * "LinkedIn does not have this field" when it means "we guessed the name".
 *
 * The three `posted_at_*` probes are the point of the set. They are shape-based
 * and key-free, so between them they answer the one question the rendered page
 * cannot: does any source carry an absolute time, or only `3d`.
 */
export const ACTIVITY_PROBES: readonly FieldProbe[] = [
  {
    name: "post_urn",
    what: "the post's stable identity — `person_posts.urn` / `company_posts.urn` (§7)",
    value: /^urn:li:(activity|ugcPost|share|fsd_update):/,
  },
  {
    name: "author_urn",
    what: "who published it. On this surface a repost or an interleaved stranger makes this the subject-vs-stranger boundary — every hit is checked against the session set",
    value: /^urn:li:(fsd_profile|fs_profile|member):/,
  },
  {
    name: "author_company_urn",
    what: "a company author, for `company_posts.company_urn`",
    value: /^urn:li:(fsd_company|fs_normalized_company|company):/,
  },
  {
    name: "actor_container",
    what: "the node naming the poster — where author identity is resolved from on a post card",
    key: /^(actor|author|actorUrn|creator|owner|poster)$/,
  },
  {
    name: "post_text",
    what: "the post body — `person_posts.text`",
    key: /^(commentary|text|content|description|summary|body)$/,
  },
  {
    name: "posted_at_epoch",
    what: "an absolute timestamp as epoch millis or seconds, wherever it lives. A hit here is what lets `posted_at` be stored rather than derived",
    number: (n) => looksEpochMs(n) || looksEpochSeconds(n),
  },
  {
    name: "posted_at_iso",
    what: "an absolute timestamp as an ISO-8601 string",
    // A predicate rather than a regex literal, so `looksIso8601`'s parse check
    // stays the one definition of "is this a date" in the repo.
    value: { test: (v: string) => looksIso8601(v) },
  },
  {
    name: "posted_at_relative",
    what: "a relative time (`3d`, `2w`). Only this shape means `posted_at` has to be derived from the run clock, which is a lossy conversion nobody may make silently",
    value: { test: (v: string) => looksRelativeTime(v) },
  },
  {
    name: "reactions_count",
    what: "`person_posts.reactions`",
    key: /^(numLikes|numReactions|reactionCount|totalReactions|reactionTypeCounts|likes)$/,
  },
  {
    name: "comments_count",
    what: "`person_posts.comments`",
    key: /^(numComments|commentCount|totalComments|comments)$/,
  },
  {
    name: "social_detail",
    what: "the counts container a post card hangs its reaction/comment totals off",
    key: /^(socialDetail|socialActivityCounts|socialProof|socialCounts)$/,
  },
  {
    name: "reactor_list",
    what: "who reacted — `post.get --reactors`",
    key: /^(reactions|reactors|likes|likers)$/,
  },
  {
    name: "commenter_list",
    what: "who commented — `post.get --commenters`",
    key: /^(comments|commenters|commentsElements)$/,
  },
  {
    name: "pagination",
    what: "how the next page is asked for, if the feed pages at all",
    key: /^(paging|metadata|nextCursor|paginationToken|start|count)$/,
  },
  {
    name: "graphql_envelope",
    what: "how the response is wrapped — where a parser has to start from",
    object: (keys) => keys.includes("data") || keys.includes("included") || keys.includes("elements"),
  },
];
