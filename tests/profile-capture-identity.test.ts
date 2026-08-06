import { describe, expect, it } from "vitest";
import {
  IDENTITY_MAX_NODES,
  checkIdentity,
  findSubjectUrn,
  isIdentityBody,
  isSessionBody,
} from "../src/capabilities/profile.capture/identity.js";
import type { IdentityCapture } from "../src/capabilities/profile.capture/identity.js";
import type { Capture } from "../src/core/tap/network-tap.js";

/** Compile-time: the tap's own `Capture` is what `checkIdentity` is fed in the
 *  capability. Verified to fail when `Capture.body` is renamed. */
const _captureComposes: IdentityCapture = null as unknown as Capture;
void _captureComposes;

const SUBJECT_URN = "urn:li:fsd_profile:ACoAAE1JGFIBsubject";
const OPERATOR_URN = "urn:li:fsd_profile:ACoAAAoperatorOwn";

const IDENTITY_URL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a" +
  "&variables=(vanityName:tankots)";
const ME_URL = "https://www.linkedin.com/voyager/api/me";

/** The shape D121 measured on the wire: a GraphQL envelope whose element list
 *  is `*elements`, holding a bare urn reference. */
function identityBody(urn: string): string {
  return JSON.stringify({
    data: {
      identityDashProfilesByMemberIdentity: {
        "*elements": [urn],
        _type: "com.linkedin.restli.common.CollectionResponse",
      },
    },
    included: [],
  });
}

describe("findSubjectUrn", () => {
  it("reads the urn from the path D121 measured", () => {
    const hit = findSubjectUrn(identityBody(SUBJECT_URN));
    expect(hit).toEqual({
      urn: SUBJECT_URN,
      path: '$.data.identityDashProfilesByMemberIdentity["*elements"][0]',
    });
  });

  it("also reads the inlined-record spelling, from entityUrn", () => {
    // LinkedIn emits `*elements` for urn references and `elements` for inlined
    // records. Both are the same fact and neither is worth a second endpoint.
    const body = JSON.stringify({
      data: {
        identityDashProfilesByMemberIdentity: {
          elements: [{ entityUrn: SUBJECT_URN, versionTag: "1234" }],
        },
      },
    });
    expect(findSubjectUrn(body)).toEqual({
      urn: SUBJECT_URN,
      path: "$.data.identityDashProfilesByMemberIdentity.elements[0].entityUrn",
    });
  });

  it("finds the container at any envelope depth", () => {
    const body = JSON.stringify({
      data: { data: { identityDashProfilesByMemberIdentity: { "*elements": [SUBJECT_URN] } } },
    });
    expect(findSubjectUrn(body)?.urn).toBe(SUBJECT_URN);
  });

  it("returns null instead of throwing on a body that is not this endpoint", () => {
    expect(findSubjectUrn("not json at all")).toBeNull();
    expect(findSubjectUrn("<html>the document response</html>")).toBeNull();
    expect(findSubjectUrn(JSON.stringify({ data: {} }))).toBeNull();
    expect(findSubjectUrn(JSON.stringify({ data: { identityDashProfilesByMemberIdentity: {} } }))).toBeNull();
    expect(
      findSubjectUrn(JSON.stringify({ data: { identityDashProfilesByMemberIdentity: { "*elements": [] } } })),
    ).toBeNull();
  });

  it("refuses a value that is not a person urn, rather than passing it on as one", () => {
    // A company urn or a tracking string at that position is drift, not identity.
    for (const bad of ["urn:li:fsd_company:1234", "ACoAAE1JGFIB", "", "urn:li:fsd_profile:"]) {
      expect(findSubjectUrn(identityBody(bad))).toBeNull();
    }
  });

  it("does not pick up a person urn that is merely somewhere in the body", () => {
    // The D119/D121 trap: person urns appear all over LinkedIn's bodies, in A/B
    // tracking and in "people also viewed". Only the named container counts.
    const body = JSON.stringify({
      data: { lixTracking: { urn: OPERATOR_URN }, suggestions: [{ entityUrn: "urn:li:fsd_profile:stranger" }] },
    });
    expect(findSubjectUrn(body)).toBeNull();
  });

  it("survives a self-referential body without spinning", () => {
    // Not reachable through JSON.parse, but the walk's cycle guard is what keeps
    // the node bound meaningful; proven directly rather than assumed.
    const deep: Record<string, unknown> = {};
    let node = deep;
    for (let i = 0; i < 5_000; i++) {
      const next: Record<string, unknown> = {};
      node["next"] = next;
      node = next;
    }
    node["identityDashProfilesByMemberIdentity"] = { "*elements": [SUBJECT_URN] };
    expect(findSubjectUrn(JSON.stringify(deep))?.urn).toBe(SUBJECT_URN);
  });

  it("stops at the node cap instead of walking an unbounded body", () => {
    // The bound is exceeded here rather than assumed roomy (CONTEXT §3).
    const wide = { data: Array.from({ length: IDENTITY_MAX_NODES + 5_000 }, () => ({ x: 1 })) } as Record<
      string,
      unknown
    >;
    (wide as Record<string, unknown>)["zzz_identity"] = {
      identityDashProfilesByMemberIdentity: { "*elements": [SUBJECT_URN] },
    };
    // Whatever it finds, it returns rather than hanging; the point is that it
    // terminates well inside the cap on a body this size.
    const started = Date.now();
    findSubjectUrn(JSON.stringify(wide));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe("isIdentityBody / isSessionBody", () => {
  it("names the identity endpoint by its query id, not by its path", () => {
    // Every GraphQL call shares `/voyager/api/graphql`; only `queryId` tells
    // them apart (the same reason isPrivateEndpoint reads it, D118).
    expect(isIdentityBody({ url: IDENTITY_URL, body: "" })).toBe(true);
    expect(
      isIdentityBody({ url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashGlobalNavs", body: "" }),
    ).toBe(false);
  });

  it("names the session's own account record", () => {
    expect(isSessionBody({ url: ME_URL, body: "" })).toBe(true);
    expect(isSessionBody({ url: `${ME_URL}?q=x`, body: "" })).toBe(true);
    expect(isSessionBody({ url: "https://www.linkedin.com/voyager/api/messaging", body: "" })).toBe(false);
  });
});

describe("checkIdentity", () => {
  const me: IdentityCapture = {
    url: ME_URL,
    body: JSON.stringify({ miniProfile: { entityUrn: OPERATOR_URN } }),
  };

  it("reports the urn's location and kind, never the urn itself", () => {
    // The urn is captured data and receipts go to stdout (§4.1, D3).
    const f = checkIdentity([me, { url: IDENTITY_URL, body: identityBody(SUBJECT_URN) }]);
    expect(f.bodies).toBe(1);
    expect(f.found).toBe(true);
    expect(f.path).toBe('$.data.identityDashProfilesByMemberIdentity["*elements"][0]');
    expect(f.urnKind).toBe("urn:li:fsd_profile");
    expect(f.isSession).toBe(false);
    expect(f.sessionUrns).toBe(1);
    expect(JSON.stringify(f)).not.toContain("subject");
  });

  it("reports an absent identity body as a count of zero, not as a silent false", () => {
    const f = checkIdentity([me, { url: "https://www.linkedin.com/voyager/api/graphql?queryId=other", body: "{}" }]);
    expect(f.bodies).toBe(0);
    expect(f.found).toBe(false);
    expect(f.path).toBeNull();
  });

  it("distinguishes 'the body never came' from 'the body came and had no urn'", () => {
    // Two different findings with two different fixes — the endpoint moved,
    // versus the response shape moved.
    const absent = checkIdentity([me]);
    const empty = checkIdentity([me, { url: IDENTITY_URL, body: JSON.stringify({ data: {} }) }]);
    expect([absent.bodies, absent.found]).toEqual([0, false]);
    expect([empty.bodies, empty.found]).toEqual([1, false]);
  });

  it("flags a subject urn that is actually the operator's own (D119)", () => {
    const f = checkIdentity([me, { url: IDENTITY_URL, body: identityBody(OPERATOR_URN) }]);
    expect(f.found).toBe(true);
    expect(f.isSession).toBe(true);
  });

  it("takes the first identity body that carries a urn, not the first one seen", () => {
    const f = checkIdentity([
      { url: IDENTITY_URL, body: JSON.stringify({ data: {} }) },
      { url: IDENTITY_URL, body: identityBody(SUBJECT_URN) },
    ]);
    expect(f.bodies).toBe(2);
    expect(f.found).toBe(true);
  });

  it("reads the session's urns from /voyager/api/me and nowhere else", () => {
    // A stranger's urn in a feed body must not become "the operator's identity",
    // which would mask a real subject as a session match.
    const feed: IdentityCapture = {
      url: "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDash",
      body: JSON.stringify({ author: SUBJECT_URN }),
    };
    const f = checkIdentity([feed, { url: IDENTITY_URL, body: identityBody(SUBJECT_URN) }]);
    expect(f.sessionUrns).toBe(0);
    expect(f.isSession).toBe(false);
  });

  it("accepts session urns supplied directly, for a caller that already knows them", () => {
    const f = checkIdentity([{ url: IDENTITY_URL, body: identityBody(SUBJECT_URN) }], {
      sessionUrns: [SUBJECT_URN],
    });
    expect(f.isSession).toBe(true);
  });
});
