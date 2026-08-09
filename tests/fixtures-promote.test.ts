import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RawArchive } from "../src/core/archive/raw.js";
import { promoteFixtures } from "../src/core/fixtures/promote.js";
import type { FixtureIndex } from "../src/core/fixtures/promote.js";
import { CapabilityError } from "../src/core/run/receipt.js";
import { isActivityIsh } from "../src/capabilities/activity.capture/patterns.js";
import { ACTIVITY_PROBES } from "../src/core/fixtures/activity-probes.js";
import { domMapOf, renderDomMapOf } from "../src/core/fixtures/families.js";

/** The activity surface's DOM-map pair, as `promote-fixtures.ts` supplies it. */
const ACTIVITY_DOM_MAPPER = {
  build: (html: string) => domMapOf("activity", html),
  render: (o: { file: string; bytes: number; sourceRun: string; map: unknown }) =>
    renderDomMapOf("activity", o),
};

const PROFILE_BODY = JSON.stringify({
  data: { elements: [{ entityUrn: "urn:li:fsd_profile:ACwAAA", firstName: "Jane", headline: "Founder" }] },
});
/** Same structure, different data — one shape, so one fixture. */
const PROFILE_BODY_2 = JSON.stringify({
  data: { elements: [{ entityUrn: "urn:li:fsd_profile:ACwAAB", firstName: "John", headline: "Engineer" }] },
});
const COMPANY_BODY = JSON.stringify({ data: { company: { entityUrn: "urn:li:fsd_company:1" } } });

let root: string;
let archiveDir: string;
let fixturesDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "promote-"));
  archiveDir = join(root, "raw");
  fixturesDir = join(root, "fixtures", "profile.get");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function seed(bodies: Array<{ body: string; url: string; status?: number }>): Promise<RawArchive> {
  const archive = new RawArchive(archiveDir);
  for (const b of bodies) {
    await archive.archive({ body: b.body, url: b.url, status: b.status ?? 200 });
  }
  return archive;
}

const GQL = "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a&variables=(vanityName:jane-doe)";

function run(extra: Partial<Parameters<typeof promoteFixtures>[0]> = {}) {
  return promoteFixtures({
    archiveDir,
    fixturesDir,
    capability: "profile.get",
    sourceRun: "01JRUN",
    now: () => new Date("2026-08-08T10:00:00.000Z"),
    ...extra,
  });
}

describe("promoteFixtures", () => {
  it("promotes a profile body and writes the field map beside it", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const result = await run();

    expect(result.promoted).toHaveLength(1);
    const fixture = result.promoted[0]!;
    expect(fixture.file).toMatch(/^[0-9a-f]+\.json$/);
    expect(fixture.source_run).toBe("01JRUN");
    expect(fixture.query_id).toBe("voyagerIdentityDashProfiles.7a");
    expect(fixture.path).toBe("/voyager/api/graphql");

    // Byte-identical to what LinkedIn sent — a reformatted fixture proves a
    // parser against something that never came off the wire.
    expect(readFileSync(join(fixturesDir, fixture.file), "utf8")).toBe(PROFILE_BODY);

    const map = readFileSync(result.fieldMapPath, "utf8");
    expect(map).toContain("$.data.elements[0].entityUrn");
    expect(map).toContain("$.data.elements[].firstName");
  });

  it("keeps the query string out of the index", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const result = await run();
    const index = JSON.parse(readFileSync(result.indexPath, "utf8")) as FixtureIndex;
    expect(JSON.stringify(index)).not.toContain("jane-doe");
  });

  it("deduplicates by shape, not by bytes", async () => {
    await seed([
      { body: PROFILE_BODY, url: GQL },
      { body: PROFILE_BODY_2, url: GQL },
    ]);
    const result = await run();
    expect(result.promoted).toHaveLength(1);
    expect(result.skipped.duplicate_shape).toBe(1);
  });

  it("is idempotent — a second promotion over the same archive adds nothing", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const first = await run();
    const second = await run();
    expect(second.promoted).toHaveLength(0);
    expect(second.total).toBe(1);
    expect(second.skipped.duplicate_shape).toBe(1);
    expect(readFileSync(second.fieldMapPath, "utf8")).toContain(first.promoted[0]!.file);
  });

  it("keeps an earlier run's fixtures in the regenerated field map", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const first = await run();

    // A second run, a different archive, a different shape.
    const secondArchive = join(root, "raw2");
    await new RawArchive(secondArchive).archive({
      body: JSON.stringify({ included: [{ entityUrn: "urn:li:fsd_profile:X", lastName: "Doe" }] }),
      url: "https://www.linkedin.com/voyager/api/identity/dash/profiles",
      status: 200,
    });
    const second = await run({ archiveDir: secondArchive, sourceRun: "01JRUN2" });

    expect(second.promoted).toHaveLength(1);
    expect(second.total).toBe(2);
    const map = readFileSync(second.fieldMapPath, "utf8");
    expect(map).toContain(first.promoted[0]!.file);
    expect(map).toContain(second.promoted[0]!.file);
    expect(map).toContain("01JRUN2");
  });

  it("skips bodies that carry no person data unless asked for all of them", async () => {
    await seed([
      { body: PROFILE_BODY, url: GQL },
      { body: COMPANY_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=company.1" },
    ]);
    const selective = await run();
    expect(selective.promoted).toHaveLength(1);
    expect(selective.skipped.not_profile).toBe(1);

    const everything = await run({ fixturesDir: join(root, "all"), all: true });
    expect(everything.promoted).toHaveLength(2);
    expect(everything.promoted.map((f) => f.profile_ish).sort()).toEqual([false, true]);
  });

  it("skips a non-JSON body and counts it", async () => {
    await seed([
      { body: "<html>we are sorry</html>", url: "https://www.linkedin.com/voyager/api/graphql" },
      { body: PROFILE_BODY, url: GQL },
    ]);
    const result = await run();
    expect(result.skipped.not_json).toBe(1);
    expect(result.promoted).toHaveLength(1);
  });

  it("names an unreadable archive entry instead of dropping it silently", async () => {
    // A body file that is not valid gzip: the archive classifies it ARCHIVE_CORRUPT,
    // and promotion must report that rather than produce a quietly short fixture set.
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const corrupt = join(archiveDir, "0009-deadbeef.json.gz");
    writeFileSync(corrupt, "not gzip at all");

    const result = await run();
    expect(result.promoted).toHaveLength(1);
    expect(result.skipped.unreadable).toBe(1);
    // The code comes from the layer that decided it — not re-classified here (D17).
    expect(result.unreadable).toEqual([{ file: "0009-deadbeef.json.gz", code: "ARCHIVE_CORRUPT" }]);
  });

  it("returns an empty result for an archive that does not exist", async () => {
    const result = await run({ archiveDir: join(root, "nothing-here") });
    expect(result.promoted).toEqual([]);
    expect(result.total).toBe(0);
    expect(existsSync(result.fieldMapPath)).toBe(true);
  });

  // Every one of these is the first live capture's actual failure: 9 fixtures
  // promoted, none of them the subject, 339KB of the operator's own inbox among
  // them, and a field map whose `person_urn` was the operator's own member id.
  describe("relevance (D118)", () => {
    const MESSAGES = JSON.stringify({
      data: { conversations: [{ participant: "urn:li:fsd_profile:ACwAAOTHER", body: "hi" }] },
    });
    const MESSAGING_URL =
      "https://www.linkedin.com/voyager/api/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.0d";
    const SUBJECT_BODY = JSON.stringify({
      data: { profile: { publicIdentifier: "jane-doe", entityUrn: "urn:li:fsd_profile:ACwAAJANE" } },
    });
    const OTHER_BODY = JSON.stringify({
      data: { profile: { publicIdentifier: "someone-else", entityUrn: "urn:li:fsd_profile:ACwAAOTHER" } },
    });

    it("never promotes a private endpoint, and --all does not reach it", async () => {
      await seed([{ body: MESSAGES, url: MESSAGING_URL }]);
      const result = await run({ all: true });

      expect(result.promoted).toHaveLength(0);
      expect(result.skipped.private_endpoint).toBe(1);
      expect(existsSync(join(fixturesDir, "index.json"))).toBe(true);
    });

    it("excludes notification cards and nav chrome the same way", async () => {
      await seed([
        { body: PROFILE_BODY, url: "https://www.linkedin.com/voyager/api/voyagerIdentityDashNotificationCards" },
        { body: PROFILE_BODY_2, url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashGlobalNavs.5e" },
      ]);
      const result = await run({ all: true });

      expect(result.promoted).toHaveLength(0);
      expect(result.skipped.private_endpoint).toBe(2);
    });

    it("promotes the subject's body and skips another person's", async () => {
      await seed([
        { body: SUBJECT_BODY, url: GQL },
        { body: OTHER_BODY, url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7b" },
      ]);
      const result = await run({ subject: { vanity: "jane-doe" } });

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.subject_match).toBe(true);
      expect(result.skipped.not_subject).toBe(1);
    });

    it("matches the subject by urn as well as by vanity", async () => {
      await seed([{ body: SUBJECT_BODY, url: GQL }]);
      const result = await run({ subject: { urns: ["urn:li:fsd_profile:ACwAAJANE"] } });

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.subject_match).toBe(true);
    });

    it("a stranger's body cannot claim the shape slot the subject's body needs", async () => {
      // Same shape, arriving first. Deduping before the subject check would
      // promote this one and skip the subject's as a duplicate.
      await seed([
        { body: OTHER_BODY, url: GQL },
        { body: SUBJECT_BODY, url: GQL },
      ]);
      const result = await run({ subject: { vanity: "jane-doe" } });

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]!.subject_match).toBe(true);
      expect(JSON.parse(readFileSync(join(fixturesDir, result.promoted[0]!.file), "utf8"))).toEqual(
        JSON.parse(SUBJECT_BODY),
      );
    });

    it("without a subject, falls back to the old any-person heuristic", async () => {
      await seed([{ body: OTHER_BODY, url: GQL }]);
      const result = await run();

      expect(result.promoted).toHaveLength(1);
      expect(result.skipped.not_subject).toBe(0);
    });
  });

  it("refuses to run against a corrupt index rather than re-promoting everything", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    await run();
    writeFileSync(join(fixturesDir, "index.json"), "{ this is not json");

    await expect(run()).rejects.toMatchObject({ code: "FIXTURE_PROMOTE_FAILED" });
    await expect(run()).rejects.toBeInstanceOf(CapabilityError);
  });

  it("fails loudly when the fixtures directory cannot be written", async () => {
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    const readOnly = join(root, "read-only");
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
    try {
      await expect(
        promoteFixtures({
          archiveDir,
          fixturesDir: join(readOnly, "profile.get"),
          capability: "profile.get",
          sourceRun: "r",
        }),
      ).rejects.toMatchObject({ code: "FIXTURE_PROMOTE_FAILED", exit: 1, retryable: false });
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/** A minimal snapshot with the structure the live page actually has: SDUI card
 *  refs namespaced by one profile id, and a sidebar of other people. */
const SUBJECT_ID = "ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA";
const REF = `com.linkedin.sdui.profile.card.ref${SUBJECT_ID}`;
const SNAPSHOT_HTML =
  `<html><body><main id="workspace">` +
  `<section componentkey="${REF}Topcard"><div><h2>Jane Doe</h2>` +
  `<p>· 1st</p><p>Founder at Example</p><p>Example · MIT</p>` +
  `<div><p>Boston, Massachusetts, United States</p></div></div></section>` +
  `<div componentkey="${REF}ExperienceTopLevelSection"><p>Founder</p></div>` +
  `<div componentkey="${REF}SuggestedForYou"><aside>strangers</aside></div>` +
  `<div componentkey="com.linkedin.sdui.profile.card.refjane-doeActivity">a</div>` +
  `</main></body></html>`;

async function seedSnapshot(html = SNAPSHOT_HTML): Promise<void> {
  await new RawArchive(archiveDir).archive({
    body: html,
    url: "dom-snapshot:https://www.linkedin.com/in/jane-doe/",
    status: 0,
    method: "DOM",
    pattern: "dom-snapshot",
    contentType: "text/html; charset=utf-8",
  });
}

describe("promoteFixtures — the DOM snapshot (D123)", () => {
  it("promotes the snapshot as html, byte for byte, and marks it", async () => {
    await seedSnapshot();
    const result = await run({ subject: { vanity: "jane-doe" } });

    expect(result.promoted).toHaveLength(1);
    const entry = result.promoted[0]!;
    expect(entry.dom_snapshot).toBe(true);
    expect(entry.file.endsWith("-dom-snapshot.html")).toBe(true);
    expect(entry.subject_match).toBe(true);
    expect(readFileSync(join(fixturesDir, entry.file), "utf8")).toBe(SNAPSHOT_HTML);
    // It is html, so it must not have been rejected as "not JSON".
    expect(result.skipped.not_json).toBe(0);
  });

  it("gives the snapshot the DOM field map, at the top of the document", async () => {
    await seedSnapshot();
    await run({ subject: { vanity: "jane-doe" } });
    const md = readFileSync(join(fixturesDir, "FIELD-MAP.md"), "utf8");

    expect(md).toContain("rendered DOM snapshot");
    expect(md).toContain(`urn:li:fsd_profile:${SUBJECT_ID}`);
    expect(md).toContain("Founder at Example");
    expect(md).toContain("Boston, Massachusetts, United States");
    expect(md).toContain("holds other people — never read as the subject");
  });

  it("promotes a structured initial document separately from the DOM snapshot", async () => {
    // Both are non-JSON, so both hash to the same NON_JSON_SHAPE. Sharing one
    // dedupe set would let whichever landed first claim the slot — the D118
    // mistake, one layer on.
    await new RawArchive(archiveDir).archive({
      body: '<html>jane-doe<code id="bpr-guid-1">{&quot;included&quot;:[{&quot;entityUrn&quot;:&quot;urn:li:fsd_company:42&quot;,&quot;title&quot;:&quot;Engineer&quot;}]}</code></html>',
      url: "https://www.linkedin.com/in/jane-doe/",
      status: 200,
    });
    await seedSnapshot();
    const result = await run({ subject: { vanity: "jane-doe" }, all: true });

    const snapshots = result.promoted.filter((f) => f.dom_snapshot === true);
    const documents = result.promoted.filter((f) => f.embedded_document === true);
    expect(snapshots).toHaveLength(1);
    expect(documents).toHaveLength(1);
    expect(documents[0]!.file).toMatch(/-document\.html$/);
    expect(readFileSync(result.fieldMapPath, "utf8")).toContain("$.islands[].value.included[].title");
    expect(result.skipped.duplicate_shape).toBe(0);
  });

  it("refuses a snapshot that does not name the subject, and counts it apart", async () => {
    // There is at most one snapshot per run, so losing it means the run produced
    // no content fixture at all — that must not read as an ordinary skip.
    await seedSnapshot(SNAPSHOT_HTML.replace(/jane-doe/g, "someone-else"));
    const result = await run({ subject: { vanity: "jane-doe" } });
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped.snapshot_not_subject).toBe(1);
    expect(result.skipped.not_subject).toBe(0);
  });

  it("is idempotent — a second promotion adds nothing", async () => {
    await seedSnapshot();
    await run({ subject: { vanity: "jane-doe" } });
    const second = await run({ subject: { vanity: "jane-doe" } });
    expect(second.promoted).toHaveLength(0);
    expect(second.skipped.duplicate_shape).toBe(1);
    expect(second.total).toBe(1);
  });

  it("keeps the snapshot's field map when a later run promotes a json body", async () => {
    // The map is regenerated over the whole index; the snapshot section must
    // not drop out when something else is added.
    await seedSnapshot();
    await run({ subject: { vanity: "jane-doe" } });
    await seed([{ body: PROFILE_BODY, url: GQL }]);
    await run({ subject: { vanity: "jane-doe" } });

    const md = readFileSync(join(fixturesDir, "FIELD-MAP.md"), "utf8");
    expect(md).toContain("rendered DOM snapshot");
    expect(md).toContain(`urn:li:fsd_profile:${SUBJECT_ID}`);
  });
});

describe("promoteFixtures — the activity surface (D226)", () => {
  const ACTIVITY_GQL =
    "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashProfileUpdates.3a";
  const ACTIVITY_BODY = JSON.stringify({
    data: {
      elements: [{
        entityUrn: "urn:li:activity:7000000000000000001",
        actor: { urn: "urn:li:fsd_profile:ACwAAA" },
        commentary: { text: "jane-doe is hiring" },
        createdAt: Date.UTC(2026, 6, 1),
      }],
    },
  });
  /** Activity data that names no person at all. Under the profile relevance
   *  rule this body is dropped, and it is exactly the body a post parser needs. */
  const COUNTS_BODY = JSON.stringify({
    data: { socialDetail: { numLikes: 12, numComments: 3, urn: "urn:li:activity:7000000000000000001" } },
  });

  async function seedActivitySnapshot(html: string): Promise<void> {
    await new RawArchive(archiveDir).archive({
      body: html,
      url: "dom-snapshot:https://www.linkedin.com/in/jane-doe/recent-activity/all/",
      status: 0,
      method: "DOM",
      pattern: "dom-snapshot",
      contentType: "text/html; charset=utf-8",
    });
  }

  it("promotes a body that carries posts and no person urn", async () => {
    await seed([{ body: COUNTS_BODY, url: ACTIVITY_GQL }]);
    const result = await run({
      isRelevant: isActivityIsh,
      probes: ACTIVITY_PROBES,
      domMapper: ACTIVITY_DOM_MAPPER,
    });
    expect(result.promoted).toHaveLength(1);
    expect(result.skipped.not_profile).toBe(0);
  });

  it("drops that same body under the profile rule, which is why the flag exists", async () => {
    await seed([{ body: COUNTS_BODY, url: ACTIVITY_GQL }]);
    const result = await run();
    expect(result.promoted).toHaveLength(0);
    expect(result.skipped.not_profile).toBe(1);
  });

  it("runs the activity probes over the promoted body", async () => {
    await seed([{ body: ACTIVITY_BODY, url: ACTIVITY_GQL }]);
    await run({ isRelevant: isActivityIsh, probes: ACTIVITY_PROBES, subject: { vanity: "jane-doe" } });
    const md = readFileSync(join(fixturesDir, "FIELD-MAP.md"), "utf8");

    expect(md).toContain("post_urn");
    expect(md).toContain("$.data.elements[].entityUrn");
    // The absolute timestamp, found because the probe can match a number.
    expect(md).toContain("posted_at_epoch");
    expect(md).toContain("$.data.elements[].createdAt");
  });

  it("gives the snapshot the activity DOM map instead of the profile one", async () => {
    const html =
      `<html><body><main id="workspace">` +
      `<div data-urn="urn:li:activity:7000000000000000001"><p>jane-doe</p><span>3d</span></div>` +
      `</main></body></html>`;
    await seedActivitySnapshot(html);
    await run({
      isRelevant: isActivityIsh,
      probes: ACTIVITY_PROBES,
      domMapper: ACTIVITY_DOM_MAPPER,
      subject: { vanity: "jane-doe" },
    });
    const md = readFileSync(join(fixturesDir, "FIELD-MAP.md"), "utf8");

    expect(md).toContain("rendered DOM snapshot (activity surface)");
    expect(md).toContain("candidate post-card markers");
    expect(md).toContain("data-urn");
    expect(md).toContain("Only relative times are rendered");
    // The profile map's sections must not appear: it would report "no subject
    // scope" on a page that was never supposed to have one.
    expect(md).not.toContain("### Subject scope\n");
  });

  it("marks a path that resolves to the session's own identity, on this surface too", async () => {
    const operator = "urn:li:fsd_profile:ACoAAAoperator";
    await seed([{
      body: JSON.stringify({ elements: [{ urn: "urn:li:activity:1", actor: { urn: operator } }] }),
      url: ACTIVITY_GQL,
    }]);
    await run({ isRelevant: isActivityIsh, probes: ACTIVITY_PROBES, sessionUrns: [operator] });
    const md = readFileSync(join(fixturesDir, "FIELD-MAP.md"), "utf8");
    // The author path here is the operator's own. A parser written against it
    // scores green offline and returns this account for every prospect (D119).
    const authorSection = md.slice(md.indexOf("### author_urn"));
    expect(authorSection).toContain("session's own identity");
  });
});
