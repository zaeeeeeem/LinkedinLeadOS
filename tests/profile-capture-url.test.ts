import { describe, expect, it } from "vitest";
import { normalizeProfileUrl } from "../src/capabilities/profile.capture/url.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

/** Every rejection is the same class: fatal, exit 1, one code. */
function rejects(input: string, why: RegExp): void {
  let thrown: unknown;
  try {
    normalizeProfileUrl(input);
  } catch (e) {
    thrown = e;
  }
  expect(thrown, `expected ${JSON.stringify(input)} to be refused`).toBeInstanceOf(CapabilityError);
  const err = thrown as CapabilityError;
  expect(err.code).toBe("PROFILE_URL_INVALID");
  expect(err.exit).toBe(EXIT.GENERIC);
  expect(err.retryable).toBe(false);
  expect(err.action).toBe("HALT_AND_NOTIFY");
  expect(err.message).toMatch(why);
}

describe("normalizeProfileUrl — /in/ profiles", () => {
  it("canonicalizes a plain profile url", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/in/talha-tariq")).toEqual({
      kind: "profile",
      url: "https://www.linkedin.com/in/talha-tariq/",
      ref: "in:talha-tariq",
      vanity: "talha-tariq",
    });
  });

  it("adds the scheme when it is missing", () => {
    expect(normalizeProfileUrl("www.linkedin.com/in/someone").url).toBe(
      "https://www.linkedin.com/in/someone/",
    );
    expect(normalizeProfileUrl("linkedin.com/in/someone").url).toBe(
      "https://www.linkedin.com/in/someone/",
    );
  });

  it("strips every query parameter and the fragment", () => {
    // `trk`, `lipi`, `licu`, `miniProfileUrn`, `original_referer` are all
    // LinkedIn's own tracking; none of them changes which page loads.
    const url =
      "https://www.linkedin.com/in/someone/?trk=public_profile_browsemap&lipi=urn%3Ali%3Apage%3Ad_flagship" +
      "&original_referer=https%3A%2F%2Fwww.google.com%2F&utm_source=share#experience";
    expect(normalizeProfileUrl(url).url).toBe("https://www.linkedin.com/in/someone/");
  });

  it("drops overlay and sub-page segments back to the base profile", () => {
    for (const suffix of [
      "/details/experience/",
      "/recent-activity/all/",
      "/overlay/contact-info/",
      "/detail/recent-activity/shares/",
    ]) {
      expect(normalizeProfileUrl(`https://www.linkedin.com/in/someone${suffix}`).url).toBe(
        "https://www.linkedin.com/in/someone/",
      );
    }
  });

  it("normalizes locale subdomains and the mobile host onto www", () => {
    for (const host of ["fr.linkedin.com", "de.linkedin.com", "m.linkedin.com", "LinkedIn.com"]) {
      expect(normalizeProfileUrl(`https://${host}/in/someone`).url).toBe(
        "https://www.linkedin.com/in/someone/",
      );
    }
  });

  it("accepts a bare vanity slug", () => {
    expect(normalizeProfileUrl("talha-tariq-1a2b3c")).toEqual({
      kind: "profile",
      url: "https://www.linkedin.com/in/talha-tariq-1a2b3c/",
      ref: "in:talha-tariq-1a2b3c",
      vanity: "talha-tariq-1a2b3c",
    });
    expect(normalizeProfileUrl("in/talha-tariq").url).toBe("https://www.linkedin.com/in/talha-tariq/");
    expect(normalizeProfileUrl("/in/talha-tariq").url).toBe("https://www.linkedin.com/in/talha-tariq/");
  });

  it("trims surrounding whitespace before deciding anything", () => {
    expect(normalizeProfileUrl("  https://www.linkedin.com/in/someone/  ").url).toBe(
      "https://www.linkedin.com/in/someone/",
    );
  });

  it("percent-decodes the vanity for the ref while keeping the url navigable", () => {
    const t = normalizeProfileUrl("https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa");
    expect(t.vanity).toBe("josé-garcía");
    // The navigable url keeps the escaped form: it is what LinkedIn's own links use.
    expect(t.url).toBe("https://www.linkedin.com/in/jos%C3%A9-garc%C3%ADa/");
    expect(t.ref).toBe("in:josé-garcía");
  });

  it("lower-cases the ref so one profile is one budget entry", () => {
    // §8 dedupes profile_open by ref. Two spellings of one profile that produced
    // two refs would let the same person be opened twice inside one daily quota.
    const a = normalizeProfileUrl("https://www.linkedin.com/in/SomeOne");
    const b = normalizeProfileUrl("https://www.linkedin.com/in/someone/");
    expect(a.ref).toBe(b.ref);
    // The url keeps the caller's spelling — the vanity is LinkedIn's, not ours to fold.
    expect(a.url).toBe("https://www.linkedin.com/in/SomeOne/");
  });

  it("is idempotent: normalizing its own output changes nothing", () => {
    const once = normalizeProfileUrl("https://fr.linkedin.com/in/someone?trk=x");
    expect(normalizeProfileUrl(once.url)).toEqual(once);
  });
});

describe("normalizeProfileUrl — Sales Navigator leads", () => {
  it("accepts a lead url and keeps the whole lead segment navigable", () => {
    const t = normalizeProfileUrl(
      "https://www.linkedin.com/sales/lead/ACwAAABcDeF,NAME_SEARCH,a1b2?_ntb=abc",
    );
    expect(t).toEqual({
      kind: "sales-lead",
      url: "https://www.linkedin.com/sales/lead/ACwAAABcDeF,NAME_SEARCH,a1b2",
      ref: "lead:acwaaabcdef",
      leadId: "ACwAAABcDeF",
    });
  });

  it("accepts a bare lead id with no comma tuple", () => {
    expect(normalizeProfileUrl("https://www.linkedin.com/sales/lead/ACwAAABcDeF").ref).toBe(
      "lead:acwaaabcdef",
    );
  });

  it("refuses a lead url with no id", () => {
    rejects("https://www.linkedin.com/sales/lead/", /no lead id/i);
  });
});

describe("normalizeProfileUrl — rejections", () => {
  it("refuses an empty or blank input", () => {
    rejects("", /empty/i);
    rejects("   ", /empty/i);
  });

  it("refuses a non-LinkedIn host, including a lookalike", () => {
    rejects("https://example.com/in/someone", /not a linkedin/i);
    // The suffix check must be on a dot boundary: `notlinkedin.com` is not ours.
    rejects("https://notlinkedin.com/in/someone", /not a linkedin/i);
    rejects("https://linkedin.com.evil.example/in/someone", /not a linkedin/i);
  });

  it("refuses a non-http scheme", () => {
    rejects("javascript:alert(1)", /http/i);
    rejects("file:///etc/passwd", /http/i);
    rejects("ftp://www.linkedin.com/in/someone", /http/i);
  });

  it("refuses LinkedIn pages that are not a profile", () => {
    rejects("https://www.linkedin.com/company/acme/", /not a profile url/i);
    rejects("https://www.linkedin.com/feed/", /not a profile url/i);
    rejects("https://www.linkedin.com/jobs/view/123456/", /not a profile url/i);
    rejects("https://www.linkedin.com/", /not a profile url/i);
  });

  it("refuses the legacy /pub/ profile form by name rather than mis-parsing it", () => {
    rejects("https://www.linkedin.com/pub/jane-doe/1/2a/3b", /legacy/i);
  });

  it("refuses an /in/ url with no vanity", () => {
    rejects("https://www.linkedin.com/in/", /no vanity/i);
    rejects("https://www.linkedin.com/in", /no vanity/i);
  });

  it("refuses a bare slug that cannot be a vanity", () => {
    rejects("ab", /vanity/i); // too short
    rejects("has spaces", /vanity/i);
    rejects("has/slash", /vanity/i);
    rejects("a".repeat(200), /vanity/i);
  });

  it("names what it accepts, so the operator can fix the input from the receipt alone", () => {
    try {
      normalizeProfileUrl("https://www.linkedin.com/company/acme/");
    } catch (e) {
      expect((e as CapabilityError).message).toMatch(/\/in\/</);
      expect((e as CapabilityError).message).toMatch(/sales\/lead/);
    }
  });
});
