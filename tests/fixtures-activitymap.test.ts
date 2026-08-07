import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import {
  MAX_TIME_LEAVES,
  MAX_URN_ATTRIBUTES,
  absoluteTimeLeaves,
  buildActivityDomMap,
  renderActivityDomMap,
  urnFamilyOf,
} from "../src/core/fixtures/activitymap.js";
import { buildFieldMap } from "../src/core/fixtures/fieldmap.js";
import { ACTIVITY_PROBES } from "../src/core/fixtures/activity-probes.js";

const SUBJECT = "urn:li:fsd_profile:ACoAAAsubject0000000000";
const STRANGER = "urn:li:fsd_profile:ACoAAAstranger00000000";
const OPERATOR = "urn:li:fsd_profile:ACoAAAoperator00000000";

/**
 * A feed shaped like the one this probe exists to measure: the subject's own
 * post, a stranger's post interleaved (a repost or a "suggested" card), and the
 * operator's own urn sitting in page chrome where it always is (D119).
 *
 * Synthetic on purpose — this is the instrument's test, not LinkedIn's. What it
 * pins is that the instrument *reports what is there*, including the two urns
 * that must never be read as the subject's.
 */
const FEED_HTML = `
<html><body>
  <nav data-owner-urn="${OPERATOR}">me</nav>
  <main id="workspace">
    <div data-urn="urn:li:activity:7000000000000000001">
      <a data-actor-urn="${SUBJECT}">Jane Doe</a>
      <p>We are hiring two engineers.</p>
      <span>3d</span>
      <span>12 reactions</span>
    </div>
    <div data-urn="urn:li:activity:7000000000000000002">
      <a data-actor-urn="${STRANGER}">Someone Else</a>
      <p>A post that is not the subject's.</p>
      <span>2w</span>
    </div>
  </main>
</body></html>`;

describe("buildActivityDomMap — candidate post-card markers", () => {
  it("finds the urn-carrying attributes without being told their names", () => {
    const map = buildActivityDomMap(FEED_HTML);
    const attrs = map.urnAttributes.map((h) => `${h.attribute}=${h.family}`);
    expect(attrs).toContain("data-urn=urn:li:activity");
    expect(attrs).toContain("data-actor-urn=urn:li:fsd_profile");
    // Two post cards carry the activity attribute, two carry an actor.
    expect(map.urnAttributes.find((h) => h.attribute === "data-urn")!.count).toBe(2);
  });

  it("gives a path that resolves back to the element it describes", () => {
    // A path in the map is a test, not prose (M4 CONTEXT rule 4).
    const map = buildActivityDomMap(FEED_HTML);
    const hit = map.urnAttributes.find((h) => h.attribute === "data-urn")!;
    const $ = cheerio.load(FEED_HTML);
    expect($(hit.path).length).toBeGreaterThan(0);
    expect($(hit.path).first().attr("data-urn")).toContain("urn:li:activity:");
  });

  it("counts the operator's own urn as session-owned wherever it sits", () => {
    const map = buildActivityDomMap(FEED_HTML, { sessionUrns: [OPERATOR] });
    const chrome = map.urnAttributes.find((h) => h.attribute === "data-owner-urn")!;
    expect(chrome.sessionHits).toBe(1);
    expect(map.sessionUrnsPresent).toBe(1);
    // The subject and the stranger are not the operator.
    const actors = map.urnAttributes.find((h) => h.attribute === "data-actor-urn")!;
    expect(actors.sessionHits).toBe(0);
  });

  it("counts a stranger's post as its own person urn, not as the subject's", () => {
    // The subject-vs-stranger boundary is the whole game on this surface, and
    // the map's job is to make the interleaving visible rather than resolve it.
    const map = buildActivityDomMap(FEED_HTML, { sessionUrns: [OPERATOR] });
    const people = map.families.find((f) => f.family === "urn:li:fsd_profile")!;
    expect(people.distinct).toBe(3);
  });

  it("never puts a urn id in the map it renders", () => {
    const map = buildActivityDomMap(FEED_HTML, { sessionUrns: [OPERATOR] });
    const rendered = renderActivityDomMap({ file: "f.html", bytes: 10, sourceRun: "R", map });
    for (const urn of [SUBJECT, STRANGER, OPERATOR]) expect(rendered).not.toContain(urn);
    expect(rendered).toContain("urn:li:fsd_profile");
  });
});

describe("buildActivityDomMap — rendered times", () => {
  it("finds the relative times and binds each to the post above it", () => {
    const map = buildActivityDomMap(FEED_HTML);
    const relative = map.timeLeaves.filter((l) => l.shape === "relative");
    expect(relative.map((l) => l.sample)).toEqual(["3d", "2w"]);
    // Bound to the card, which is what makes a timestamp attributable at all.
    expect(relative[0]!.boundTo).toBe("data-urn=urn:li:activity");
  });

  it("reports zero absolute times, which is the finding that forces the decision", () => {
    const map = buildActivityDomMap(FEED_HTML);
    expect(absoluteTimeLeaves(map)).toBe(0);
    const rendered = renderActivityDomMap({ file: "f.html", bytes: 10, sourceRun: "R", map });
    expect(rendered).toContain("Only relative times are rendered");
  });

  it("reports an absolute time when the page does carry one", () => {
    const html = `<html><body><time datetime="x">2026-08-09T12:00:00Z</time></body></html>`;
    const map = buildActivityDomMap(html);
    expect(map.timeLeaves.map((l) => l.shape)).toEqual(["iso-8601"]);
    expect(absoluteTimeLeaves(map)).toBe(1);
    expect(renderActivityDomMap({ file: "f.html", bytes: 1, sourceRun: "R", map }))
      .toContain("need not be derived");
  });

  it("does not read a headline containing a number as a time", () => {
    const html = "<html><body><p>Scaled revenue to 1m ARR</p><p>Founder, 3d printing</p></body></html>";
    expect(buildActivityDomMap(html).timeLeaves).toEqual([]);
  });

  it("reports a time it cannot bind to any post", () => {
    const html = "<html><body><span>3d</span></body></html>";
    const map = buildActivityDomMap(html);
    expect(map.timeLeaves[0]!.boundTo).toBeNull();
    expect(renderActivityDomMap({ file: "f.html", bytes: 1, sourceRun: "R", map }))
      .toContain("_nothing_");
  });
});

describe("buildActivityDomMap — the profile card-ref rule", () => {
  it("reports the card-ref namespace as absent rather than assuming it carries over", () => {
    const map = buildActivityDomMap(FEED_HTML);
    expect(map.scope.profileId).toBeNull();
    expect(renderActivityDomMap({ file: "f.html", bytes: 1, sourceRun: "R", map }))
      .toContain("[DECISION NEEDED]");
  });

  it("reports it as present when the page does carry it", () => {
    const id = "ACoAAAsubject00000000000000000000";
    const ref = "com.linkedin.sdui.profile.card.ref";
    const html =
      `<html><body><main id="workspace">` +
      `<section componentkey="${ref}${id}Topcard">a</section>` +
      `<section componentkey="${ref}${id}About">b</section>` +
      `<section componentkey="${ref}${id}Skills">c</section>` +
      `</main></body></html>`;
    const map = buildActivityDomMap(html);
    expect(map.scope.profileId).toBe(id);
    expect(map.scope.cards.length).toBe(3);
  });
});

describe("buildActivityDomMap — bounds", () => {
  it("bounds the attribute table and says when it bit", () => {
    const over = MAX_URN_ATTRIBUTES + 5;
    const body = Array.from(
      { length: over },
      (_, i) => `<div data-a${i}="urn:li:activity:${i}"></div>`,
    ).join("");
    const map = buildActivityDomMap(`<html><body>${body}</body></html>`);
    expect(map.urnAttributes).toHaveLength(MAX_URN_ATTRIBUTES);
    expect(map.truncated.urnAttributes).toBe(true);
    // The families tally is unbounded by design — it is counts, not rows — so
    // a truncated table never hides that the urns were there.
    expect(map.families.find((f) => f.family === "urn:li:activity")!.distinct).toBe(over);
  });

  it("bounds the time-leaf table and says when it bit", () => {
    const over = MAX_TIME_LEAVES + 5;
    const body = Array.from({ length: over }, () => "<span>3d</span>").join("");
    const map = buildActivityDomMap(`<html><body>${body}</body></html>`);
    expect(map.timeLeaves).toHaveLength(MAX_TIME_LEAVES);
    expect(map.truncated.timeLeaves).toBe(true);
    expect(renderActivityDomMap({ file: "f.html", bytes: 1, sourceRun: "R", map }))
      .toContain("the rest are not listed");
  });

  it("survives html that is not a page at all", () => {
    for (const html of ["", "<", "not html"]) {
      expect(() => buildActivityDomMap(html)).not.toThrow();
    }
  });
});

describe("ACTIVITY_PROBES over a JSON body", () => {
  /** A post envelope in the shape a Voyager body plausibly takes. Synthetic:
   *  what it pins is that the probes find shapes, not that LinkedIn ships this. */
  const BODY = {
    data: {
      elements: [
        {
          entityUrn: "urn:li:activity:7000000000000000001",
          actor: { urn: SUBJECT },
          commentary: { text: "We are hiring." },
          createdAt: Date.UTC(2026, 6, 1),
          socialDetail: { numLikes: 12, numComments: 3 },
        },
      ],
    },
  };

  it("finds the post urn, the author urn and the text", () => {
    const map = buildFieldMap(BODY, ACTIVITY_PROBES);
    const hit = (name: string) => map.probes.find((p) => p.name === name)!;
    expect(hit("post_urn").hits[0]!.template).toBe("$.data.elements[].entityUrn");
    expect(hit("author_urn").hits[0]!.template).toBe("$.data.elements[].actor.urn");
    expect(hit("post_text").hits.map((h) => h.template)).toContain("$.data.elements[].commentary.text");
  });

  it("finds an absolute timestamp that is a number, which a string probe cannot", () => {
    // The gap the `number` probe closed: without it a body full of epoch millis
    // reports as carrying no timestamp at all, and `posted_at` gets derived
    // from the run clock for no reason.
    const map = buildFieldMap(BODY, ACTIVITY_PROBES);
    const epoch = map.probes.find((p) => p.name === "posted_at_epoch")!;
    expect(epoch.hits.map((h) => h.template)).toContain("$.data.elements[].createdAt");
    expect(map.probes.find((p) => p.name === "posted_at_relative")!.hits).toEqual([]);
  });

  it("does not report a 19-digit post id as a timestamp", () => {
    const map = buildFieldMap({ id: 7123456789012345678 }, ACTIVITY_PROBES);
    expect(map.probes.find((p) => p.name === "posted_at_epoch")!.hits).toEqual([]);
  });

  it("reports a relative-only body as exactly that", () => {
    const map = buildFieldMap({ elements: [{ postedAt: "3d" }] }, ACTIVITY_PROBES);
    expect(map.probes.find((p) => p.name === "posted_at_relative")!.hits).toHaveLength(1);
    expect(map.probes.find((p) => p.name === "posted_at_epoch")!.hits).toEqual([]);
    expect(map.probes.find((p) => p.name === "posted_at_iso")!.hits).toEqual([]);
  });

  it("marks an author path that resolves to the session's own identity", () => {
    const map = buildFieldMap(
      { elements: [{ actor: { urn: OPERATOR } }] },
      ACTIVITY_PROBES,
      { selfValues: [OPERATOR] },
    );
    expect(map.probes.find((p) => p.name === "author_urn")!.hits[0]!.self).toBe(true);
  });
});

describe("urnFamilyOf", () => {
  it("drops the id and keeps the family", () => {
    expect(urnFamilyOf("urn:li:activity:7123")).toBe("urn:li:activity");
    expect(urnFamilyOf("urn:li:fsd_profile:ACoAAA")).toBe("urn:li:fsd_profile");
  });
});
