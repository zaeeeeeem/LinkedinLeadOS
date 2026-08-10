import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../../core/run/root.js";
import { countFromLabel, parsePost, vanityOf, DOM_SOURCE } from "./parse.js";

const URN = "urn:li:activity:7491197577439141888";
const OPERATOR = ["zaeem-dev"];

/**
 * Promoted fixtures are gitignored and live in the main checkout (D301), so a
 * fresh clone must skip rather than throw. Same shape as the other readers.
 */
function snapshot(): string | null {
  const path = join(repoRoot(), "fixtures", "post.get", "438312a3d613045a-dom-snapshot.html");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const html = snapshot();
const withFixture = html === null ? describe.skip : describe;

if (html === null) {
  console.log("[skip] post.get fixture tests — fixtures/post.get/ is absent. Promote it from a capture first.");
}

describe("post.get — pure helpers", () => {
  it("reads a count only when it is the element's whole text", () => {
    expect(countFromLabel("1,013 reactions", /reactions?/)).toBe(1013);
    expect(countFromLabel("73 comments", /comments?/)).toBe(73);
    // The bug this pins: page-wide text glues adjacent counts together, and a
    // loose match read 101,373 comments off a post with 73.
    expect(countFromLabel("1,01373 comments", /comments?/)).toBe(101373);
    expect(countFromLabel("1,013 reactions73 comments", /comments?/)).toBeNull();
  });

  it("takes the vanity out of a profile url and refuses anything else", () => {
    expect(vanityOf("https://www.linkedin.com/in/tankots/")).toBe("tankots");
    expect(vanityOf("https://www.linkedin.com/in/tankots?trk=abc")).toBe("tankots");
    expect(vanityOf("https://www.linkedin.com/company/wisprflow/")).toBeNull();
    expect(vanityOf(undefined)).toBeNull();
  });
});

withFixture("post.get — against the promoted snapshot", () => {
  it("resolves identity from the testid and reads the post's own fields", () => {
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR });
    expect(r.ok).toBe(true);
    const p = r.post!.value;
    expect(r.post!.source).toBe(DOM_SOURCE);
    expect(p.urn).toBe(URN);
    expect(p.author_vanity).toBe("tankots");
    expect(p.text).toContain("This week marks 5 years since Wispr Flow was founded.");
    expect(p.posted_at).toMatch(/^2026-08-06T/);
    expect(p).toMatchObject({ reactions_total: 1013, comments_total: 73, reposts_total: 5 });
  });

  it("reads nothing but the post by default — D313's whole point", () => {
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR });
    expect(r.comments).toEqual([]);
    expect(r.reactions).toEqual([]);
    // No partial warning either: nothing was asked for, so nothing is partial.
    expect(r.warnings).toEqual([]);
  });

  it("reads comments only when asked, bounded by the limit, and flags the remainder", () => {
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR, comments: { limit: 5 } });
    expect(r.comments).toHaveLength(5);
    expect(r.comments[0]!.source).toBe(DOM_SOURCE);
    expect(r.comments[0]!.value).toMatchObject({
      urn: "urn:li:comment:(urn:li:activity:7491197577439141888,7491238916163903489)",
      author_vanity: "verma-shruti",
    });
    expect(r.comments[0]!.value.text).toContain("Started using Notetaker");
    // 73 on the page, 5 read → the caller is told, by number, what it does not have.
    const partial = r.warnings.find((w) => w.code === "COMMENTS_PARTIAL");
    expect(partial).toBeDefined();
    expect(partial!.n).toBe(68);
  });

  it("never returns more comments than the page rendered, however high the limit", () => {
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR, comments: { limit: 500 } });
    // 14 rendered of 73. A limit above what is present must not loop or invent.
    expect(r.comments).toHaveLength(14);
    expect(r.warnings.find((w) => w.code === "COMMENTS_PARTIAL")!.n).toBe(59);
  });

  it("reads reactions only when asked, and flags the remainder", () => {
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR, reactions: { limit: 3 } });
    expect(r.reactions).toHaveLength(3);
    expect(r.reactions[0]!.value).toMatchObject({ actor_name: "Dhruv Tyagi", reaction: "Like", actor_vanity: "dhruvcodes" });
    expect(r.warnings.find((w) => w.code === "REACTIONS_PARTIAL")!.n).toBe(1010);
  });

  it("refuses a snapshot of a different post rather than reconciling it", () => {
    const r = parsePost(html!, { expectedUrn: "urn:li:activity:1", sessionVanities: OPERATOR });
    expect(r.ok).toBe(false);
    expect(r.post).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(["PARSE_IDENTITY_MISMATCH"]);
  });

  it("refuses a snapshot with no identity anchor at all", () => {
    const stripped = html!.replaceAll("ReactionFacepileCollection-", "SomethingElse-");
    const r = parsePost(stripped, { expectedUrn: URN, sessionVanities: OPERATOR });
    expect(r.ok).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(["PARSE_IDENTITY_UNRESOLVED"]);
  });

  it("cannot name an author once the operator's own link is not excluded", () => {
    // The D119 trap in its DOM spelling: the left rail carries the operator's
    // profile, so without the session set the author is ambiguous — and the
    // parser says so instead of picking the first link.
    const r = parsePost(html!, { expectedUrn: URN });
    expect(r.post!.value.author_vanity).toBeNull();
    const w = r.warnings.find((x) => x.code === "PARSE_AUTHOR_AMBIGUOUS");
    expect(w).toBeDefined();
    expect(w!.field).toContain("zaeem-dev");
  });

  it("keeps reactors and commenters out of the author candidates", () => {
    // Both scopes are excluded by identity, not by position: 14 profile links
    // sit outside the comment rows, and only the facepile exclusion leaves one.
    const r = parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR });
    expect(r.post!.value.author_vanity).toBe("tankots");
    expect(r.warnings.find((w) => w.code === "PARSE_AUTHOR_AMBIGUOUS")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The second renderer (D340). On 2026-08-10 the post surface began serving the
// legacy Ember/`theme--mercado` app, which carries **zero** `data-testid`
// attributes — so every anchor the SDUI parser above uses is absent, and it
// refused. These pin the fallback against two real snapshots: one person-authored
// and one company-authored, both archived by the 13:27/13:29 live gate.
// ─────────────────────────────────────────────────────────────────────────────

const EMBER_PERSON_URN = "urn:li:activity:7491197577439141888";
const EMBER_COMPANY_URN = "urn:li:activity:7485405402449379328";

function emberSnapshot(name: string): string | null {
  const path = join(repoRoot(), "fixtures", "post.get", name);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const ember = emberSnapshot("ember-person-dom-snapshot.html");
const emberCompany = emberSnapshot("ember-company-dom-snapshot.html");
const withEmber = ember === null || emberCompany === null ? describe.skip : describe;

if (ember === null || emberCompany === null) {
  console.log("[skip] post.get Ember fixture tests — fixtures/post.get/ember-*-dom-snapshot.html are absent.");
}

describe("post.get — renderer detection", () => {
  it("calls a snapshot with no anchor of either renderer unknown", () => {
    const r = parsePost("<html><body><p>nothing</p></body></html>", { expectedUrn: EMBER_PERSON_URN });
    expect(r.ok).toBe(false);
    expect(r.renderer).toBe("unknown");
    expect(r.warnings.map((w) => w.code)).toEqual(["PARSE_IDENTITY_UNRESOLVED"]);
  });
});

withEmber("post.get — the Ember renderer, person-authored", () => {
  it("names the renderer it actually parsed", () => {
    expect(parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR }).renderer).toBe("ember");
    // And the SDUI fixture is still parsed as SDUI — the fallback never takes
    // over a page the primary can read.
    expect(parsePost(html!, { expectedUrn: URN, sessionVanities: OPERATOR }).renderer).toBe("sdui");
  });

  it("resolves identity from data-urn on the post card", () => {
    const r = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR });
    expect(r.ok).toBe(true);
    expect(r.post!.source).toBe(DOM_SOURCE);
    expect(r.post!.value.urn).toBe(EMBER_PERSON_URN);
  });

  it("refuses a snapshot of a different post rather than reconciling it", () => {
    const r = parsePost(ember!, { expectedUrn: "urn:li:activity:1", sessionVanities: OPERATOR });
    expect(r.ok).toBe(false);
    expect(r.post).toBeNull();
    expect(r.warnings.map((w) => w.code)).toEqual(["PARSE_IDENTITY_MISMATCH"]);
  });

  it("reads the post's own fields", () => {
    const p = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR }).post!.value;
    expect(p.author_vanity).toBe("tankots");
    expect(p.text).toContain("This week marks 5 years since Wispr Flow was founded.");
    expect(p.posted_at).toMatch(/^2026-08-06T/);
    expect(p).toMatchObject({ reactions_total: 1049, comments_total: 73, reposts_total: 5 });
  });

  it("does not read a comment's own reaction count as the post's", () => {
    // "8 Reactions on Shruti Verma's comment" renders inside a comment row and
    // is the exact shape that would poison an unscoped count.
    const p = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR }).post!.value;
    expect(p.reactions_total).not.toBe(8);
  });

  it("reads nothing but the post by default — D313 holds on both renderers", () => {
    const r = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR });
    expect(r.comments).toEqual([]);
    expect(r.reactions).toEqual([]);
  });

  it("reads comments only when asked, bounded, and flags the remainder", () => {
    const r = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR, comments: { limit: 3 } });
    expect(r.comments).toHaveLength(3);
    expect(r.comments[0]!.source).toBe(DOM_SOURCE);
    expect(r.comments[0]!.value.urn).toMatch(/^urn:li:comment:\(activity:7491197577439141888,\d+\)$/);
    expect(r.comments[0]!.value.author_vanity).toBe("verma-shruti");
    expect(r.comments[0]!.value.text).toContain("Notetaker");
    const w = r.warnings.find((x) => x.code === "COMMENTS_PARTIAL");
    expect(w).toBeDefined();
    expect(w!.n).toBe(70);
  });

  it("never returns more comments than the page rendered", () => {
    const r = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR, comments: { limit: 500 } });
    expect(r.comments).toHaveLength(10);
  });

  it("reads reactions only when asked, from the facepile", () => {
    const r = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR, reactions: { limit: 3 } });
    expect(r.reactions).toHaveLength(3);
    expect(r.reactions[0]!.value.actor_name).toBe("Lakshya Prasad");
    expect(r.reactions[0]!.value.reaction).toBe("LIKE");
    expect(r.warnings.find((x) => x.code === "REACTIONS_PARTIAL")).toBeDefined();
  });

  it("refuses a card whose identity anchor is gone", () => {
    const stripped = ember!.replaceAll("data-urn=", "data-was=");
    const r = parsePost(stripped, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR });
    expect(r.ok).toBe(false);
    expect(r.warnings.map((w) => w.code)).toEqual(["PARSE_IDENTITY_UNRESOLVED"]);
  });
});

withEmber("post.get — the Ember renderer, company-authored", () => {
  it("reads the post but names no author vanity, and says why (D334)", () => {
    const r = parsePost(emberCompany!, { expectedUrn: EMBER_COMPANY_URN, sessionVanities: OPERATOR });
    expect(r.ok).toBe(true);
    expect(r.post!.value.urn).toBe(EMBER_COMPANY_URN);
    expect(r.post!.value.author_vanity).toBeNull();
    const w = r.warnings.find((x) => x.code === "PARSE_AUTHOR_COMPANY");
    expect(w).toBeDefined();
    expect(w!.field).toContain("wisprflow");
  });

  it("does not attribute the post to the reshared post's author", () => {
    // The card embeds another update whose actor is a person. Taking "the only
    // /in/ link in the card" would store this post under sudha-ranganathan.
    const r = parsePost(emberCompany!, { expectedUrn: EMBER_COMPANY_URN, sessionVanities: OPERATOR });
    expect(r.post!.value.author_vanity).toBeNull();
    expect(JSON.stringify(r.warnings)).not.toContain("sudha-ranganathan");
  });

  it("reads the outer post's commentary, not the embedded one's", () => {
    const p = parsePost(emberCompany!, { expectedUrn: EMBER_COMPANY_URN, sessionVanities: OPERATOR }).post!.value;
    expect(p.text).toContain("If your appetite to do things in your life");
    expect(p.text).not.toContain("I had a dream");
  });

  it("reads a comment whose urn is spelled ugcPost, not activity", () => {
    const r = parsePost(emberCompany!, { expectedUrn: EMBER_COMPANY_URN, sessionVanities: OPERATOR, comments: { limit: 5 } });
    expect(r.comments).toHaveLength(1);
    expect(r.comments[0]!.value.urn).toMatch(/^urn:li:comment:\(ugcPost:\d+,\d+\)$/);
  });
});

withEmber("post.get — the Ember guards, each proven to bite", () => {
  it("never adopts a comment's own reaction count as the post's", () => {
    // Remove the post's own totals bar and leave the comments' counts standing.
    // A parser that reads counts unscoped, or with a loose regex, answers 8 here
    // — the number on Shruti Verma's comment. The right answer is "I don't know".
    const stripped = ember!.replaceAll('aria-label="1,049 reactions"', 'aria-label="reactions"');
    const p = parsePost(stripped, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR }).post!.value;
    expect(p.reactions_total).toBeNull();
  });

  it("ignores a comment's count even when it is spelled exactly like the post's", () => {
    // The adversarial case the scope exists for: strip the post's own total and
    // give a comment the post's exact label shape. Only the comment-row
    // exclusion can tell these apart — the regex cannot, because they are now
    // the same string.
    const stripped = ember!
      .replaceAll('aria-label="1,049 reactions"', 'aria-label="reactions"')
      .replace("8 Reactions on Shruti Verma\u2019s comment", "8 reactions");
    const p = parsePost(stripped, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR }).post!.value;
    expect(p.reactions_total).toBeNull();
  });

  it("refuses the author when the actor link and the control menu disagree", () => {
    // Two independent anchors name the author. If they disagree the page is not
    // the one we think it is, and a guess would store the post under the wrong
    // person — the expensive direction of this error.
    const tampered = ember!.replace("Open control menu for post by Tanay Kothari", "Open control menu for post by Someone Else");
    const r = parsePost(tampered, { expectedUrn: EMBER_PERSON_URN, sessionVanities: OPERATOR });
    expect(r.post!.value.author_vanity).toBeNull();
    const w = r.warnings.find((x) => x.code === "PARSE_AUTHOR_AMBIGUOUS");
    expect(w).toBeDefined();
    expect(w!.field).toContain("Someone Else");
  });

  it("refuses to attribute a post to the operator's own actor link", () => {
    const asOperator = parsePost(ember!, { expectedUrn: EMBER_PERSON_URN, sessionVanities: ["tankots"] });
    expect(asOperator.post!.value.author_vanity).toBeNull();
    expect(asOperator.warnings.find((w) => w.code === "PARSE_AUTHOR_AMBIGUOUS")!.field).toContain("session's own");
  });
});
