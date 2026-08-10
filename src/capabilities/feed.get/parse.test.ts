import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../../core/run/root.js";
import { companySlugOf, parseFeed, DOM_SOURCE, MAX_FEED_ITEMS } from "./parse.js";
import { passesFor, MAX_FEED_PASSES, MIN_FEED_PASSES } from "./constants.js";

/**
 * Promoted fixtures are gitignored and live in the main checkout (D301), so a
 * fresh clone must skip rather than throw. Same shape as the other readers.
 */
function snapshot(): string | null {
  const path = join(repoRoot(), "fixtures", "feed.get", "438312a3d613045a-dom-snapshot.html");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const html = snapshot();
const withFixture = html === null ? describe.skip : describe;

if (html === null) {
  console.log("[skip] feed.get fixture tests — fixtures/feed.get/ is absent. Promote it from a capture first.");
}

/**
 * A card in the shape LinkedIn renders one, small enough to state a trap in.
 * `socialProof` is the link that appears *first* and belongs to whoever liked
 * the post rather than to its author — the whole reason authorship is read from
 * a label and not from a position.
 */
function card(o: {
  track: string;
  author?: string;
  authorVanity?: string;
  socialProof?: { name: string; vanity: string };
  companyHref?: string;
  labels?: string[];
  commentParents?: string[];
  text?: string;
  counts?: string[];
  body?: boolean;
}): string {
  const proof =
    o.socialProof === undefined
      ? ""
      : `<a href="https://www.linkedin.com/in/${o.socialProof.vanity}/">` +
        `<svg aria-label="View ${o.socialProof.name}’s profile"></svg></a>` +
        `<span>${o.socialProof.name} likes this</span>`;
  const menu =
    o.labels !== undefined
      ? o.labels.map((l) => `<button aria-label="${l}"></button>`).join("")
      : o.author === undefined
        ? ""
        : `<button aria-label="Open control menu for post by ${o.author}"></button>`;
  const authorLink =
    o.authorVanity === undefined
      ? ""
      : `<a href="https://www.linkedin.com/in/${o.authorVanity}/">` +
        `<svg aria-label="View ${o.author}’s profile"></svg></a>`;
  const company = o.companyHref === undefined ? "" : `<a href="${o.companyHref}">page</a>`;
  const comments = (o.commentParents ?? [])
    .map(
      (p, i) =>
        `<div componentkey="replaceableComment_urn:li:comment:(${p},${i})">` +
        `<span data-testid="expandable-text-box">a comment</span>` +
        `<span>99 reactions</span></div>`,
    )
    .join("");
  const body = o.body === false ? "" : `<span data-testid="expandable-text-box">${o.text ?? "post body"}</span>`;
  const counts = (o.counts ?? []).map((c) => `<span>${c}</span>`).join("");
  return (
    `<div><div componentkey="expanded${o.track}FeedType_MAIN_FEED_RELEVANCE">` +
    `<div componentkey="${o.track}">${proof}${menu}${authorLink}${company}${body}${counts}${comments}</div>` +
    `</div></div>`
  );
}

function feed(cards: string[]): string {
  return `<html><body><div data-testid="mainFeed">${cards.join("")}</div></body></html>`;
}

describe("feed.get — pure helpers", () => {
  it("turns a limit into a bounded pass count and never seeks the bottom", () => {
    // A feed does not end, so no limit may translate into an unbounded read.
    expect(passesFor(1)).toBe(MIN_FEED_PASSES);
    expect(passesFor(10)).toBe(5);
    expect(passesFor(100)).toBe(MAX_FEED_PASSES);
    expect(passesFor(10_000)).toBe(MAX_FEED_PASSES);
  });

  it("takes the company slug out of a page url and refuses a profile url", () => {
    expect(companySlugOf("https://www.linkedin.com/company/ssclsconnect/posts/")).toBe("ssclsconnect");
    expect(companySlugOf("https://www.linkedin.com/in/tankots/")).toBeNull();
    expect(companySlugOf(null)).toBeNull();
  });
});

describe("feed.get — per-item author resolution", () => {
  it("attributes a card to the author the label names, not to the first link on it", () => {
    // The trap, stated: Fayaz's profile link is rendered *before* Hania's, and
    // the post is Hania's. Position-based attribution is how D118 happened.
    const r = parseFeed(
      feed([
        card({
          track: "AAA",
          author: "Hania Zainab",
          authorVanity: "haniazainab99",
          socialProof: { name: "Fayaz AfriDi", vanity: "fayaz-afridi" },
        }),
      ]),
      { limit: 5 },
    );
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.value.author_name).toBe("Hania Zainab");
    expect(r.items[0]!.value.author_vanity).toBe("haniazainab99");
    expect(r.items[0]!.value.author_vanity).not.toBe("fayaz-afridi");
    expect(r.items[0]!.source).toBe(DOM_SOURCE);
  });

  it("reports an unlabelled card unresolved instead of guessing its author", () => {
    const r = parseFeed(
      feed([card({ track: "BBB", socialProof: { name: "Someone Else", vanity: "someone-else" } })]),
      { limit: 5 },
    );
    expect(r.items[0]!.value.author_name).toBeNull();
    expect(r.items[0]!.value.author_vanity).toBeNull();
    expect(r.unresolved).toBe(1);
    expect(r.warnings.map((w) => w.code)).toContain("PARSE_AUTHOR_UNRESOLVED");
  });

  it("refuses a card that names two authors rather than picking one", () => {
    const r = parseFeed(
      feed([
        card({
          track: "CCC",
          labels: [
            "Open control menu for post by Alice Adams",
            "Open control menu for post by Bob Brown",
          ],
        }),
      ]),
      { limit: 5 },
    );
    expect(r.items[0]!.value.author_name).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("PARSE_AUTHOR_AMBIGUOUS");
  });

  it("tags the operator's own item and leaves every other author untagged", () => {
    const r = parseFeed(
      feed([
        card({ track: "DDD", author: "Zaeem Dev", authorVanity: "zaeem-dev" }),
        card({ track: "EEE", author: "Someone Else", authorVanity: "someone-else" }),
      ]),
      { limit: 5, sessionVanities: ["zaeem-dev"] },
    );
    expect(r.items.map((i) => i.value.is_operator)).toEqual([true, false]);
  });

  it("resolves a company author only when the card names exactly one company", () => {
    const one = parseFeed(
      feed([
        card({
          track: "FFF",
          author: "SSCLS CONNECT",
          companyHref: "https://www.linkedin.com/company/ssclsconnect/posts/",
        }),
      ]),
      { limit: 5 },
    );
    expect(one.items[0]!.value.author_company).toBe("ssclsconnect");

    // A post *mentioning* two companies must not be attributed to either.
    const many = feed([
      card({ track: "GGG", author: "Zain Ul Abedien", companyHref: "https://www.linkedin.com/company/openai/" }).replace(
        "</div></div></div>",
        `<a href="https://www.linkedin.com/company/anthropicresearch/">x</a></div></div></div>`,
      ),
    ]);
    const r = parseFeed(many, { limit: 5 });
    expect(r.items[0]!.value.author_company).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("PARSE_AUTHOR_LINK_UNRESOLVED");
  });
});

describe("feed.get — per-item identity", () => {
  it("takes the post urn from a comment's parent, which is the post it sits under", () => {
    const r = parseFeed(
      feed([
        card({
          track: "HHH",
          author: "Zain Ul Abedien",
          authorVanity: "zain-vyro-ai",
          commentParents: ["urn:li:activity:7492274794852220928", "urn:li:activity:7492274794852220928"],
        }),
      ]),
      { limit: 5 },
    );
    expect(r.items[0]!.value.urn).toBe("urn:li:activity:7492274794852220928");
    expect(r.items[0]!.value.urn_source).toBe("comment-parent");
    // Derived from the snowflake, not from the rendered "10h".
    expect(r.items[0]!.value.posted_at).toBe("2026-08-09T17:45:10.827Z");
  });

  it("does not read an activity urn linked inside the post body as the item's own", () => {
    // Measured on the live snapshot: one card's post text links to a different
    // post. Reading that as identity keys the item to a stranger's content.
    const r = parseFeed(
      feed([
        card({
          track: "III",
          author: "Hania Zainab",
          authorVanity: "haniazainab99",
          text: `see <a href="https://www.linkedin.com/feed/update/urn:li:activity:7492285296089403392/">this</a>`,
        }),
      ]),
      { limit: 5 },
    );
    expect(r.items[0]!.value.urn).toBeNull();
    expect(r.items[0]!.value.posted_at).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("PARSE_ITEM_URN_UNRESOLVED");
  });

  it("refuses a urn when the card's comments disagree about their parent", () => {
    const r = parseFeed(
      feed([
        card({
          track: "JJJ",
          author: "A B",
          commentParents: ["urn:li:activity:1000000000000000000", "urn:li:activity:2000000000000000000"],
        }),
      ]),
      { limit: 5 },
    );
    expect(r.items[0]!.value.urn).toBeNull();
  });
});

describe("feed.get — bounds and scope", () => {
  it("reads a card's own totals and never a comment's", () => {
    const r = parseFeed(
      feed([
        card({
          track: "KKK",
          author: "A B",
          counts: ["24 reactions", "2 comments"],
          commentParents: ["urn:li:activity:7492274794852220928"],
        }),
      ]),
      { limit: 5 },
    );
    // The comment rows each render "99 reactions"; the card's own is 24.
    expect(r.items[0]!.value.reactions_total).toBe(24);
    expect(r.items[0]!.value.comments_total).toBe(2);
    expect(r.items[0]!.value.comments_rendered).toBe(1);
  });

  it("stops at --limit and reports the rest as partial rather than as the whole", () => {
    const r = parseFeed(
      feed([
        card({ track: "L1", author: "A", authorVanity: "a" }),
        card({ track: "L2", author: "B", authorVanity: "b" }),
        card({ track: "L3", author: "C", authorVanity: "c" }),
      ]),
      { limit: 2 },
    );
    expect(r.items).toHaveLength(2);
    // Every card is still counted, so a limit cannot make the page look short.
    expect(r.container.cards).toBe(3);
    expect(r.partial).toBe(true);
  });

  it("flags a read that fell short of the limit", () => {
    const r = parseFeed(feed([card({ track: "M1", author: "A", authorVanity: "a" })]), { limit: 10 });
    const partial = r.warnings.find((w) => w.code === "FEED_PARTIAL");
    expect(partial?.n).toBe(9);
  });

  it("skips container chrome that carries no card key", () => {
    const r = parseFeed(
      feed([
        `<div><div>share box</div></div>`,
        card({ track: "N2", author: "B", authorVanity: "b" }),
      ]),
      { limit: 10 },
    );
    expect(r.container.children).toBe(2);
    expect(r.container.cards).toBe(1);
    expect(r.items.map((i) => i.value.author_vanity)).toEqual(["b"]);
  });

  it("returns a card with no text box instead of dropping it", () => {
    // An image-only or video-only post has no expandable-text-box. Dropping it
    // removed the post from items, from cards and from every warning at once.
    const r = parseFeed(
      feed([
        card({ track: "N1", author: "A", authorVanity: "a", body: false }),
        card({ track: "N2", author: "B", authorVanity: "b" }),
      ]),
      { limit: 10 },
    );
    expect(r.container.cards).toBe(2);
    expect(r.items.map((i) => i.value.author_vanity)).toEqual(["a", "b"]);
    expect(r.items[0]!.value.text_chars).toBe(0);
    const w = r.warnings.find((x) => x.code === "FEED_ITEM_NO_BODY");
    expect(w?.n).toBe(1);
  });

  it("resolves an author from a relative href and still tags the operator", () => {
    // LinkedIn renders both spellings. A relative one used to give a non-null
    // author_url with a null vanity, so the D119 tagging guard went inert on a
    // row that looked resolved.
    const html = feed([card({ track: "R1", author: "Zaeem Dev", authorVanity: "zaeem-dev" })]).replace(
      "https://www.linkedin.com/in/zaeem-dev/",
      "/in/zaeem-dev/",
    );
    const r = parseFeed(html, { limit: 5, sessionVanities: ["zaeem-dev"] });
    expect(r.items[0]!.value.author_vanity).toBe("zaeem-dev");
    expect(r.items[0]!.value.author_url).toBe("https://www.linkedin.com/in/zaeem-dev/");
    expect(r.items[0]!.value.is_operator).toBe(true);
  });

  it("counts warning ratios against the cards it read, not the cards on the page", () => {
    const r = parseFeed(
      feed([
        card({ track: "W1", author: "A", authorVanity: "a" }),
        card({ track: "W2", author: "B", authorVanity: "b" }),
        card({ track: "W3" }),
        card({ track: "W4" }),
      ]),
      { limit: 2 },
    );
    expect(r.container.cards).toBe(4);
    expect(r.container.examined).toBe(2);
    // The two unlabelled cards were never read, so nothing claims they were.
    expect(r.unresolved).toBe(0);
    expect(r.warnings.find((w) => w.code === "PARSE_ITEM_URN_UNRESOLVED")?.field)
      .toContain("2 of the 2 cards read");
  });

  it("refuses a snapshot with no feed container instead of returning an empty read", () => {
    const r = parseFeed("<html><body><main></main></body></html>", { limit: 10 });
    expect(r.ok).toBe(false);
    expect(r.items).toHaveLength(0);
    expect(r.warnings.map((w) => w.code)).toContain("PARSE_CONTAINER_MISSING");
  });

  it("cannot return more items than MAX_FEED_ITEMS however large --limit is", () => {
    const many = feed(
      Array.from({ length: MAX_FEED_ITEMS + 5 }, (_, i) =>
        card({ track: `T${i}`, author: `P${i}`, authorVanity: `p${i}` }),
      ),
    );
    expect(parseFeed(many, { limit: 10_000 }).items.length).toBe(MAX_FEED_ITEMS);
  });
});

withFixture("feed.get — against the promoted snapshot", () => {
  it("finds the feed container and every card under it", () => {
    const r = parseFeed(html!, { limit: 100 });
    expect(r.ok).toBe(true);
    expect(r.container.found).toBe(true);
    expect(r.container.children).toBe(13);
    // 13 children, 8 of them cards: the rest is the share box and placeholders.
    expect(r.container.cards).toBe(8);
    expect(r.items).toHaveLength(8);
  });

  it("resolves every card's author, and the social-proof cards to the right person", () => {
    const r = parseFeed(html!, { limit: 100, sessionVanities: ["zaeem-dev"] });
    expect(r.unresolved).toBe(0);
    const byVanity = new Map(r.items.map((i) => [i.value.author_vanity, i.value]));

    // "Fayaz AfriDi likes this" heads this card; Hania Zainab wrote it.
    expect(byVanity.get("haniazainab99")?.author_name).toBe("Hania Zainab");
    expect(byVanity.has("fayaz-afridi-80ba02224")).toBe(false);
    // "Hammad Malik commented"; Hammad Ishaq wrote it.
    expect(byVanity.get("hammad-ishaq-a97335288")?.author_name).toBe("Hammad Ishaq");
    expect(byVanity.has("hammad2")).toBe(false);

    // The promoted post is a company page, resolved as a company and not as a
    // person — the author field it fills is the company one.
    const company = r.items.find((i) => i.value.author_company !== null)!.value;
    expect(company.author_name).toBe("SSCLS CONNECT");
    expect(company.author_company).toBe("ssclsconnect");
    expect(company.author_vanity).toBeNull();

    // None of these eight is the operator's own post, and the tag says so
    // rather than being absent.
    expect(r.items.every((i) => i.value.is_operator === false)).toBe(true);
  });

  it("resolves a post urn only for the cards that rendered a comment", () => {
    const r = parseFeed(html!, { limit: 100 });
    const withUrn = r.items.filter((i) => i.value.urn !== null);
    expect(withUrn).toHaveLength(3);
    expect(withUrn.every((i) => i.value.comments_rendered > 0)).toBe(true);
    expect(r.items.filter((i) => i.value.urn === null).every((i) => i.value.comments_rendered === 0)).toBe(true);

    // Meaning, not shape: this urn is the parent of the comments on Zain's
    // card, and the time is derived from its snowflake rather than from "10h".
    const zain = r.items.find((i) => i.value.author_vanity === "zain-vyro-ai")!.value;
    expect(zain.urn).toBe("urn:li:activity:7492274794852220928");
    expect(zain.urn_source).toBe("comment-parent");
    expect(zain.posted_at).toBe("2026-08-09T17:45:10.827Z");

    // A ugcPost urn is a different family; no snowflake conversion is claimed
    // for it, so posted_at stays null rather than being guessed.
    const hammad = r.items.find((i) => i.value.author_vanity === "hammad-ishaq-a97335288")!.value;
    expect(hammad.urn).toBe("urn:li:ugcPost:7492277274373922816");
    expect(hammad.posted_at).toBeNull();
  });

  it("reads each card's own counts and body length", () => {
    const r = parseFeed(html!, { limit: 100 });
    const rick = r.items.find((i) => i.value.author_vanity === "thedomainking")!.value;
    expect(rick.reactions_total).toBe(24);
    expect(rick.comments_total).toBe(2);
    expect(rick.text_chars).toBe(267);

    // Berkay's card renders three comments and reports fifty; the count read is
    // the card's own total, not the number of comment rows on screen.
    const berkay = r.items.find((i) => i.value.author_vanity === "berkay-alkan-a76889146")!.value;
    expect(berkay.comments_total).toBe(50);
    expect(berkay.comments_rendered).toBe(3);

    // No post body reaches the parsed row — only its length.
    expect(r.items.every((i) => !("text" in i.value))).toBe(true);
  });

  it("tags every row DOM-sourced and reports the read as partial", () => {
    const r = parseFeed(html!, { limit: 100 });
    expect(r.items.every((i) => i.source === DOM_SOURCE)).toBe(true);
    expect(r.partial).toBe(true);
  });
});
