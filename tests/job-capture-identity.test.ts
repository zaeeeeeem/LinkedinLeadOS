import { describe, expect, it } from "vitest";
import { checkJobIdentity, companyUrnsIn, namesJob } from "../src/capabilities/job.capture/identity.js";
import { sessionUrnsOf } from "../src/capabilities/profile.capture/identity.js";
import { normalizeJobUrl } from "../src/capabilities/job.capture/url.js";
import type { IdentityCapture } from "../src/capabilities/profile.capture/identity.js";

const TARGET = normalizeJobUrl("https://www.linkedin.com/jobs/view/4012345678/");
const OTHER_JOB = "urn:li:fsd_jobPosting:9999999999";
const OPERATOR = "urn:li:fsd_profile:ACoAAAOperator0000";
const RECRUITER = "urn:li:fsd_profile:ACoAAARecruiter000";

/** The `/voyager/api/me` body every LinkedIn page fetches on its own — the one
 *  source of the session's own identity (D119). */
const ME = {
  url: "https://www.linkedin.com/voyager/api/me",
  body: JSON.stringify({ miniProfile: { entityUrn: OPERATOR } }),
};

function body(o: Record<string, unknown>): string {
  return JSON.stringify(o);
}

describe("namesJob and companyUrnsIn", () => {
  it("recognizes the posting by urn and by bare id", () => {
    expect(namesJob(body({ entityUrn: TARGET.urn }), TARGET)).toBe(true);
    expect(namesJob(body({ url: "/jobs/view/4012345678/" }), TARGET)).toBe(true);
    expect(namesJob(body({ entityUrn: OTHER_JOB }), TARGET)).toBe(false);
  });

  it("finds every company urn spelling, deduped", () => {
    const found = companyUrnsIn(
      body({ a: "urn:li:fsd_company:1234", b: "urn:li:fsd_company:1234", c: "urn:li:company:99" }),
    );
    expect(found).toHaveLength(2);
  });
});

describe("checkJobIdentity scopes the company sweep to the posting", () => {
  it("resolves one company when only the posting's own body carries one", () => {
    const captures: IdentityCapture[] = [
      ME,
      { url: "https://www.linkedin.com/voyager/api/graphql?queryId=jobs", body: body({ entityUrn: TARGET.urn, company: "urn:li:fsd_company:1234" }) },
      // "Similar jobs" — other companies, other postings. Out of scope, and this
      // is the whole reason the sweep is scoped (D118/D121, one surface along).
      { url: "https://www.linkedin.com/voyager/api/graphql?queryId=similar", body: body({ entityUrn: OTHER_JOB, company: "urn:li:fsd_company:5678" }) },
    ];
    const finding = checkJobIdentity({ captures, target: TARGET, snapshotHtml: null });

    expect(finding.subjectBodies).toBe(1);
    expect(finding.companyCandidates).toBe(1);
    expect(finding.companyResolved).toBe(true);
    // The family, never the id: receipts go to stdout (§4.1, D3).
    expect(finding.companyUrnKind).toBe("urn:li:fsd_company");
  });

  it("resolves nothing when two employers are candidates", () => {
    const captures: IdentityCapture[] = [
      ME,
      { url: "https://www.linkedin.com/voyager/api/graphql", body: body({ entityUrn: TARGET.urn, a: "urn:li:fsd_company:1234", b: "urn:li:fsd_company:5678" }) },
    ];
    const finding = checkJobIdentity({ captures, target: TARGET, snapshotHtml: null });
    expect(finding.companyCandidates).toBe(2);
    expect(finding.companyResolved).toBe(false);
    expect(finding.companyUrnKind).toBeNull();
  });

  it("splits the operator's own urns from real people on the posting", () => {
    // The operator's identity is on every page (D119). Counting it as a person
    // on the posting is how a recruiter count becomes a lie.
    const captures: IdentityCapture[] = [
      ME,
      { url: "https://www.linkedin.com/voyager/api/graphql", body: body({ entityUrn: TARGET.urn, viewer: OPERATOR, poster: RECRUITER }) },
    ];
    const finding = checkJobIdentity({
      captures, target: TARGET, snapshotHtml: null, sessionUrns: sessionUrnsOf(captures),
    });
    expect(finding.sessionUrns).toBe(1);
    expect(finding.personUrns).toBe(2);
    expect(finding.personUrnsThatAreSession).toBe(1);
    expect(finding.personUrnsThatAreOthers).toBe(1);
  });

  it("derives the session set the one way it is derived anywhere, when not given one", () => {
    const captures: IdentityCapture[] = [ME, { url: "https://x/graphql", body: body({ entityUrn: TARGET.urn, viewer: OPERATOR }) }];
    const given = checkJobIdentity({ captures, target: TARGET, snapshotHtml: null, sessionUrns: sessionUrnsOf(captures) });
    const derived = checkJobIdentity({ captures, target: TARGET, snapshotHtml: null });
    expect(derived).toEqual(given);
  });

  it("reports an empty session set rather than pretending the check ran", () => {
    // No `/voyager/api/me` body: every `is this the operator` answer below is
    // meaningless, and the capability warns on exactly this.
    const captures: IdentityCapture[] = [{ url: "https://x/graphql", body: body({ entityUrn: TARGET.urn, viewer: OPERATOR }) }];
    const finding = checkJobIdentity({ captures, target: TARGET, snapshotHtml: null });
    expect(finding.sessionUrns).toBe(0);
    expect(finding.personUrnsThatAreSession).toBe(0);
    expect(finding.personUrns).toBe(1);
  });

  it("sees the subject in the DOM snapshot even when no body named it", () => {
    const finding = checkJobIdentity({
      captures: [ME],
      target: TARGET,
      snapshotHtml: `<html><body><a href="/jobs/view/${TARGET.id}/">apply</a></body></html>`,
    });
    expect(finding.subjectBodies).toBe(0);
    expect(finding.subjectInSnapshot).toBe(true);
  });

  it("returns zeros, not a throw, for a run that captured nothing", () => {
    const finding = checkJobIdentity({ captures: [], target: TARGET, snapshotHtml: null });
    expect(finding).toMatchObject({
      subjectBodies: 0, subjectInSnapshot: false, companyCandidates: 0,
      companyResolved: false, personUrns: 0, sessionUrns: 0,
    });
  });
});
