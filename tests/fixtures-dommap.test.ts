import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  CARD_REF_PREFIX,
  MAX_HITS_PER_PROBE,
  MAX_LEAVES_PER_CARD,
  MAX_SAMPLE_CHARS,
  STRANGER_CARDS,
  buildDomFieldMap,
  cssPath,
  renderDomFieldMap,
  resolveSubjectScope,
} from "../src/core/fixtures/dommap.js";
import type { Element } from "domhandler";

/**
 * Every structure below is the one the live snapshot of `/in/tankots/` actually
 * had (run 01KZJ5N27B…, 2026-08-09, 874,761 chars) — hashed class names, SDUI
 * card refs namespaced by the subject's profile id, and a sidebar of strangers
 * carrying their own Connect buttons. A synthetic "reasonable" profile page
 * would certify these rules against markup LinkedIn does not serve.
 */
const SUBJECT_ID = "ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA";
const STRANGER_ID = "ACoAAE1JGFIBwVzih4BX7SXeW9WLwcBP6lmQE3s";

function card(name: string, inner: string, id = SUBJECT_ID, tag = "section"): string {
  return `<${tag} componentkey="${CARD_REF_PREFIX}${id}${name}">${inner}</${tag}>`;
}

/** The Topcard's real nesting: the name behind a verification trigger, then two
 *  sibling paragraphs (headline, company·school), then location in a sibling
 *  div, then the follower and connection counts. */
const TOPCARD_INNER = `
  <div><div>
    <div class="_1a2b3c4d"></div>
    <div class="_5e6f7a8b">
      <div><div>
        <div><div>
          <div>
            <a componentkey="ProfileVerificationTriggerRef-tankots">
              <div componentkey="ProfileVerificationTriggerRef-tankots"><div>
                <h2 class="b0712e9a">Tanay Kothari</h2>
              </div></div>
            </a>
          </div>
        </div></div>
        <div>
          <p class="_397709b2">· 1st</p>
          <p class="_3903d4e3">CEO at Wispr Flow | IOI Medalist | Forbes 30 under 30 | Stanford CS + AI</p>
          <p class="_5e09f4d5">Wispr Flow · Stanford University</p>
          <div><p class="_3876217e">San Francisco, California, United States</p></div>
        </div>
      </div></div>
      <div><p>105,570 followers</p><p>500+</p></div>
      <div componentkey="ConnectButtonstate:invitation:urn:li:member:306907360_pending">Connect</div>
      <div componentkey="FollowButtonurn:li:fsd_followingState:urn:li:member:306907360_following">Follow</div>
    </div>
  </div></div>`;

/** The sidebar as it really is: inside `main#workspace`, inside the subject's
 *  own `SuggestedForYou` card, and every suggestion has its own Connect button. */
const SIDEBAR = card(
  "SuggestedForYou",
  `<aside>
     <div componentkey="ConnectButtonstate:invitation:urn:li:member:999111222_pending">Connect</div>
     <div componentkey="ConnectButtonstate:invitation:urn:li:member:333444555_pending">Connect</div>
     <a href="https://www.linkedin.com/in/axellemalek/">Axelle Malek</a>
   </aside>`,
);

function page(...cards: string[]): string {
  return `<html><body><main id="workspace"><div>${cards.join("")}</div></main></body></html>`;
}

const LIVE_PAGE = page(
  card("Topcard", TOPCARD_INNER),
  card("About", "<p>About me</p>", SUBJECT_ID, "div"),
  card("ExperienceTopLevelSection", "<div><p>Co-Founder / CEO</p><p>Aug 2021 - Present</p></div>", SUBJECT_ID, "div"),
  card("EducationTopLevelSection", "<div><p>Stanford University</p></div>", SUBJECT_ID, "div"),
  card("Skills", "<div><p>Python</p></div>", SUBJECT_ID, "div"),
  SIDEBAR,
  `<div componentkey="${CARD_REF_PREFIX}tankotsActivity">activity</div>`,
);

describe("resolveSubjectScope", () => {
  it("recovers the subject's profile id from the card-ref namespace", () => {
    const scope = resolveSubjectScope(cheerio.load(LIVE_PAGE));
    expect(scope.profileId).toBe(SUBJECT_ID);
    expect(scope.profileUrn).toBe(`urn:li:fsd_profile:${SUBJECT_ID}`);
    expect(scope.unrecognisedCards).toEqual([]);
    expect(scope.vanity).toBe("tankots");
  });

  it("names every card and marks the one that holds other people", () => {
    const scope = resolveSubjectScope(cheerio.load(LIVE_PAGE));
    expect(scope.cards.map((c) => c.name)).toEqual([
      "Topcard", "About", "ExperienceTopLevelSection", "EducationTopLevelSection", "Skills", "SuggestedForYou",
    ]);
    expect(scope.cards.find((c) => c.name === "SuggestedForYou")!.stranger).toBe(true);
    expect(scope.cards.find((c) => c.name === "Topcard")!.stranger).toBe(false);
    expect(STRANGER_CARDS).toContain("SuggestedForYou");
  });

  it("takes only the subject's member urn, never the sidebar suggestions'", () => {
    // The regression. Unscoped, this returned 17 urns on the live snapshot and
    // 16 were strangers — D119's trap inside the function meant to expose it.
    const scope = resolveSubjectScope(cheerio.load(LIVE_PAGE));
    expect(scope.memberUrns).toEqual(["urn:li:member:306907360"]);
  });

  it("refuses to name a subject when the cards disagree about whose page this is", () => {
    // Two ids means the namespace does not identify one subject; a confident
    // wrong answer here is the whole failure mode D121 recorded. The two live
    // ids share only `ACoAA`, so the common prefix is not a usable id at all.
    const mixed = page(card("Topcard", TOPCARD_INNER), card("About", "<p>x</p>", STRANGER_ID, "div"));
    const scope = resolveSubjectScope(cheerio.load(mixed));
    expect(scope.profileId).toBeNull();
    expect(scope.cards).toEqual([]);
  });

  it("does not let a single-card snapshot resolve an id ending in the card's name", () => {
    // The regression, and it was the dangerous kind: with one card ref the
    // common prefix is `<id>Topcard`, which passed the id shape and produced a
    // confident `urn:li:fsd_profile:<id>Topcard` for a real person.
    const alone = page(card("Topcard", TOPCARD_INNER));
    const scope = resolveSubjectScope(cheerio.load(alone));
    expect(scope.profileId).toBe(SUBJECT_ID);
    expect(scope.profileUrn).toBe(`urn:li:fsd_profile:${SUBJECT_ID}`);
    expect(scope.cards.map((c) => c.name)).toEqual(["Topcard"]);
  });

  it("resolves nothing when the only card's name is one this build does not know", () => {
    // The last way this could be confidently wrong, and `peelCardName` did not
    // close it: with one card ref the common prefix is `<id><CardName>`, and if
    // that name is not in KNOWN_CARDS it stays stuck on the end and passes the
    // id shape. It returned `urn:li:fsd_profile:<id>BrandNewCardName` for a real
    // person, with an empty card list and no warning anywhere. The cards are
    // what confirm the id, so no cards means no id.
    const unknown = page(card("BrandNewCardName", "<h2>Someone Real</h2>"));
    const scope = resolveSubjectScope(cheerio.load(unknown));
    expect(scope.profileId).toBeNull();
    expect(scope.profileUrn).toBeNull();
    expect(scope.cards).toEqual([]);

    // And the map says so out loud rather than offering a wrong urn.
    const md = renderDomFieldMap({
      file: "x.html", bytes: 1, sourceRun: "r", map: buildDomFieldMap(unknown),
    });
    expect(md).toContain("No subject scope could be resolved");
    expect(md).not.toContain("BrandNewCardName");
  });

  it("still resolves when an unknown card sits alongside a known one", () => {
    // The guard must not over-fire: two refs make the common prefix end at the
    // id, so LinkedIn shipping a new card name costs nothing.
    const scope = resolveSubjectScope(
      cheerio.load(page(card("BrandNewCardName", "<p>x</p>"), card("Topcard", TOPCARD_INNER))),
    );
    expect(scope.profileId).toBe(SUBJECT_ID);
    expect(scope.cards.map((c) => c.name).sort()).toEqual(["BrandNewCardName", "Topcard"]);
    expect(scope.unrecognisedCards).toEqual(["BrandNewCardName"]);
  });

  it("resolves nothing, rather than guessing, on a page with no card refs", () => {
    const scope = resolveSubjectScope(cheerio.load("<html><body><main><h2>Someone</h2></main></body></html>"));
    expect(scope.profileId).toBeNull();
    expect(scope.profileUrn).toBeNull();
    expect(scope.cards).toEqual([]);
    expect(scope.memberUrns).toEqual([]);
  });
});

describe("cssPath", () => {
  it("anchors on the nearest componentkey and stops there", () => {
    const $ = cheerio.load(LIVE_PAGE);
    const h2 = $("h2")[0] as Element;
    const path = cssPath($, h2);
    expect(path).toBe('div[componentkey="ProfileVerificationTriggerRef-tankots"] > div > h2');
    // And it is a real path: it resolves, in this document, to that element.
    expect($(path).text()).toBe("Tanay Kothari");
  });

  it("does not anchor on a generated uuid componentkey", () => {
    // LinkedIn mixes uuid componentkeys in among the meaningful ones; anchoring
    // on one produces a path that is dead on the next render.
    const $ = cheerio.load(
      '<html><body><div id="root"><div componentkey="1a660dd4-365f-4b3e-8b8f-f22f5831f31b"><p>hi</p></div></div></body></html>',
    );
    const p = $("p")[0] as Element;
    expect(cssPath($, p)).toBe("div#root > div > p");
  });

  it("falls back to nth-of-type among same-tag siblings", () => {
    const $ = cheerio.load('<html><body><div id="r"><p>a</p><p>b</p><p>c</p></div></body></html>');
    const path = cssPath($, $("p")[1] as Element);
    expect(path).toBe("div#r > p:nth-of-type(2)");
    expect($(path).text()).toBe("b");
  });
});

describe("buildDomFieldMap", () => {
  const map = buildDomFieldMap(LIVE_PAGE);
  const probe = (name: string) => map.probes.find((p) => p.name === name)!;

  it("names every path the task requires, inside the subject's container", () => {
    for (const name of ["headline", "location", "experience"]) {
      expect(probe(name).hits.length, name).toBeGreaterThan(0);
      expect(probe(name).hits.every((h) => h.inSubjectScope), name).toBe(true);
    }
  });

  it("finds the headline, and not the degree badge above it", () => {
    const hits = probe("headline").hits;
    expect(hits[0]!.sample).toBe("CEO at Wispr Flow | IOI Medalist | Forbes 30 under 30 | Stanford CS + AI");
    expect(hits[0]!.basis).toBe("position");
  });

  it("finds the location, and not the follower count that has the same shape", () => {
    // `105,570 followers` satisfies the comma-shape cleanly and was reported as
    // the location on the first generated map.
    const hits = probe("location").hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sample).toBe("San Francisco, California, United States");
  });

  it("separates the company·school line from the location", () => {
    expect(probe("current_company").hits[0]!.sample).toBe("Wispr Flow · Stanford University");
  });

  it("reads the subject's urn from the card namespace, never from a stranger's", () => {
    const hits = probe("person_urn").hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.sample).toContain(`urn:li:fsd_profile:${SUBJECT_ID}`);
    expect(hits[0]!.basis).toBe("componentkey");
    expect(hits[0]!.sample).not.toContain(STRANGER_ID);
  });

  it("addresses the section cards by componentkey, which survives a restyle", () => {
    for (const name of ["experience", "education", "skills", "about"]) {
      expect(probe(name).hits[0]!.basis, name).toBe("componentkey");
    }
  });

  it("every path it reports actually resolves in the snapshot it was built from", () => {
    // The property that makes a field map worth anything: it is checkable.
    const $ = cheerio.load(LIVE_PAGE);
    for (const p of map.probes) {
      for (const hit of p.hits) {
        if (hit.basis === "componentkey" && p.name === "person_urn") continue; // a namespace, not a value
        expect($(hit.path).length, `${p.name}: ${hit.path}`).toBeGreaterThan(0);
      }
    }
  });

  it("reports a miss with what it looked for, rather than an empty table", () => {
    const bare = buildDomFieldMap(page(card("Topcard", "<div><h2>Nobody</h2></div>")));
    expect(bare.probes.find((p) => p.name === "experience")!.hits).toEqual([]);
    expect(bare.probes.find((p) => p.name === "experience")!.miss).toContain("ExperienceTopLevelSection");
  });

  it("survives a page with no profile in it at all", () => {
    const map = buildDomFieldMap("<html><body><p>Something else entirely</p></body></html>");
    expect(map.scope.profileId).toBeNull();
    expect(map.probes.every((p) => p.hits.length === 0)).toBe(true);
  });

  it("bounds what it collects, and the bounds are exceeded here rather than assumed", () => {
    const manyLeaves = Array.from({ length: MAX_LEAVES_PER_CARD * 3 }, (_, i) => `<p>place ${i}, region ${i}</p>`).join("");
    const big = buildDomFieldMap(page(card("Topcard", `<div><h2>N</h2>${manyLeaves}</div>`)));
    for (const p of big.probes) expect(p.hits.length).toBeLessThanOrEqual(MAX_HITS_PER_PROBE);
    expect(big.nodesWalked).toBeLessThanOrEqual(MAX_LEAVES_PER_CARD + 10);
  });

  it("truncates a long sample rather than putting a whole card on one line", () => {
    const long = "x".repeat(MAX_SAMPLE_CHARS * 3);
    const m = buildDomFieldMap(page(card("Topcard", `<div><h2>N</h2><p>${long}</p></div>`)));
    const hit = m.probes.find((p) => p.name === "headline")!.hits[0]!;
    expect(hit.sample.length).toBeLessThanOrEqual(MAX_SAMPLE_CHARS + 1);
  });
});

describe("renderDomFieldMap", () => {
  it("marks the stranger card so nobody writes a parser against it", () => {
    const md = renderDomFieldMap({
      file: "x-dom-snapshot.html", bytes: 875_285, sourceRun: "01KZJ5N27B",
      map: buildDomFieldMap(LIVE_PAGE),
    });
    expect(md).toContain("holds other people — never read as the subject");
    expect(md).toContain(`urn:li:fsd_profile:${SUBJECT_ID}`);
    expect(md).toContain("San Francisco, California, United States");
  });

  it("refuses the whole document when no subject scope resolved", () => {
    const md = renderDomFieldMap({
      file: "x-dom-snapshot.html", bytes: 10, sourceRun: "r",
      map: buildDomFieldMap("<html><body><p>nothing</p></body></html>"),
    });
    expect(md).toContain("No subject scope could be resolved");
    expect(md).toContain("Do not write a parser");
  });

  it("refuses the document when the card refs name two different people", () => {
    const mixed = page(card("Topcard", TOPCARD_INNER), card("About", "<p>x</p>", STRANGER_ID, "div"));
    const md = renderDomFieldMap({
      file: "x.html", bytes: 1, sourceRun: "r", map: buildDomFieldMap(mixed),
    });
    expect(md).toContain("No subject scope could be resolved");
    expect(md).not.toContain(SUBJECT_ID);
  });

  it("says the id boundary is wrong when the card names come out shifted", () => {
    // Two ids sharing all but the last character: the common prefix stops one
    // character early, so every card name gains that character. The id is wrong
    // by exactly that much, and the names are what makes it visible.
    const near = `${SUBJECT_ID.slice(0, -1)}Z`;
    const mixed = page(card("Topcard", TOPCARD_INNER), card("About", "<p>x</p>", near, "div"));
    const map = buildDomFieldMap(mixed);
    expect(map.scope.unrecognisedCards).toEqual(["ATopcard", "ZAbout"]);

    const md = renderDomFieldMap({ file: "x.html", bytes: 1, sourceRun: "r", map });
    expect(md).toContain("card names are not ones this build has seen");
    expect(md).toContain("Do not key anything on it.");
  });
});
