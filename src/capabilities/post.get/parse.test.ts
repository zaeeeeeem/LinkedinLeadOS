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
