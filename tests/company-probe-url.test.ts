import { describe, expect, it } from "vitest";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import {
  COMPANY_SUBPAGES, companySubPageUrl, isCompanySubPage, normalizeCompanyUrl, parseSubPages,
} from "../src/capabilities/company.probe/url.js";

const ACME = "https://www.linkedin.com/company/acme-robotics/";

describe("normalizeCompanyUrl — what it accepts", () => {
  it("takes the canonical company url", () => {
    const t = normalizeCompanyUrl(ACME);
    expect(t).toMatchObject({ kind: "company", url: ACME, ref: "company:acme-robotics", vanity: "acme-robotics" });
  });

  it("takes a bare slug, a bare path, and a scheme-less host", () => {
    for (const input of [
      "acme-robotics",
      "company/acme-robotics",
      "/company/acme-robotics",
      "www.linkedin.com/company/acme-robotics",
      "linkedin.com/company/acme-robotics/about/",
    ]) {
      expect(normalizeCompanyUrl(input).url, input).toBe(ACME);
    }
  });

  it("takes the numeric company id LinkedIn serves the same page under", () => {
    expect(normalizeCompanyUrl("https://www.linkedin.com/company/1441/").vanity).toBe("1441");
  });

  it("drops every query parameter and every sub-path (D113)", () => {
    const t = normalizeCompanyUrl(
      "https://ca.linkedin.com/company/acme-robotics/people/?trk=nav&lipi=abc#anchor",
    );
    expect(t.url).toBe(ACME);
    expect(t.ref).toBe("company:acme-robotics");
  });

  it("lower-cases the ref but keeps the vanity as written", () => {
    const t = normalizeCompanyUrl("https://www.linkedin.com/company/Acme-Robotics/");
    expect(t.vanity).toBe("Acme-Robotics");
    expect(t.ref).toBe("company:acme-robotics");
  });

  it("keeps the raw escaped segment for navigation and decodes only for display", () => {
    const t = normalizeCompanyUrl("https://www.linkedin.com/company/caf%C3%A9-noir/");
    expect(t.segment).toBe("caf%C3%A9-noir");
    expect(t.url).toBe("https://www.linkedin.com/company/caf%C3%A9-noir/");
    expect(t.vanity).toBe("café-noir");
    expect(t.ref).toBe("company:café-noir");
  });

  it("gives a company ref that can never collide with a profile ref in the ledger", () => {
    // Both are `<kind>:<slug>` in the same ledger, and `profile.capture` writes
    // `in:` / `lead:`. A shared slug across the two must dedupe apart.
    expect(normalizeCompanyUrl("acme").ref).toBe("company:acme");
    expect(normalizeCompanyUrl("acme").ref).not.toBe("in:acme");
  });
});

describe("normalizeCompanyUrl — what it refuses, before anything is spent", () => {
  const refuses = (input: string, why: RegExp) => {
    let thrown: unknown;
    try {
      normalizeCompanyUrl(input);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, input).toBeInstanceOf(CapabilityError);
    const err = thrown as CapabilityError;
    expect(err.code).toBe("COMPANY_URL_INVALID");
    expect(err.exit).toBe(EXIT.GENERIC);
    expect(err.retryable).toBe(false);
    expect(err.message, input).toMatch(why);
  };

  it("refuses an empty input", () => refuses("   ", /empty/));
  it("refuses a non-linkedin host", () => refuses("https://example.com/company/acme/", /not a linkedin\.com host/));
  it("refuses a non-http scheme", () => refuses("javascript:alert(1)", /only http and https/));
  it("refuses a profile url", () => refuses("https://www.linkedin.com/in/jane/", /not a company url/));
  it("refuses /company/ with nothing after it", () =>
    refuses("https://www.linkedin.com/company/", /no company segment after/));

  it("refuses /showcase/ and /school/ by name rather than treating them as companies", () => {
    refuses("https://www.linkedin.com/showcase/acme-cloud/", /showcase\/ is a related LinkedIn page family/);
    refuses("https://www.linkedin.com/school/some-university/", /school\/ is a related LinkedIn page family/);
  });

  it("truncates a huge input on the evidence rather than echoing it whole", () => {
    try {
      normalizeCompanyUrl("x".repeat(5000));
    } catch (err) {
      expect((err as CapabilityError).evidence).toMatch(/…\s\(5000 chars\)$/);
    }
  });
});

describe("companySubPageUrl", () => {
  const target = normalizeCompanyUrl(ACME);

  it("gives one url per sub-page, main being the base url itself", () => {
    expect(companySubPageUrl(target, "main")).toBe(ACME);
    expect(companySubPageUrl(target, "about")).toBe(`${ACME}about/`);
    expect(companySubPageUrl(target, "posts")).toBe(`${ACME}posts/`);
    expect(companySubPageUrl(target, "people")).toBe(`${ACME}people/`);
    expect(companySubPageUrl(target, "jobs")).toBe(`${ACME}jobs/`);
  });

  it("produces five distinct urls, so five document watches cannot collide", () => {
    const urls = COMPANY_SUBPAGES.map((s) => companySubPageUrl(target, s));
    expect(new Set(urls).size).toBe(COMPANY_SUBPAGES.length);
  });

  it("never re-encodes an already-escaped segment", () => {
    const escaped = normalizeCompanyUrl("https://www.linkedin.com/company/caf%C3%A9-noir/");
    expect(companySubPageUrl(escaped, "jobs")).toBe("https://www.linkedin.com/company/caf%C3%A9-noir/jobs/");
  });
});

describe("parseSubPages", () => {
  it("defaults to every sub-page, in load order", () => {
    expect(parseSubPages(undefined)).toEqual([...COMPANY_SUBPAGES]);
    expect(parseSubPages("")).toEqual([...COMPANY_SUBPAGES]);
  });

  it("keeps load order regardless of the order asked for, and de-duplicates", () => {
    expect(parseSubPages("jobs,main,jobs,about")).toEqual(["main", "about", "jobs"]);
  });

  it("refuses an unknown sub-page instead of silently dropping it (a direct caller's path)", () => {
    let thrown: unknown;
    try {
      parseSubPages("main,insights");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CapabilityError);
    expect((thrown as CapabilityError).code).toBe("COMPANY_SUBPAGE_UNKNOWN");
    expect((thrown as CapabilityError).message).toMatch(/insights/);
  });

  it("never returns more than the stated page-load budget allows", () => {
    // The list is the bound: there is no input that makes this longer.
    expect(parseSubPages("main,main,main,main,main,main,main").length).toBe(1);
    expect(parseSubPages(undefined).length).toBeLessThanOrEqual(6);
  });

  it("isCompanySubPage names exactly the five", () => {
    expect(COMPANY_SUBPAGES.every(isCompanySubPage)).toBe(true);
    expect(isCompanySubPage("insights")).toBe(false);
  });
});
