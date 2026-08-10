import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { repoRoot } from "../../core/run/root.js";
import { API_SOURCE, parseReactionsBody } from "./reactions.js";

const URN = "urn:li:activity:7491197577439141888";

/**
 * The body the Ember page fetches and the SDUI page never did (D341). Promoted
 * fixtures are gitignored (D301), so a fresh clone skips rather than throws.
 */
function body(): string | null {
  const path = join(repoRoot(), "fixtures", "post.get", "ember-reactions-body.json");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

const json = body();
const withFixture = json === null ? describe.skip : describe;

if (json === null) {
  console.log("[skip] post.get reactions-body tests — fixtures/post.get/ember-reactions-body.json is absent.");
}

describe("post.get — the reactions body, synthetic contracts", () => {
  it("refuses a body that is not the reactions response at all", () => {
    const r = parseReactionsBody(JSON.stringify({ data: { data: {} } }), { expectedUrn: URN, limit: 10 });
    expect(r.rows).toEqual([]);
    expect(r.total).toBeNull();
    expect(r.warnings.map((w) => w.code)).toContain("REACTIONS_BODY_UNRECOGNIZED");
  });

  it("refuses bytes that are not JSON, rather than throwing", () => {
    const r = parseReactionsBody("<html>not json</html>", { expectedUrn: URN, limit: 10 });
    expect(r.rows).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toContain("REACTIONS_BODY_UNRECOGNIZED");
  });

  it("drops a reaction belonging to another post rather than attributing it", () => {
    const synthetic = JSON.stringify({
      data: { data: { socialDashReactionsByReactionType: { paging: { total: 2 } } } },
      included: [
        {
          $type: "com.linkedin.voyager.dash.social.Reaction",
          actorUrn: "urn:li:fsd_profile:AAA",
          reactionType: "LIKE",
          entityUrn: `urn:li:fsd_reaction:(urn:li:fsd_profile:AAA,${URN},0)`,
          reactorLockup: { title: { text: "Right Post" }, navigationUrl: "https://www.linkedin.com/in/AAA" },
        },
        {
          $type: "com.linkedin.voyager.dash.social.Reaction",
          actorUrn: "urn:li:fsd_profile:BBB",
          reactionType: "LIKE",
          entityUrn: "urn:li:fsd_reaction:(urn:li:fsd_profile:BBB,urn:li:activity:999,0)",
          reactorLockup: { title: { text: "Wrong Post" }, navigationUrl: "https://www.linkedin.com/in/BBB" },
        },
      ],
    });
    const r = parseReactionsBody(synthetic, { expectedUrn: URN, limit: 10 });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.value.actor_name).toBe("Right Post");
    expect(r.warnings.find((w) => w.code === "REACTIONS_FOREIGN_POST")!.n).toBe(1);
  });
});

withFixture("post.get — the reactions body, against the archived response", () => {
  it("reads actor urn and reaction type from labeled fields, and says they are not DOM", () => {
    const r = parseReactionsBody(json!, { expectedUrn: URN, limit: 3 });
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]!.source).toBe(API_SOURCE);
    expect(r.rows[0]!.value.actor_urn).toMatch(/^urn:li:fsd_profile:/);
    expect(r.rows[0]!.value.reaction).toBe("LIKE");
    expect(r.rows[0]!.value.actor_name).toBe("Zumri Hadhi");
  });

  it("takes the authoritative total from paging, not from a rendered label", () => {
    const r = parseReactionsBody(json!, { expectedUrn: URN, limit: 10 });
    expect(r.total).toBe(1052);
  });

  it("carries the reaction types the body actually distinguishes", () => {
    const r = parseReactionsBody(json!, { expectedUrn: URN, limit: 10 });
    expect(r.rows).toHaveLength(10);
    expect(new Set(r.rows.map((x) => x.value.reaction))).toEqual(new Set(["LIKE", "PRAISE"]));
  });

  it("stays bounded by the limit and never walks the pagination token", () => {
    // The body reports 1052 reactions and carries 10. Nothing here may fetch the
    // rest — D313's spending condition, unchanged by the source moving.
    const r = parseReactionsBody(json!, { expectedUrn: URN, limit: 500 });
    expect(r.rows).toHaveLength(10);
    expect(r.total).toBe(1052);
  });

  it("refuses every row when the body is for a different post", () => {
    const r = parseReactionsBody(json!, { expectedUrn: "urn:li:activity:1", limit: 10 });
    expect(r.rows).toEqual([]);
    expect(r.warnings.find((w) => w.code === "REACTIONS_FOREIGN_POST")!.n).toBe(10);
  });
});
