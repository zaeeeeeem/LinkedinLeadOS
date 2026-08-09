import { describe, expect, it } from "vitest";
import { normalizeJobUrl } from "../src/capabilities/job.capture/url.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

const ID = "4012345678";

/** Every accepted spelling must produce the same three fields, because those
 *  three are what the ledger, the events and §7's `jobs.id` all key on (D260). */
function expectCanonical(input: string): void {
  const t = normalizeJobUrl(input);
  expect(t.id, input).toBe(ID);
  expect(t.ref, input).toBe(`job:${ID}`);
  expect(t.url, input).toBe(`https://www.linkedin.com/jobs/view/${ID}/`);
  expect(t.urn, input).toBe(`urn:li:fsd_jobPosting:${ID}`);
}

describe("normalizeJobUrl accepts every spelling LinkedIn hands out", () => {
  it("canonicalizes the detail url, with and without a trailing slash", () => {
    expectCanonical(`https://www.linkedin.com/jobs/view/${ID}/`);
    expectCanonical(`https://www.linkedin.com/jobs/view/${ID}`);
  });

  it("drops every query parameter and fragment", () => {
    // `refId`/`trackingId`/`trk` are appended by LinkedIn's own in-app links and
    // change nothing about which posting is served.
    expectCanonical(`https://www.linkedin.com/jobs/view/${ID}/?refId=abc&trackingId=x%2Fy#top`);
  });

  it("accepts the slugged share form and takes the trailing id", () => {
    expectCanonical(`https://www.linkedin.com/jobs/view/senior-engineer-at-acme-${ID}`);
  });

  it("accepts a listing url that names the open posting in currentJobId", () => {
    // The target is still the detail page: the pane inside a listing is a
    // different surface from the one this capability measures.
    expectCanonical(`https://www.linkedin.com/jobs/collections/recommended/?currentJobId=${ID}`);
    expectCanonical(`https://www.linkedin.com/jobs/search/?currentJobId=${ID}&keywords=x`);
  });

  it("accepts a bare id, a bare path, a urn, and any linkedin subdomain", () => {
    expectCanonical(ID);
    expectCanonical(`jobs/view/${ID}`);
    expectCanonical(`/jobs/view/${ID}/`);
    expectCanonical(`urn:li:fsd_jobPosting:${ID}`);
    expectCanonical(`urn:li:fs_normalized_jobPosting:${ID}`);
    expectCanonical(`ca.linkedin.com/jobs/view/${ID}/`);
    expectCanonical(`  https://WWW.LinkedIn.com/jobs/view/${ID}/  `);
  });
});

describe("normalizeJobUrl refuses rather than guesses", () => {
  function refusal(input: string): CapabilityError {
    try {
      normalizeJobUrl(input);
    } catch (e) {
      return e as CapabilityError;
    }
    throw new Error(`expected ${input} to be refused`);
  }

  it("refuses a listing url that names no posting", () => {
    // Opening it would spend a page load on whichever job LinkedIn selects, and
    // the capture would be keyed to a posting nobody asked for.
    const e = refusal("https://www.linkedin.com/jobs/collections/recommended/");
    expect(e.code).toBe("JOB_URL_INVALID");
    expect(e.exit).toBe(EXIT.GENERIC);
    expect(e.retryable).toBe(false);
    expect(e.message).toMatch(/names no job posting/);
  });

  it("refuses a /jobs/view/ segment carrying no numeric id", () => {
    // LinkedIn resolves some non-numeric segments by redirect; a target whose id
    // is only known after the load cannot be keyed or deduped before it.
    expect(refusal("https://www.linkedin.com/jobs/view/some-title-only").message).toMatch(
      /carries no numeric job posting id/,
    );
  });

  it("refuses another linkedin surface, another host, and another scheme", () => {
    expect(refusal(`https://www.linkedin.com/in/tankots/`).message).toMatch(/not a job posting url/);
    expect(refusal(`https://example.com/jobs/view/${ID}/`).message).toMatch(/not a linkedin.com host/);
    expect(refusal(`javascript:alert(1)`).message).toMatch(/only http and https/);
  });

  it("refuses an empty input and a number too short to be a posting id", () => {
    expect(refusal("   ").message).toMatch(/empty/);
    expect(refusal("42").message).toMatch(/neither a url nor a numeric job posting id/);
  });

  it("echoes the operator's own input back, truncated, and never more", () => {
    const long = `https://www.linkedin.com/jobs/view/${"x".repeat(500)}`;
    const e = refusal(long);
    expect(e.evidence).toContain("… (");
    expect(e.evidence!.length).toBeLessThan(340);
  });
});
