import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

import { activityPostedAt } from "../profile.posts/parse.js";

/**
 * Every row this parser returns came from a rendered DOM snapshot, never from a
 * labeled API field. Tagged on the way out so nothing downstream can mistake one
 * for the other (D313, same rule as D123/D130 and D305).
 */
export const DOM_SOURCE = "dom-snapshot" as const;

export type Sourced<T> = { source: typeof DOM_SOURCE; value: T };

export type ParsePostWarningCode =
  | "PARSE_IDENTITY_UNRESOLVED"
  | "PARSE_IDENTITY_MISMATCH"
  | "PARSE_AUTHOR_UNRESOLVED"
  | "PARSE_AUTHOR_AMBIGUOUS"
  | "PARSE_AUTHOR_COMPANY"
  | "PARSE_FIELD_MISSING"
  | "COMMENTS_PARTIAL"
  | "REACTIONS_PARTIAL";

/**
 * Which of LinkedIn's two post apps the snapshot came from (D340).
 *
 * `sdui` is the React app D312/D313 measured: every scope is a `data-testid`.
 * `ember` is the legacy `theme--mercado` app the surface began serving on
 * 2026-08-10, which carries **zero** `data-testid` attributes — so the SDUI
 * anchors are not merely rearranged, they are absent, and a single parser
 * cannot straddle them. `unknown` is neither, and resolves nothing.
 */
export type PostRenderer = "sdui" | "ember" | "unknown";

export type PostParseWarning = { code: ParsePostWarningCode; n: number; field: string };

/**
 * Identity anchor. The post's own urn is carried in a `data-testid`, which is a
 * name LinkedIn chose for the element, not a per-build hashed class and not a
 * position in the tree (D305's rule, inherited by D313).
 */
const FACEPILE_TESTID_PREFIX = "ReactionFacepileCollection-";

/** The comment list's scope, addressed the same way. */
const COMMENT_LIST_TESTID = "commentList";

/** A comment row names its own urn in its `id`. */
const COMMENT_ID_PREFIX = "replaceableComment_";

const COMMENT_URN = /urn:li:comment:\(urn:li:activity:\d+,\d+\)/;
const ACTIVITY_URN = /urn:li:activity:\d+/;

// ── Ember anchors (D340) ─────────────────────────────────────────────────────
// All of these are names LinkedIn chose — a data attribute, a BEM class, or an
// aria-label. None is a position in the tree and none is a per-build hashed
// class, which is the same standard the testid anchors above are held to.

/** The post card, carrying its own urn. Measured: exactly one per snapshot. */
const EMBER_CARD = ".feed-shared-update-v2[data-urn^='urn:li:activity:']";
/** A reshared update embedded inside the card — its actor is not the author. */
const EMBER_NESTED_UPDATE = ".feed-shared-update-v2__update-content-wrapper";
/** The actor block's profile link: `/in/<vanity>` or `/company/<vanity>`. */
const EMBER_ACTOR_LINK = ".update-components-actor__meta-link";
/** The post's own commentary, as opposed to an embedded update's. */
const EMBER_COMMENTARY = ".update-components-update-v2__commentary";
const EMBER_COMMENT_ROW = ".comments-comment-entity[data-id]";
const EMBER_COMMENT_TEXT = ".comments-comment-item__main-content";
const EMBER_FACEPILE_ITEM = ".social-details-reactors-facepile__list-item";
/** Corroborates the actor link by name, so a wrong actor is refused, not stored. */
const EMBER_CONTROL_MENU = /^Open control menu for post by\s+(.+?)\s*$/;

/**
 * A comment urn on this renderer drops the inner `urn:li:` and may name a
 * `ugcPost` rather than an `activity` — measured on the company-authored
 * snapshot, whose only comment is `urn:li:comment:(ugcPost:…,…)`.
 */
const EMBER_COMMENT_URN = /urn:li:comment:\((?:activity|ugcPost):\d+,\d+\)/;

/** `"1,049 reactions"`, `"73 comments on X's post"`, `"5 reposts of X's post"`. */
const EMBER_TOTALS: Record<"reactions" | "comments" | "reposts", RegExp> = {
  reactions: /^([\d,.]+)\s+reactions?$/i,
  comments: /^([\d,.]+)\s+comments?\s+on\b/i,
  reposts: /^([\d,.]+)\s+reposts?\s+of\b/i,
};

/** `"View Lakshya Prasad's, reacted with LIKE, graphic"`. */
const EMBER_REACTOR = /^View\s+(.+?)['’]s,\s*reacted with\s+(.+?),\s*graphic$/i;

/**
 * Bounds every list this parser will build, before `--limit` narrows it further.
 * A malformed snapshot must not be able to grow the output without limit.
 */
export const MAX_COMMENT_ROWS = 200;
export const MAX_REACTION_ROWS = 200;

export type ParsedComment = {
  urn: string;
  author_vanity: string | null;
  author_url: string | null;
  text: string | null;
};

export type ParsedReaction = {
  actor_name: string;
  reaction: string | null;
  actor_vanity: string | null;
  actor_url: string | null;
};

export type ParsePostOptions = {
  /** The urn the caller asked for. Identity is checked against it, never guessed. */
  expectedUrn: string;
  /**
   * The operator's own public identifiers. The page's left rail carries the
   * operator's own profile link, so without this the author is ambiguous — the
   * same trap D119 exists for, in its DOM spelling.
   */
  sessionVanities?: readonly string[];
  /** Opt-in, per D313. Absent means the section is not read at all. */
  comments?: { limit: number };
  reactions?: { limit: number };
};

export type ParsedPost = {
  urn: string;
  author_vanity: string | null;
  text: string | null;
  posted_at: string | null;
  reactions_total: number | null;
  comments_total: number | null;
  reposts_total: number | null;
};

export type ParsePostResult = {
  ok: boolean;
  post: Sourced<ParsedPost> | null;
  comments: Sourced<ParsedComment>[];
  reactions: Sourced<ParsedReaction>[];
  warnings: PostParseWarning[];
  /** Which app the snapshot was, so the receipt can say it rather than imply it. */
  renderer: PostRenderer;
};

function tagged<T>(value: T): Sourced<T> {
  return { source: DOM_SOURCE, value };
}

/**
 * `"1,013 reactions"` → `1013`, matched against **one element's own text**.
 *
 * Deliberately not a scan of the whole page: the counts render as adjacent text
 * nodes, so `$.root().text()` concatenates them into `"1,01373 comments"` and a
 * loose regex reads 101,373 comments off a post that has 73. Measured on the
 * Task 29 fixture — the first version of this function did exactly that.
 */
export function countFromLabel(text: string, noun: RegExp): number | null {
  const m = new RegExp(`^([\\d,\\.]+)\\s+${noun.source}$`, "i").exec(text.trim());
  if (m === null) return null;
  const n = Number(m[1]!.replace(/[,.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * The first element whose entire text is `<number> <noun>` — **outside the
 * comment rows**.
 *
 * The scope guard is not decoration. A comment renders its own reaction count
 * ("8 reactions"), so an unscoped search returns whichever appears first in the
 * document. It is correct on today's fixture only because the post's totals bar
 * happens to render above the comment list, which is a layout accident and not
 * a promise.
 */
function totalFrom($: cheerio.CheerioAPI, noun: RegExp, outside: (el: AnyNode) => boolean): number | null {
  for (const el of $("*").get()) {
    if (!outside(el)) continue;
    const $el = $(el);
    if ($el.children().length > 0) continue; // leaf text only
    const n = countFromLabel($el.text(), noun);
    if (n !== null) return n;
  }
  return null;
}

/** The vanity out of a `/in/<vanity>/` url, query and trailing slash removed. */
export function vanityOf(href: string | undefined): string | null {
  if (href === undefined) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/.exec(href);
  return m === null ? null : decodeURIComponent(m[1]!);
}

/**
 * Which renderer this snapshot is, decided by the anchors each one is defined
 * by rather than by a version string or a theme class.
 *
 * SDUI wins when its identity anchor is present, so the primary parser is never
 * displaced by a page it can read. The theme class is deliberately not the test:
 * `theme--mercado` is on plenty of LinkedIn surfaces that have nothing to do
 * with this one — `/messaging/` has always carried it (measured 2026-08-10) —
 * and a renderer decision must turn on the anchors actually being parsed.
 */
export function detectRenderer($: cheerio.CheerioAPI): PostRenderer {
  if ($(`[data-testid^="${FACEPILE_TESTID_PREFIX}"]`).length > 0) return "sdui";
  if ($(EMBER_CARD).length > 0) return "ember";
  return "unknown";
}

export function parsePost(html: string, options: ParsePostOptions): ParsePostResult {
  const $ = cheerio.load(html);
  const renderer = detectRenderer($);
  if (renderer === "ember") return parseEmberPost($, options);
  if (renderer === "unknown") {
    return {
      ok: false,
      post: null,
      comments: [],
      reactions: [],
      renderer,
      warnings: [
        {
          code: "PARSE_IDENTITY_UNRESOLVED",
          n: 1,
          field: `no ${FACEPILE_TESTID_PREFIX}<activity urn> testid and no ${EMBER_CARD} in the snapshot — neither renderer`,
        },
      ],
    };
  }
  return parseSduiPost($, options);
}

/**
 * The Ember/`theme--mercado` app (D340).
 *
 * Same contract as the SDUI parser, same refusal discipline, different anchors.
 * The one field it can do that the SDUI page could not is name a company author:
 * the actor link is `/company/<vanity>`, which is a positive identification of
 * the D334 case rather than an absence to infer from.
 */
function parseEmberPost($: cheerio.CheerioAPI, options: ParsePostOptions): ParsePostResult {
  const warnings: PostParseWarning[] = [];
  const fail = (w: PostParseWarning): ParsePostResult => ({
    ok: false,
    post: null,
    comments: [],
    reactions: [],
    warnings: [...warnings, w],
    renderer: "ember",
  });

  // ── identity ───────────────────────────────────────────────────────────────
  const cards = $(EMBER_CARD).get();
  const urns = [...new Set(cards.map((el) => $(el).attr("data-urn") ?? "").filter((u) => ACTIVITY_URN.test(u)))];
  if (urns.length !== 1) {
    return fail({
      code: "PARSE_IDENTITY_UNRESOLVED",
      n: urns.length,
      field: `${urns.length} distinct activity urns on ${EMBER_CARD}; exactly one is required`,
    });
  }
  const urn = urns[0]!;
  if (urn !== options.expectedUrn) {
    return fail({
      code: "PARSE_IDENTITY_MISMATCH",
      n: 1,
      field: `snapshot carries ${urn}, caller asked for ${options.expectedUrn}`,
    });
  }
  const card = $(cards.filter((el) => $(el).attr("data-urn") === urn)[0]!);

  // ── scopes ─────────────────────────────────────────────────────────────────
  // Both exclusions are by identity: a comment names its own comment urn, and an
  // embedded update sits in a container named for being one. Neither is a
  // position, so a layout change cannot silently widen the scope.
  const commentRows = card.find(EMBER_COMMENT_ROW).get().filter((el) => EMBER_COMMENT_URN.test($(el).attr("data-id") ?? ""));
  const nested = card.find(EMBER_NESTED_UPDATE).get();
  const inside = (scopes: Element[], el: AnyNode): boolean => scopes.some((s) => s === el || $.contains(s, el));
  const ownScope = (el: AnyNode): boolean => !inside(commentRows, el) && !inside(nested, el);

  // ── author ─────────────────────────────────────────────────────────────────
  // The card's own actor, then corroborated by name against the control menu.
  // Two independent anchors have to agree before a post is attributed to anyone.
  const actors = card.find(EMBER_ACTOR_LINK).get().filter(ownScope);
  const menuNames = card
    .find("[aria-label]")
    .get()
    .filter(ownScope)
    .map((el) => EMBER_CONTROL_MENU.exec(($(el).attr("aria-label") ?? "").trim())?.[1] ?? null)
    .filter((n): n is string => n !== null);

  let authorVanity: string | null = null;
  if (actors.length !== 1) {
    warnings.push({
      code: actors.length === 0 ? "PARSE_AUTHOR_UNRESOLVED" : "PARSE_AUTHOR_AMBIGUOUS",
      n: actors.length,
      field: `${actors.length} actor links outside the comment and embedded-update scopes; exactly one is required`,
    });
  } else {
    const href = $(actors[0]!).attr("href") ?? "";
    const named = $(actors[0]!).text().replace(/\s+/g, " ").trim();
    const agrees = menuNames.length === 0 || menuNames.some((n) => named.startsWith(n));
    if (!agrees) {
      // The two anchors disagree about whose post this is. Refuse: attributing a
      // post to the wrong person is the expensive direction of this error.
      warnings.push({
        code: "PARSE_AUTHOR_AMBIGUOUS",
        n: 2,
        field: `the actor link and the control menu name different authors (menu: ${menuNames[0]})`,
      });
    } else {
      const vanity = vanityOf(href);
      const company = /linkedin\.com\/company\/([^/?#]+)/.exec(href)?.[1] ?? null;
      if (vanity !== null && (options.sessionVanities ?? []).includes(vanity)) {
        // The operator's own link where the author's belongs. Never attribute.
        warnings.push({ code: "PARSE_AUTHOR_AMBIGUOUS", n: 1, field: `the only actor link is the session's own (${vanity})` });
      } else if (vanity !== null) {
        authorVanity = vanity;
      } else if (company !== null) {
        // D334, now measured rather than assumed: a company-authored post is
        // positively identified, and still stores nothing.
        warnings.push({
          code: "PARSE_AUTHOR_COMPANY",
          n: 1,
          field: `the post is authored by company '${company}', which has no /in/ vanity to resolve`,
        });
      } else {
        warnings.push({ code: "PARSE_AUTHOR_UNRESOLVED", n: 1, field: "the actor link is neither a profile nor a company url" });
      }
    }
  }

  // ── the post's own body ────────────────────────────────────────────────────
  const commentary = card.find(EMBER_COMMENTARY).get().filter(ownScope);
  const text = commentary.length > 0 ? $(commentary[0]!).text().replace(/\s+/g, " ").trim() || null : null;
  if (text === null) warnings.push({ code: "PARSE_FIELD_MISSING", n: 1, field: "post text" });

  // ── time ───────────────────────────────────────────────────────────────────
  let posted_at: string | null = null;
  try {
    posted_at = activityPostedAt(urn).toISOString();
  } catch {
    warnings.push({ code: "PARSE_FIELD_MISSING", n: 1, field: "posted_at (unparseable activity snowflake)" });
  }

  // ── totals ─────────────────────────────────────────────────────────────────
  // Read from aria-labels, scoped out of the comment rows: a comment renders
  // "8 Reactions on <name>'s comment", which is the exact shape that would be
  // read as the post's own count by anything unscoped.
  const labels = card
    .find("[aria-label]")
    .get()
    .filter(ownScope)
    .map((el) => ($(el).attr("aria-label") ?? "").trim());
  const totalFor = (kind: keyof typeof EMBER_TOTALS): number | null => {
    for (const label of labels) {
      const m = EMBER_TOTALS[kind].exec(label);
      if (m === null) continue;
      const n = Number(m[1]!.replace(/[,.]/g, ""));
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const reactions_total = totalFor("reactions");
  const comments_total = totalFor("comments");
  const reposts_total = totalFor("reposts");

  // ── comments, only when asked for (D313) ───────────────────────────────────
  const comments: Sourced<ParsedComment>[] = [];
  if (options.comments !== undefined) {
    const wanted = Math.max(0, Math.min(options.comments.limit, MAX_COMMENT_ROWS));
    for (const el of commentRows.slice(0, wanted)) {
      const $el = $(el);
      const commentUrn = EMBER_COMMENT_URN.exec($el.attr("data-id") ?? "")?.[0];
      if (commentUrn === undefined) continue;
      const href = $el.find("a[href*='linkedin.com/in/']").first().attr("href") ?? null;
      comments.push(
        tagged({
          urn: commentUrn,
          author_vanity: vanityOf(href ?? undefined),
          author_url: href === null ? null : href.split("?")[0]!,
          text: $el.find(EMBER_COMMENT_TEXT).first().text().replace(/\s+/g, " ").trim() || null,
        }),
      );
    }
    if (comments_total !== null && comments.length < comments_total) {
      warnings.push({
        code: "COMMENTS_PARTIAL",
        n: comments_total - comments.length,
        field: `read ${comments.length} of ${comments_total} comments the page reports; this is a prefix, and nothing was loaded to extend it`,
      });
    }
  }

  // ── reactions, only when asked for, and ranked below comments (D313) ───────
  const reactions: Sourced<ParsedReaction>[] = [];
  if (options.reactions !== undefined) {
    const wanted = Math.max(0, Math.min(options.reactions.limit, MAX_REACTION_ROWS));
    for (const el of card.find(EMBER_FACEPILE_ITEM).get().filter(ownScope)) {
      if (reactions.length >= wanted) break;
      const $el = $(el);
      const label = ($el.find("[aria-label]").first().attr("aria-label") ?? $el.attr("aria-label") ?? "").trim();
      const m = EMBER_REACTOR.exec(label);
      if (m === null) continue;
      const href = $el.find("a[href*='linkedin.com/in/']").first().attr("href") ?? null;
      reactions.push(
        tagged({
          actor_name: m[1]!.trim(),
          reaction: m[2]!.trim(),
          actor_vanity: vanityOf(href ?? undefined),
          actor_url: href === null ? null : href.split("?")[0]!,
        }),
      );
    }
    if (reactions_total !== null && reactions.length < reactions_total) {
      warnings.push({
        code: "REACTIONS_PARTIAL",
        n: reactions_total - reactions.length,
        field: `read ${reactions.length} of ${reactions_total} reactions the page reports; only the rendered facepile is read`,
      });
    }
  }

  return {
    ok: true,
    post: tagged({ urn, author_vanity: authorVanity, text, posted_at, reactions_total, comments_total, reposts_total }),
    comments,
    reactions,
    warnings,
    renderer: "ember",
  };
}

function parseSduiPost($: cheerio.CheerioAPI, options: ParsePostOptions): ParsePostResult {
  const warnings: PostParseWarning[] = [];

  // ── identity ───────────────────────────────────────────────────────────────
  // Resolved from the name LinkedIn gives the element, or refused. A snapshot
  // with no resolvable post urn stores nothing rather than storing content under
  // an invented key.
  const facepile = $(`[data-testid^="${FACEPILE_TESTID_PREFIX}"]`).get();
  const anchored = facepile
    .map((el) => ACTIVITY_URN.exec($(el).attr("data-testid") ?? "")?.[0] ?? null)
    .filter((u): u is string => u !== null);
  const urn = anchored.length > 0 && anchored.every((u) => u === anchored[0]) ? anchored[0]! : null;

  if (urn === null) {
    warnings.push({
      code: "PARSE_IDENTITY_UNRESOLVED",
      n: 1,
      field: `no single ${FACEPILE_TESTID_PREFIX}<activity urn> testid in the snapshot`,
    });
    return { ok: false, post: null, comments: [], reactions: [], warnings, renderer: "sdui" };
  }
  if (urn !== options.expectedUrn) {
    // The snapshot is of a different post than the one asked for. Never reconcile
    // silently: a redirect that lands elsewhere must fail loudly.
    warnings.push({
      code: "PARSE_IDENTITY_MISMATCH",
      n: 1,
      field: `snapshot carries ${urn}, caller asked for ${options.expectedUrn}`,
    });
    return { ok: false, post: null, comments: [], reactions: [], warnings, renderer: "sdui" };
  }

  // ── scopes ─────────────────────────────────────────────────────────────────
  const commentRows = $(`[id^="${COMMENT_ID_PREFIX}"]`).get().filter((el) => COMMENT_URN.test($(el).attr("id") ?? ""));
  const facepileScopes = facepile;
  const within = (scopes: Element[], el: AnyNode): boolean =>
    scopes.some((s) => s === el || $.contains(s, el));
  const outsideComments = (el: AnyNode): boolean => !within(commentRows, el);
  const outsideBoth = (el: AnyNode): boolean => outsideComments(el) && !within(facepileScopes, el);

  // ── the post's own body ────────────────────────────────────────────────────
  // Scoped by *not being inside a comment row*, which is an identity-based test.
  // Container position would not survive a layout change; the comment urns will.
  const bodies = $("[data-testid='expandable-text-box']").get().filter(outsideComments);
  const text = bodies.length > 0 ? $(bodies[0]!).text().trim() : null;
  if (text === null) {
    warnings.push({ code: "PARSE_FIELD_MISSING", n: 1, field: "post text" });
  }

  // ── author ─────────────────────────────────────────────────────────────────
  // The page carries the operator's own profile link in its left rail, so the
  // session identity is removed before the remainder is required to be unique.
  const session = new Set(options.sessionVanities ?? []);
  const candidates = [
    ...new Set(
      $("a[href*='linkedin.com/in/']")
        .get()
        .filter(outsideBoth)
        .map((el) => vanityOf($(el).attr("href")))
        .filter((v): v is string => v !== null && !session.has(v)),
    ),
  ];
  let authorVanity: string | null = null;
  if (candidates.length === 1) authorVanity = candidates[0]!;
  else if (candidates.length === 0) {
    warnings.push({ code: "PARSE_AUTHOR_UNRESOLVED", n: 1, field: "no non-session profile link outside the comment and reaction scopes" });
  } else {
    warnings.push({
      code: "PARSE_AUTHOR_AMBIGUOUS",
      n: candidates.length,
      field: `${candidates.length} non-session profile links outside the comment and reaction scopes: ${candidates.slice(0, 5).join(", ")}`,
    });
  }

  // ── time ───────────────────────────────────────────────────────────────────
  // Derived from the activity snowflake, exactly as Task 27 does. Every time
  // rendered on this page is relative ("3d"); none of it is read.
  let posted_at: string | null = null;
  try {
    posted_at = activityPostedAt(urn).toISOString();
  } catch {
    warnings.push({ code: "PARSE_FIELD_MISSING", n: 1, field: "posted_at (unparseable activity snowflake)" });
  }

  // ── totals ─────────────────────────────────────────────────────────────────
  const reactions_total = totalFrom($, /reactions?/, outsideComments);
  const comments_total = totalFrom($, /comments?/, outsideComments);
  const reposts_total = totalFrom($, /reposts?/, outsideComments);

  // ── comments, only when asked for (D313) ───────────────────────────────────
  const comments: Sourced<ParsedComment>[] = [];
  if (options.comments !== undefined) {
    const wanted = Math.max(0, Math.min(options.comments.limit, MAX_COMMENT_ROWS));
    for (const el of commentRows.slice(0, wanted)) {
      const $el = $(el);
      const commentUrn = COMMENT_URN.exec($el.attr("id") ?? "")?.[0];
      if (commentUrn === undefined) continue;
      const link = $el.find("a[href*='linkedin.com/in/']").first();
      const href = link.attr("href") ?? null;
      comments.push(
        tagged({
          urn: commentUrn,
          author_vanity: vanityOf(href ?? undefined),
          author_url: href === null ? null : href.split("?")[0]!,
          text: $el.find("[data-testid='expandable-text-box']").first().text().trim() || null,
        }),
      );
    }
    // The condition the operator attached to the exception: a partial read is
    // never reported as the whole thread.
    if (comments_total !== null && comments.length < comments_total) {
      warnings.push({
        code: "COMMENTS_PARTIAL",
        n: comments_total - comments.length,
        field: `read ${comments.length} of ${comments_total} comments the page reports; this is a prefix, and nothing was loaded to extend it`,
      });
    }
  }

  // ── reactions, only when asked for, and ranked below comments (D313) ───────
  const reactions: Sourced<ParsedReaction>[] = [];
  if (options.reactions !== undefined) {
    const wanted = Math.max(0, Math.min(options.reactions.limit, MAX_REACTION_ROWS));
    const labelled = $(facepileScopes).find("[aria-label]").get();
    for (const el of labelled) {
      if (reactions.length >= wanted) break;
      const label = $(el).attr("aria-label") ?? "";
      const m = /^(.+?)\s+reacted with\s+(.+?)$/i.exec(label.trim());
      if (m === null) continue;
      const href = $(el).closest("a[href*='linkedin.com/in/']").attr("href") ?? null;
      reactions.push(
        tagged({
          actor_name: m[1]!.trim(),
          reaction: m[2]!.trim(),
          actor_vanity: vanityOf(href ?? undefined),
          actor_url: href === null ? null : href.split("?")[0]!,
        }),
      );
    }
    if (reactions_total !== null && reactions.length < reactions_total) {
      warnings.push({
        code: "REACTIONS_PARTIAL",
        n: reactions_total - reactions.length,
        field: `read ${reactions.length} of ${reactions_total} reactions the page reports; only the rendered facepile is read`,
      });
    }
  }

  return {
    ok: true,
    post: tagged({
      urn,
      author_vanity: authorVanity,
      text,
      posted_at,
      reactions_total,
      comments_total,
      reposts_total,
    }),
    comments,
    reactions,
    warnings,
    renderer: "sdui",
  };
}
