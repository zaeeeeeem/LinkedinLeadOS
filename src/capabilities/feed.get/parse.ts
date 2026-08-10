import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

import { countFromLabel, vanityOf } from "../post.get/parse.js";
import { activityPostedAt } from "../profile.posts/parse.js";
import {
  CARD_COMPONENTKEY, COMMENT_COMPONENTKEY, CONTROL_MENU_LABEL, FEED_CONTAINER_TESTID,
} from "../../core/fixtures/feed-dommap.js";

/**
 * Every row this parser returns came from a rendered DOM snapshot, never from a
 * labeled API field. Tagged on the way out so nothing downstream can mistake one
 * for the other (D325, same rule as D123/D130, D305 and D313).
 *
 * The DOM is the source here because the probe measured that it is the only
 * one. Run `01KZMZ5BQD2MKSN8EV7WRG38P0`, 2026-08-10: 26 responses archived,
 * **zero** hits on all six watched feed endpoints — `voyagerFeedDashUpdates`,
 * `voyagerFeedDashMainFeedUpdates`, `voyagerFeedDashFeedUpdatesV2`,
 * `voyagerSocialDashSocialActivityCounts`, `voyagerSocialDashSocialDetails`,
 * `/voyager/api/feed/updates` — and the 5.2MB `/feed/` document carries no Big
 * Pipe island at all, only an RSC flight tree. No captured body on this surface
 * carries a feed item's fields, so the D325 fallback is in use rather than
 * preferred (D280).
 */
export const DOM_SOURCE = "dom-snapshot" as const;

export type Sourced<T> = { source: typeof DOM_SOURCE; value: T };

export type ParseFeedWarningCode =
  | "PARSE_CONTAINER_MISSING"
  | "PARSE_AUTHOR_UNRESOLVED"
  | "PARSE_AUTHOR_AMBIGUOUS"
  | "PARSE_AUTHOR_LINK_UNRESOLVED"
  | "PARSE_ITEM_URN_UNRESOLVED"
  | "FEED_ITEM_NO_BODY"
  | "FEED_PARTIAL";

export type FeedParseWarning = { code: ParseFeedWarningCode; n: number; field: string };

/**
 * Bounds every list this parser builds, before `--limit` narrows it further. A
 * malformed snapshot must not be able to grow the output without limit.
 */
export const MAX_FEED_ITEMS = 100;

export type FeedItem = {
  /**
   * The card's SDUI tracking id — stable **within this page only**.
   *
   * It is not a urn and is not offered as one. LinkedIn mints it per
   * impression, so it identifies a card in this snapshot and nothing beyond it.
   * `urn` below is the only cross-run identity, and it is often null.
   */
  ref: string;
  /** e.g. `MAIN_FEED_RELEVANCE`. */
  feed_type: string;
  /**
   * The post's own urn, or `null`.
   *
   * Resolved **only** from the parent urn inside a rendered comment's
   * `replaceableComment_urn:li:comment:(<parent>,<id>)` key, and only when every
   * such comment on the card agrees — a comment's parent is by definition the
   * post it sits under. An `activity` urn found anywhere else in the card is not
   * the card's own: the measured snapshot has a card whose post *text* links to
   * a different post, and reading that as identity would key this item to a
   * stranger's content.
   */
  urn: string | null;
  urn_source: "comment-parent" | null;
  /** The author's display name, from the label LinkedIn writes on the card's
   *  control menu. `null` when the card carries no such label. */
  author_name: string | null;
  author_vanity: string | null;
  /** A company author's slug, when the author is a page rather than a person. */
  author_company: string | null;
  author_url: string | null;
  /** True when the author is the operator themselves. A feed legitimately
   *  contains the operator's own posts; they are tagged, not refused (D325). */
  is_operator: boolean;
  /** The post body's length. The body itself stays in the archive. */
  text_chars: number;
  reactions_total: number | null;
  comments_total: number | null;
  reposts_total: number | null;
  /** Derived from the activity snowflake when — and only when — `urn` resolved.
   *  Every time this page renders is relative (`10h`); none of it is read. */
  posted_at: string | null;
  /** How many comment rows the card rendered. Never loaded; only counted. */
  comments_rendered: number;
};

export type ParseFeedOptions = {
  /** How many items to return. Bounded again by `MAX_FEED_ITEMS`. */
  limit: number;
  /** The operator's own public identifiers, from `sessionVanitiesOf`. Used to
   *  tag their own items — never to find a subject; a feed has none. */
  sessionVanities?: readonly string[];
};

export type ParseFeedResult = {
  ok: boolean;
  container: {
    found: boolean;
    children: number;
    /** Every card under the container, whether or not `--limit` reached it. */
    cards: number;
    /** The cards this read actually looked at. Every ratio below is against
     *  this number, not against `cards`: `--limit=2` on an 8-card page used to
     *  report "0 of 8 unresolved", implying six checks that never ran (D288). */
    examined: number;
  };
  items: Sourced<FeedItem>[];
  /** Cards that carried a post body but whose author could not be resolved.
   *  Reported, never attributed by position (D325, D118). */
  unresolved: number;
  /** Always true: a feed does not end, so any read of one is a prefix. */
  partial: true;
  warnings: FeedParseWarning[];
};

function tagged<T>(value: T): Sourced<T> {
  return { source: DOM_SOURCE, value };
}

/** `View <name>’s profile`, in both apostrophe spellings LinkedIn emits. */
function viewProfileLabel(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^View ${escaped}['’]s profile$`);
}

/**
 * A card's href, made absolute.
 *
 * LinkedIn renders both spellings — `https://www.linkedin.com/in/x/` and a bare
 * `/in/x/` — and `vanityOf` only matches the first. A relative href therefore
 * produced `author_vanity: null` *and* `is_operator: false` with `author_url`
 * non-null, so the D119 tagging guard went inert on a row that looked fully
 * resolved and raised no warning at all (D287). Normalized once, here, before
 * any identity is read off it.
 */
export function absoluteHref(href: string | null): string | null {
  if (href === null || href === "") return null;
  if (/^https?:\/\//i.test(href)) return href;
  return href.startsWith("/") ? `https://www.linkedin.com${href}` : null;
}

/** The `/company/<slug>` out of a url, query and trailing path removed. */
export function companySlugOf(href: string | null): string | null {
  if (href === null) return null;
  const m = /\/company\/([^/?#]+)/.exec(href);
  return m === null ? null : decodeURIComponent(m[1]!);
}

/**
 * The first leaf whose entire text is `<number> <noun>`, within one card and
 * **outside its comment rows**.
 *
 * The scope guard is not decoration: a comment renders its own reaction count,
 * so an unscoped search returns whichever appears first in the card. post.get
 * learned this on the Task 29 fixture; the same trap is one card deeper here.
 */
function totalIn(
  $: cheerio.CheerioAPI,
  card: Element,
  noun: RegExp,
  outside: (el: AnyNode) => boolean,
): number | null {
  for (const el of $(card).find("*").get()) {
    if (!outside(el)) continue;
    const $el = $(el);
    if ($el.children().length > 0) continue; // leaf text only
    const n = countFromLabel($el.text(), noun);
    if (n !== null) return n;
  }
  return null;
}

/**
 * Reads the operator's own feed out of an archived DOM snapshot.
 *
 * Pure, total and offline: the input is html, the output is data, and it never
 * touches the network or the clock except through `activityPostedAt`, which is
 * arithmetic on a snowflake.
 *
 * The scoping rule is the whole safety argument, and it inverts what the three
 * readers before it did. There is no subject. Every card is scoped by its own
 * SDUI namespace — `expanded<TRACKING_ID>FeedType_<TYPE>` on the wrapper, the
 * bare `<TRACKING_ID>` on the card's own container — and its author is resolved
 * inside that scope from the label LinkedIn writes, never from where a link
 * happens to sit. On the measured snapshot 3 of 8 cards carried more than one
 * distinct `/in/` link, and on every one of those the first link belonged to
 * whoever liked or commented rather than to the author.
 */
export function parseFeed(html: string, options: ParseFeedOptions): ParseFeedResult {
  const warnings: FeedParseWarning[] = [];
  const $ = cheerio.load(html);
  const session = new Set(options.sessionVanities ?? []);

  const container = $(`[data-testid="${FEED_CONTAINER_TESTID}"]`).first();
  if (container.length === 0) {
    warnings.push({
      code: "PARSE_CONTAINER_MISSING",
      n: 1,
      field: `no [data-testid="${FEED_CONTAINER_TESTID}"] in the snapshot; the feed list did not render`,
    });
    return {
      ok: false,
      container: { found: false, children: 0, cards: 0, examined: 0 },
      items: [],
      unresolved: 0,
      partial: true,
      warnings,
    };
  }

  const children = container.children().get();
  const wanted = Math.max(0, Math.min(options.limit, MAX_FEED_ITEMS));
  const items: Sourced<FeedItem>[] = [];
  let cards = 0;
  let examined = 0;
  let unresolved = 0;
  let ambiguous = 0;
  let unlinked = 0;
  let withoutUrn = 0;
  let withoutBody = 0;

  for (const node of children) {
    const card = node as Element;
    const $card = $(card);

    // A card, or page chrome? The share box and the placeholders carry no SDUI
    // feed key. Asked of the key rather than of the position in the list.
    const wrapperKey = $card
      .find("[componentkey]")
      .map((_, n) => $(n).attr("componentkey"))
      .get()
      .find((k) => CARD_COMPONENTKEY.test(k ?? ""));
    if (wrapperKey === undefined) continue;
    const keyed = CARD_COMPONENTKEY.exec(wrapperKey)!;
    cards++;
    if (items.length >= wanted) continue;
    examined++;

    // A card with no `expandable-text-box` used to be dropped here as a
    // placeholder. It is not one: an image-only or video-only post has no text
    // box and is a real feed item, and dropping it removed the post from
    // `items`, from `cards`, and from every warning at once — the read simply
    // came back shorter with nothing saying why (D286). It is now returned with
    // `text_chars: 0` and counted.
    const bodyless = $card.find("[data-testid='expandable-text-box']").length === 0;
    if (bodyless) withoutBody++;

    // ── comment scope ──────────────────────────────────────────────────────
    const commentRows = $card.find("[componentkey^='replaceableComment_']").get();
    const outsideComments = (el: AnyNode): boolean =>
      !commentRows.some((row) => row === el || $.contains(row, el));

    // ── identity ───────────────────────────────────────────────────────────
    const parents = new Set(
      commentRows
        .map((row) => COMMENT_COMPONENTKEY.exec($(row).attr("componentkey") ?? "")?.[1])
        .filter((u): u is string => u !== undefined),
    );
    const urn = parents.size === 1 ? [...parents][0]! : null;
    if (urn === null) withoutUrn++;

    // ── author, from the label and never from a position ───────────────────
    const labels = [
      ...new Set(
        $card
          .find("[aria-label]")
          .map((_, n) => CONTROL_MENU_LABEL.exec($(n).attr("aria-label") ?? "")?.[1])
          .get()
          .filter((n2): n2 is string => n2 !== undefined),
      ),
    ];
    let authorName: string | null = null;
    if (labels.length === 1) authorName = labels[0]!;
    else if (labels.length === 0) unresolved++;
    else {
      ambiguous++;
      unresolved++;
    }

    let authorUrl: string | null = null;
    if (authorName !== null) {
      // The label sits on the avatar `<svg>` inside the anchor — measured, not
      // assumed: looking for it on the `<a>` found nothing on all eight cards.
      const wantedLabel = viewProfileLabel(authorName);
      const link = $card
        .find("[aria-label]")
        .filter((_, n) => wantedLabel.test($(n).attr("aria-label") ?? ""))
        .first()
        .closest("a[href]");
      authorUrl = link.length > 0 ? absoluteHref(link.attr("href") ?? null) : null;
      if (authorUrl === null) {
        // A company author has no profile label. Resolved only when the card
        // holds exactly one company link, so a post *mentioning* four companies
        // cannot be attributed to one of them.
        const companies = [
          ...new Set(
            $card
              .find("a[href*='/company/'], a[href^='/company/']")
              .get()
              .filter(outsideComments)
              .map((el) => absoluteHref($(el).attr("href") ?? null))
              .map((h) => (h === null ? null : h.split("?")[0]!))
              .filter((h): h is string => h !== null),
          ),
        ];
        authorUrl = companies.length === 1 ? companies[0]! : null;
      }
      if (authorUrl === null) unlinked++;
    }

    const authorVanity = vanityOf(authorUrl ?? undefined);
    const authorCompany = authorVanity === null ? companySlugOf(authorUrl) : null;

    // ── time ───────────────────────────────────────────────────────────────
    // Derived from the activity snowflake, exactly as post.get does, and only
    // when the urn resolved. Every time rendered on this page is relative.
    let posted_at: string | null = null;
    if (urn !== null) {
      try {
        posted_at = activityPostedAt(urn).toISOString();
      } catch {
        posted_at = null;
      }
    }

    items.push(
      tagged({
        ref: keyed[1]!,
        feed_type: keyed[2]!,
        urn,
        urn_source: urn === null ? null : "comment-parent",
        author_name: authorName,
        author_vanity: authorVanity,
        author_company: authorCompany,
        author_url: authorUrl,
        is_operator: authorVanity !== null && session.has(authorVanity),
        text_chars: $card
          .find("[data-testid='expandable-text-box']")
          .get()
          .filter(outsideComments)
          .slice(0, 1)
          .reduce((_, el) => $(el).text().replace(/\s+/g, " ").trim().length, 0),
        reactions_total: totalIn($, card, /reactions?/, outsideComments),
        comments_total: totalIn($, card, /comments?/, outsideComments),
        reposts_total: totalIn($, card, /reposts?/, outsideComments),
        posted_at,
        comments_rendered: commentRows.length,
      }),
    );
  }

  if (unresolved > 0) {
    warnings.push({
      code: "PARSE_AUTHOR_UNRESOLVED",
      n: unresolved,
      field:
        `${unresolved} of the ${examined} cards read carry no single ` +
        `"Open control menu for post by <name>" ` +
        `label, so their author is reported unresolved rather than attributed by position (D325)`,
    });
  }
  if (ambiguous > 0) {
    warnings.push({
      code: "PARSE_AUTHOR_AMBIGUOUS",
      n: ambiguous,
      field: `${ambiguous} cards named more than one author; none of them was chosen`,
    });
  }
  if (unlinked > 0) {
    warnings.push({
      code: "PARSE_AUTHOR_LINK_UNRESOLVED",
      n: unlinked,
      field: `${unlinked} cards name an author whose profile or company link could not be resolved`,
    });
  }
  if (withoutUrn > 0) {
    warnings.push({
      code: "PARSE_ITEM_URN_UNRESOLVED",
      n: withoutUrn,
      field:
        `${withoutUrn} of the ${examined} cards read render no comment, which is the only place this ` +
        `surface exposes a post's own urn; those items have no cross-run identity`,
    });
  }
  if (withoutBody > 0) {
    warnings.push({
      code: "FEED_ITEM_NO_BODY",
      n: withoutBody,
      field:
        `${withoutBody} of the ${examined} cards read render no text box — an image-only or ` +
        `video-only post. They are returned with text_chars 0 rather than dropped`,
    });
  }
  if (items.length < wanted) {
    warnings.push({
      code: "FEED_PARTIAL",
      n: wanted - items.length,
      field:
        `${items.length} of the ${wanted} items asked for were rendered in this snapshot; a ` +
        `feed does not end, so this read is a prefix either way and nothing was loaded to extend it`,
    });
  }

  return {
    ok: true,
    container: { found: true, children: children.length, cards, examined },
    items,
    unresolved,
    partial: true,
    warnings,
  };
}
