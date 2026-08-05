import { describe, expect, it } from "vitest";
import {
  MAX_DEPTH,
  MAX_NODES,
  MAX_SAMPLE_CHARS,
  MAX_TEMPLATES_PER_PROBE,
  PROFILE_PROBES,
  buildFieldMap,
  renderFieldMap,
} from "../src/core/fixtures/fieldmap.js";
import type { FieldMap } from "../src/core/fixtures/fieldmap.js";

function hits(map: FieldMap, probe: string) {
  return map.probes.find((p) => p.name === probe)!;
}

/** A body shaped the way a modern GraphQL profile response is: an envelope, an
 *  `included` side-list, urns as identity, positions in an array. */
const BODY = {
  data: {
    identityDashProfilesByMemberIdentity: {
      elements: [
        {
          entityUrn: "urn:li:fsd_profile:ACwAAABcDeF",
          firstName: "Jane",
          lastName: "Doe",
          publicIdentifier: "jane-doe",
          headline: "Founder at Acme",
          geoLocation: { defaultLocalizedName: "Karachi, Sindh, Pakistan" },
          profilePositionGroups: {
            elements: [
              {
                companyName: "Acme",
                company: "urn:li:fsd_company:1234",
                title: "Founder",
                dateRange: { start: { year: 2021, month: 3 } },
              },
              {
                companyName: "Globex",
                title: "Engineer",
                dateRange: { start: { year: 2018 }, end: { year: 2021 } },
              },
            ],
          },
        },
      ],
    },
  },
  included: [{ entityUrn: "urn:li:fsd_company:1234", name: "Acme" }],
};

describe("buildFieldMap — finding real paths", () => {
  const map = buildFieldMap(BODY);

  it("finds the person urn by its value, not by a key name", () => {
    const h = hits(map, "person_urn");
    expect(h.hits).toHaveLength(1);
    expect(h.hits[0]!.path).toBe("$.data.identityDashProfilesByMemberIdentity.elements[0].entityUrn");
    expect(h.hits[0]!.sample).toBe("urn:li:fsd_profile:ACwAAABcDeF");
  });

  it("finds name, headline, vanity and location", () => {
    expect(hits(map, "first_name").hits[0]!.sample).toBe("Jane");
    expect(hits(map, "last_name").hits[0]!.sample).toBe("Doe");
    expect(hits(map, "vanity").hits[0]!.sample).toBe("jane-doe");
    expect(hits(map, "headline").hits[0]!.sample).toBe("Founder at Acme");
    expect(hits(map, "location").hits[0]!.path).toBe(
      "$.data.identityDashProfilesByMemberIdentity.elements[0].geoLocation.defaultLocalizedName",
    );
  });

  it("finds the experience container and collapses its repeated members into one template", () => {
    const container = hits(map, "experience");
    expect(container.hits[0]!.path).toBe(
      "$.data.identityDashProfilesByMemberIdentity.elements[0].profilePositionGroups",
    );

    const titles = hits(map, "position_title");
    expect(titles.hits).toHaveLength(1);
    // Two positions, one template, count 2 — the whole point of templating.
    expect(titles.hits[0]!.count).toBe(2);
    expect(titles.hits[0]!.template).toMatch(/profilePositionGroups\.elements\[\]\.title$/);
    // The concrete path is a real, usable path into the body.
    expect(titles.hits[0]!.path).toMatch(/profilePositionGroups\.elements\[0\]\.title$/);
  });

  it("names the graphql envelope so a parser knows where to start", () => {
    const envelope = hits(map, "graphql_envelope");
    expect(envelope.hits.map((h) => h.template)).toContain("$");
  });

  it("reports a probe that matched nothing as an empty hit list, not as absent", () => {
    // A field genuinely missing from the body must be visible as missing — that
    // distinction is the whole of Task 16's drift handling.
    const skills = hits(map, "skills");
    expect(skills.hits).toEqual([]);
    expect(skills.what).toMatch(/skills/i);
  });

  it("describes containers rather than dumping them into the sample", () => {
    expect(hits(map, "experience").hits[0]!.sample).toMatch(/^\{object, keys: elements\}$/);
  });

  it("walks every probe over the same body exactly once", () => {
    expect(map.probes.map((p) => p.name)).toEqual(PROFILE_PROBES.map((p) => p.name));
    expect(map.walkTruncated).toBe(false);
    expect(map.depthTruncated).toBe(false);
  });
});

describe("buildFieldMap — bounds", () => {
  it("stops at MAX_NODES and says so", () => {
    // Exceeding the bound, not assuming it is roomy: a bound nothing has crossed
    // is a guess.
    const wide = { items: Array.from({ length: MAX_NODES + 10 }, (_, i) => ({ firstName: `n${i}` })) };
    const map = buildFieldMap(wide);
    expect(map.walkTruncated).toBe(true);
    expect(map.nodesWalked).toBe(MAX_NODES);
  });

  it("stops descending at MAX_DEPTH and says so", () => {
    let deep: Record<string, unknown> = { firstName: "bottom" };
    for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { nest: deep };
    const map = buildFieldMap(deep);
    expect(map.depthTruncated).toBe(true);
    // The field below the cap is genuinely not reported — the flag is the only
    // thing standing between that and a silently incomplete map.
    expect(hits(map, "first_name").hits).toEqual([]);
  });

  it("caps distinct templates per probe and flags the truncation", () => {
    const body: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TEMPLATES_PER_PROBE + 7; i++) body[`branch${i}`] = { firstName: `n${i}` };
    const map = buildFieldMap(body);
    const h = hits(map, "first_name");
    expect(h.hits).toHaveLength(MAX_TEMPLATES_PER_PROBE);
    expect(h.truncated).toBe(true);
  });

  it("truncates a long sample", () => {
    const map = buildFieldMap({ headline: "x".repeat(MAX_SAMPLE_CHARS + 50) });
    const sample = hits(map, "headline").hits[0]!.sample;
    expect(sample).toHaveLength(MAX_SAMPLE_CHARS + 1); // + the ellipsis
    expect(sample.endsWith("…")).toBe(true);
  });

  it("survives a cyclic object without hanging", () => {
    const a: Record<string, unknown> = { firstName: "Jane" };
    a["self"] = a;
    const map = buildFieldMap(a);
    expect(hits(map, "first_name").hits).toHaveLength(1);
  });

  it("handles a non-object root without throwing", () => {
    expect(buildFieldMap(null).probes.every((p) => p.hits.length === 0)).toBe(true);
    expect(buildFieldMap("urn:li:fsd_profile:X").probes.find((p) => p.name === "person_urn")!.hits)
      .toHaveLength(1);
  });
});

describe("renderFieldMap", () => {
  const rendered = renderFieldMap({
    capability: "profile.get",
    generatedAt: "2026-08-08T10:00:00.000Z",
    fixtures: [
      {
        file: "abc123.json",
        path: "/voyager/api/graphql",
        queryId: "voyagerIdentityDashProfiles.7a",
        status: 200,
        bytes: 4096,
        shapeHash: "abc123",
        sourceRun: "01JRUN",
        map: buildFieldMap(BODY),
      },
    ],
  });

  it("names the file, the endpoint and the operation", () => {
    expect(rendered).toContain("abc123.json");
    expect(rendered).toContain("/voyager/api/graphql");
    expect(rendered).toContain("voyagerIdentityDashProfiles.7a");
    expect(rendered).toContain("01JRUN");
  });

  it("prints real paths a parser can be written against", () => {
    expect(rendered).toContain("$.data.identityDashProfilesByMemberIdentity.elements[0].entityUrn");
    expect(rendered).toContain("profilePositionGroups.elements[].title");
  });

  it("lists what was not found, so a gap is visible instead of implied", () => {
    expect(rendered).toMatch(/\*\*Not found in this body:\*\*.*`skills`/);
  });

  it("escapes a pipe so one sample cannot break the whole table", () => {
    const withPipe = renderFieldMap({
      capability: "profile.get",
      generatedAt: "2026-08-08T10:00:00.000Z",
      fixtures: [
        {
          file: "f.json", path: "/p", queryId: null, status: 200, bytes: 1,
          shapeHash: "f", sourceRun: "r", map: buildFieldMap({ headline: "a | b" }),
        },
      ],
    });
    expect(withPipe).toContain("a \\| b");
  });

  it("carries the truncation warning through to the document", () => {
    const truncated = renderFieldMap({
      capability: "profile.get",
      generatedAt: "2026-08-08T10:00:00.000Z",
      fixtures: [
        {
          file: "f.json", path: "/p", queryId: null, status: 200, bytes: 1,
          shapeHash: "f", sourceRun: "r",
          map: { probes: [], nodesWalked: MAX_NODES, walkTruncated: true, depthTruncated: false },
        },
      ],
    });
    expect(truncated).toMatch(/This map is partial/);
  });

  it("says why a body has no map instead of leaving an empty section", () => {
    const noMap = renderFieldMap({
      capability: "profile.get",
      generatedAt: "2026-08-08T10:00:00.000Z",
      fixtures: [
        {
          file: "f.json", path: "/p", queryId: null, status: 200, bytes: 1,
          shapeHash: "f", sourceRun: "r", map: null, note: "body is not valid JSON",
        },
      ],
    });
    expect(noMap).toContain("body is not valid JSON");
  });
});
