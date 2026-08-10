import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { cssPath } from "./dommap.js";
import { buildActivityDomMap, renderActivityDomMap, urnFamilyOf, type ActivityDomMap } from "./activitymap.js";

/**
 * What the operator's own **`/feed/` DOM snapshot** actually contains.
 *
 * The activity map (`activitymap.ts`) measures a page's overall shape and is
 * reused here wholesale — urn-carrying attributes, time leaves, urn families,
 * the session-urn count are the same questions on any post-bearing page. What
 * this file adds is the question a feed raises and no surface before it did:
 *
 * > **A feed is a list. Which element is one item, and can each item's author
 * > be resolved from inside that item alone?**
 *
 * The subject framing inverts here (D325). There is no single subject to scope
 * to; scoping means resolving *each item's* author independently, and an item
 * whose author cannot be resolved must be reported unresolved rather than
 * attributed by container position. Position-based attribution is how D118
 * happened, and this is the surface where it would be easiest to repeat: the
 * cards are visually uniform, so "the first `/in/` link in the card" looks like
 * it works — and it is wrong on every card that carries social proof, where the
 * first link belongs to the person who *liked* or *commented on* the post
 * rather than to the person who wrote it. Measured on the 2026-08-10 snapshot:
 * 3 of 8 cards.
 *
 * Two sections, and the split is deliberate:
 *
 * - the **shape** section discovers candidate item boundaries by urn-valued
 *   attribute, assuming nothing. On the measured snapshot it finds essentially
 *   nothing, and that is the finding: feed cards carry **no post urn** in any
 *   attribute.
 * - the **namespace** section reports the SDUI structure the snapshot does
 *   have — `data-testid="mainFeed"`, one `componentkey` per card, and the
 *   `aria-label` LinkedIn writes naming the post's author.
 *
 * Both are measurements. Which one a parser anchors on is a decision taken
 * after reading the generated map, not before.
 *
 * Pure and offline. The input is html, the output is data.
 */

/** Bounds. A feed snapshot is on the order of half a megabyte of DOM and this
 *  is a development aid; each is exceeded by a test rather than assumed roomy. */
export const MAX_URN_CANDIDATES = 20;
export const MAX_ITEMS = 100;
export const MAX_TESTIDS = 40;

/** The feed list container. A `data-testid` is a name LinkedIn chose for the
 *  element, not a per-build hashed class and not a position (D305's rule). */
export const FEED_CONTAINER_TESTID = "mainFeed";

/** One card's SDUI wrapper: `expanded<TRACKING_ID>FeedType_<TYPE>`. The same
 *  `<TRACKING_ID>` names the card's own inner container bare, and every other
 *  component of that card carries it as a suffix — the feed's counterpart to
 *  the profile card-ref namespace of D127. */
export const CARD_COMPONENTKEY = /^expanded(.+?)FeedType_([A-Z_]+)$/;

/** What LinkedIn labels the card's overflow menu with. It names the **post's
 *  author**, not the person whose like or comment surfaced the post, which is
 *  what makes it an author anchor rather than a guess. */
export const CONTROL_MENU_LABEL = /^Open control menu for post by (.+)$/;

/** A rendered comment names its own urn, and a comment's parent is by
 *  definition the post it sits under — the one place a card's own post urn is
 *  reliably readable. */
export const COMMENT_COMPONENTKEY =
  /^replaceableComment_urn:li:comment:\((urn:li:(?:activity|ugcPost|share):\d+),\d+\)$/;

const URN_IN_VALUE = /urn:li:[A-Za-z_]+:[A-Za-z0-9_%:.,()-]+/g;

const PERSON_HREF = "a[href*='linkedin.com/in/'], a[href^='/in/']";
const COMPANY_HREF = "a[href*='linkedin.com/company/'], a[href^='/company/']";

/** The urn families that could identify a feed *item*. A person or company urn
 *  identifies an author, not a card. */
const ITEM_FAMILIES = new Set([
  "urn:li:activity",
  "urn:li:ugcPost",
  "urn:li:share",
  "urn:li:fsd_update",
]);

/** One candidate "an element carrying this attribute is a feed item" rule. */
export type UrnAttributeCandidate = {
  attribute: string;
  /** The urn family only. Never an id: a committed map must not carry a
   *  prospect's identity (spec 4.1, D3). */
  family: string;
  elements: number;
  distinctUrns: number;
  /** Elements containing another element of the same pair. Non-zero disqualifies
   *  the rule as an item boundary — it would double-count. */
  nested: number;
  firstPath: string;
};

/** One card under the feed container, measured. */
export type FeedItemMeasurement = {
  /** Position in the container, for reading the map against the page by hand.
   *  Never used as identity — that is exactly what D118 was. */
  index: number;
  /** The card's SDUI feed type, e.g. `MAIN_FEED_RELEVANCE`. */
  feedType: string | null;
  /** Whether the bare `<TRACKING_ID>` inner container exists — the card scope
   *  everything else is read within. */
  cardScopeResolved: boolean;
  /** Whether the card carries a post body at all. Chrome rows (the share box,
   *  a placeholder) do not, and are not items. */
  hasTextBox: boolean;
  /** Whether an `Open control menu for post by <name>` label named the author. */
  authorLabelled: boolean;
  /** Whether a profile or company link inside the card resolves that name to a
   *  url. `false` with `authorLabelled` true is an item whose author is named
   *  but not addressable. */
  authorLinked: boolean;
  /** How many distinct `/in/` links the card holds. Above one on a card with
   *  social proof is precisely why position must not decide the author. */
  personLinks: number;
  companyLinks: number;
  /** Whether the card's post urn could be resolved, and from where. */
  urnResolved: boolean;
  /** How many rendered comments the card carries. */
  comments: number;
  /** Whether the author resolved to the operator themselves. */
  sessionOwned: boolean;
};

export type FeedDomMap = {
  /** The whole-page shape measurement, unchanged from the activity surface. */
  base: ActivityDomMap;
  container: {
    /** Whether `[data-testid="mainFeed"]` is in the snapshot at all. */
    found: boolean;
    /** Its direct children, items and chrome alike. */
    children: number;
    path: string | null;
  };
  /** Cards under the container, in document order. */
  items: FeedItemMeasurement[];
  /** Item-boundary rules discovered by urn attribute, assuming nothing. */
  urnCandidates: UrnAttributeCandidate[];
  /** `data-testid` values seen inside the cards. */
  testidsInItems: Array<{ testid: string; count: number }>;
  personLinks: number;
  companyLinks: number;
  truncated: { items: boolean; urnCandidates: boolean; testids: boolean };
};

/** Every urn in an attribute value, with its family. */
function urnsOn(el: Element): Array<{ attribute: string; urn: string; family: string }> {
  const out: Array<{ attribute: string; urn: string; family: string }> = [];
  for (const [name, value] of Object.entries(el.attribs ?? {})) {
    for (const urn of value.match(URN_IN_VALUE) ?? []) {
      out.push({ attribute: name, urn, family: urnFamilyOf(urn) });
    }
  }
  return out;
}

/** `View <name>’s profile`, in both apostrophe spellings LinkedIn emits. */
function viewProfileLabel(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^View ${escaped}['\u2019]s profile$`);
}

/**
 * Builds the feed-surface map for one snapshot.
 *
 * `sessionUrns` / `sessionVanities` are always the output of `sessionUrnsOf` /
 * `sessionVanitiesOf` — this never re-derives who the operator is, it only
 * counts how often they appear. On a feed that count means something different
 * than on the three surfaces before it: the operator's own items are a
 * legitimate part of the page and are *tagged*, not refused (D325).
 */
export function buildFeedDomMap(
  html: string,
  o: { sessionUrns?: readonly string[]; sessionVanities?: readonly string[] } = {},
): FeedDomMap {
  const $ = cheerio.load(html);
  const sessionVanities = new Set((o.sessionVanities ?? []).filter((v) => v !== ""));

  const base = buildActivityDomMap(html, {
    ...(o.sessionUrns === undefined ? {} : { sessionUrns: o.sessionUrns }),
  });

  // ── the shape question, assuming nothing ──────────────────────────────────
  const groups = new Map<string, { attribute: string; family: string; elements: Element[] }>();
  for (const node of $("*").get()) {
    const el = node as Element;
    for (const { attribute, family } of urnsOn(el)) {
      if (!ITEM_FAMILIES.has(family)) continue;
      const key = `${attribute} ${family}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { attribute, family, elements: [el] });
      else group.elements.push(el);
    }
  }
  const urnCandidates: UrnAttributeCandidate[] = [...groups.values()].map((g) => {
    const urns = new Set<string>();
    for (const el of g.elements) {
      for (const u of urnsOn(el)) {
        if (u.attribute === g.attribute && u.family === g.family) urns.add(u.urn);
      }
    }
    return {
      attribute: g.attribute,
      family: g.family,
      elements: g.elements.length,
      distinctUrns: urns.size,
      nested: g.elements.filter((el) => g.elements.some((o2) => o2 !== el && $.contains(el, o2))).length,
      firstPath: cssPath($, g.elements[0]!),
    };
  }).sort((a, b) => b.elements - a.elements);

  // ── the namespace question, against the structure the snapshot has ────────
  const container = $(`[data-testid="${FEED_CONTAINER_TESTID}"]`).first();
  const children = container.length === 0 ? [] : container.children().get();

  const items: FeedItemMeasurement[] = [];
  const testidCounts = new Map<string, number>();

  children.slice(0, MAX_ITEMS).forEach((node, index) => {
    const el = node as Element;
    const $el = $(el);
    const wrapperKey = $el
      .find("[componentkey]")
      .map((_, n) => $(n).attr("componentkey"))
      .get()
      .find((k) => CARD_COMPONENTKEY.test(k ?? ""));
    if (wrapperKey === undefined) return; // chrome, not a card

    const m = CARD_COMPONENTKEY.exec(wrapperKey)!;
    const tracking = m[1]!;
    const feedType = m[2]!;
    const scope = $el.find(`[componentkey="${CSS_escape(tracking)}"]`).first();

    for (const n of $el.find("[data-testid]").get()) {
      const id = (n as Element).attribs?.["data-testid"];
      if (id === undefined || id === "") continue;
      testidCounts.set(id, (testidCounts.get(id) ?? 0) + 1);
    }

    const labels = [...new Set($el.find("[aria-label]").map((_, n) => $(n).attr("aria-label")).get())]
      .map((l) => CONTROL_MENU_LABEL.exec(l ?? "")?.[1])
      .filter((n2): n2 is string => n2 !== undefined);
    const authorName = new Set(labels).size === 1 ? labels[0]! : null;

    let authorHref: string | null = null;
    if (authorName !== null) {
      // The label sits on the avatar `<svg>`, inside the anchor — measured, not
      // assumed: looking for it on the `<a>` itself found nothing on all eight
      // cards of the 2026-08-10 snapshot. So the labelled element is found
      // first and the enclosing link is taken from it.
      const wanted = viewProfileLabel(authorName);
      const labelled = $el
        .find("[aria-label]")
        .filter((_, n) => wanted.test($(n).attr("aria-label") ?? ""))
        .first();
      const link = labelled.closest("a[href]");
      authorHref = link.length > 0 ? link.attr("href") ?? null : null;
      if (authorHref === null) {
        // A company author has no profile label. Resolved only when the card
        // holds exactly one company link, so a post *mentioning* four companies
        // cannot be attributed to one of them.
        const companies = [...new Set($el.find(COMPANY_HREF).map((_, n) => $(n).attr("href")).get())];
        authorHref = companies.length === 1 ? companies[0]! : null;
      }
    }

    const commentParents = new Set(
      $el
        .find("[componentkey^='replaceableComment_']")
        .map((_, n) => COMMENT_COMPONENTKEY.exec($(n).attr("componentkey") ?? "")?.[1])
        .get()
        .filter((u): u is string => u !== undefined && u !== null),
    );

    const vanity = authorHref === null ? null : /\/in\/([^/?#]+)/.exec(authorHref)?.[1] ?? null;

    items.push({
      index,
      feedType,
      cardScopeResolved: scope.length === 1,
      hasTextBox: $el.find("[data-testid='expandable-text-box']").length > 0,
      authorLabelled: authorName !== null,
      authorLinked: authorHref !== null,
      personLinks: new Set($el.find(PERSON_HREF).map((_, n) => $(n).attr("href")).get()).size,
      companyLinks: new Set($el.find(COMPANY_HREF).map((_, n) => $(n).attr("href")).get()).size,
      urnResolved: commentParents.size === 1,
      comments: $el.find("[componentkey^='replaceableComment_']").length,
      sessionOwned: vanity !== null && sessionVanities.has(decodeURIComponent(vanity)),
    });
  });

  const testids = [...testidCounts.entries()]
    .map(([testid, count]) => ({ testid, count }))
    .sort((a, b) => b.count - a.count);

  return {
    base,
    container: {
      found: container.length > 0,
      children: children.length,
      path: container.length === 0 ? null : cssPath($, container.get(0) as Element),
    },
    items,
    urnCandidates: urnCandidates.slice(0, MAX_URN_CANDIDATES),
    testidsInItems: testids.slice(0, MAX_TESTIDS),
    personLinks: $(PERSON_HREF).length,
    companyLinks: $(COMPANY_HREF).length,
    truncated: {
      items: children.length > MAX_ITEMS,
      urnCandidates: urnCandidates.length > MAX_URN_CANDIDATES,
      testids: testids.length > MAX_TESTIDS,
    },
  };
}

/** Attribute-selector escaping for a tracking id. The ids are base64url and
 *  routinely contain `-` and `_`; a raw one inside `[componentkey="…"]` is
 *  still a quoted string, but a stray `"` or `\` would break the selector, so
 *  both are escaped rather than trusted. */
function CSS_escape(value: string): string {
  return value.replace(/(["\\])/g, "\\$1");
}

/** The feed DOM map, as the markdown section the parser is written against. */
export function renderFeedDomMap(o: {
  file: string;
  bytes: number;
  sourceRun: string;
  map: FeedDomMap;
}): string {
  const { map } = o;
  const lines: string[] = [];
  const cards = map.items.filter((i) => i.hasTextBox);

  lines.push(`## \`${o.file}\` — rendered DOM snapshot (feed surface)`);
  lines.push("");
  lines.push(`- ${o.bytes} bytes of \`outerHTML\`, captured by run \`${o.sourceRun}\``);
  lines.push("- **This is a measurement, not a parser contract.** Nothing below is a field");
  lines.push("  LinkedIn promises; it is what this one snapshot contained.");
  lines.push("- **A DOM read of a field a captured body also carried is a defect here (D325).**");
  lines.push("  Read the JSON sections of this document before anchoring on anything below.");
  lines.push("");

  lines.push("### Item boundary — the shape question");
  lines.push("");
  if (map.urnCandidates.length === 0) {
    lines.push("**No element attribute anywhere on this page carries an `activity`, `ugcPost`,");
    lines.push("`share` or `fsd_update` urn.** A feed card therefore cannot be bound to a post");
    lines.push("urn through an attribute, and the item boundary has to come from the SDUI");
    lines.push("namespace below instead.");
  } else {
    lines.push("| attribute | urn family | elements | distinct urns | nested | first path |");
    lines.push("|---|---|---|---|---|---|");
    for (const c of map.urnCandidates) {
      const nested = c.nested > 0 ? `**${c.nested}**` : "0";
      lines.push(
        `| \`${c.attribute}\` | \`${c.family}\` | ${c.elements} | ${c.distinctUrns} | ${nested} | \`${c.firstPath}\` |`,
      );
    }
    lines.push("");
    lines.push("A usable rule has `nested = 0` and `elements = distinct urns`. A candidate with");
    lines.push("one element is a single link, not a list — check it against the card count below");
    lines.push("before believing it names items.");
  }
  lines.push("");

  lines.push("### Item boundary — the SDUI namespace");
  lines.push("");
  if (!map.container.found) {
    lines.push(`**\`[data-testid="${FEED_CONTAINER_TESTID}"]\` is not in this snapshot.** The feed`);
    lines.push("list did not render, or LinkedIn renamed the container. Do not write a parser");
    lines.push("against this snapshot.");
    lines.push("");
    lines.push(renderActivityDomMap({ ...o, map: map.base }));
    return lines.join("\n");
  }

  lines.push(`- container \`[data-testid="${FEED_CONTAINER_TESTID}"]\` at \`${map.container.path}\``);
  lines.push(`- ${map.container.children} direct children, of which **${map.items.length}** carry a`);
  lines.push("  `componentkey` matching `expanded<TRACKING_ID>FeedType_<TYPE>` and **" +
    `${cards.length}** carry a post body. The rest are chrome (the share box, placeholders).`);
  lines.push("");
  lines.push("Each card's `<TRACKING_ID>` also names its own inner container bare — the feed's");
  lines.push("counterpart to the profile card-ref namespace of D127, and the scope every field");
  lines.push("below is read within.");
  lines.push("");
  lines.push("| # | feed type | card scope | body | author labelled | author linked | `/in/` links | `/company/` links | post urn | comments | operator's |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const i of map.items) {
    const yn = (b: boolean) => (b ? "yes" : "**no**");
    lines.push(
      `| ${i.index} | \`${i.feedType ?? "?"}\` | ${yn(i.cardScopeResolved)} | ${i.hasTextBox ? "yes" : "no"} | ` +
        `${yn(i.authorLabelled)} | ${yn(i.authorLinked)} | ${i.personLinks} | ${i.companyLinks} | ` +
        `${i.urnResolved ? "resolved" : "**none**"} | ${i.comments} | ${i.sessionOwned ? "yes" : "no"} |`,
    );
  }
  if (map.truncated.items) {
    lines.push("");
    lines.push(`_more than ${MAX_ITEMS} children; the rest are not listed._`);
  }
  lines.push("");

  const multi = cards.filter((i) => i.personLinks > 1).length;
  lines.push("**Why the author is read from a label and not from a link position.** " +
    `${multi} of ${cards.length} cards hold more than one distinct \`/in/\` link. On a card ` +
    "with social proof the first one belongs to whoever liked or commented, not to the author. " +
    "The `aria-label` `Open control menu for post by <name>` names the author, and the matching " +
    "`View <name>’s profile` link resolves that name to a url. An unlabelled card is reported " +
    "unresolved (D325), never attributed by position (D118).");
  lines.push("");

  const withUrn = cards.filter((i) => i.urnResolved).length;
  lines.push("**Post urn.** " +
    `${withUrn} of ${cards.length} cards resolve one, and only from the parent urn inside a ` +
    "rendered comment's `replaceableComment_urn:li:comment:(<parent>,<id>)` key — a comment's " +
    "parent is by definition the post it sits under. An `activity` urn found anywhere else in " +
    "a card is **not** the card's own: the measured snapshot has one card whose *post text* " +
    "links to a different post, and reading that as identity would key the item to a stranger's " +
    "content. A card with no comment rendered has no readable urn and is reported without one.");
  lines.push("");

  lines.push("### `data-testid` vocabulary inside the cards");
  lines.push("");
  if (map.testidsInItems.length === 0) {
    lines.push("**None.** Nothing inside a card carries a `data-testid`.");
  } else {
    lines.push("| data-testid | occurrences |");
    lines.push("|---|---|");
    for (const t of map.testidsInItems) lines.push(`| \`${t.testid}\` | ${t.count} |`);
    if (map.truncated.testids) {
      lines.push("");
      lines.push(`_more than ${MAX_TESTIDS} distinct testids; the rest are not listed._`);
    }
  }
  lines.push("");
  lines.push(`- person profile links anywhere on the page: **${map.personLinks}**`);
  lines.push(`- company links anywhere on the page: **${map.companyLinks}**`);
  lines.push("");

  lines.push(renderActivityDomMap({ ...o, map: map.base }));
  return lines.join("\n");
}
