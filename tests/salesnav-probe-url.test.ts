import { describe, expect, it } from "vitest";
import { CapabilityError } from "../src/core/run/receipt.js";
import {
  findSearchParam, isSearchPage, MAX_PAGE_NUMBER, normalizeSalesNavUrl, parseSurfaces,
  SALESNAV_SURFACES, searchPageUrl,
} from "../src/capabilities/salesnav.probe/url.js";

const LEADS = "https://www.linkedin.com/sales/search/people";

describe("normalizeSalesNavUrl", () => {
  it("accepts a full leads search url", () => {
    const t = normalizeSalesNavUrl(LEADS);
    expect(t.vertical).toBe("people");
    expect(t.ref).toBe("salesnav:people");
  });

  it("accepts the accounts vertical", () => {
    expect(normalizeSalesNavUrl("https://www.linkedin.com/sales/search/company").vertical).toBe("company");
  });

  it("accepts a bare path", () => {
    expect(normalizeSalesNavUrl("/sales/search/people").url).toBe(`${LEADS}`);
  });

  // The property that separates this from every other normalizer in the repo.
  it("preserves the query, because on a search the query IS the target", () => {
    const raw = `${LEADS}?query=%28filters%3AList%29&sessionId=abc123&savedSearchId=999`;
    const t = normalizeSalesNavUrl(raw);
    expect(t.url).toContain("query=");
    expect(t.url).toContain("sessionId=abc123");
    expect(t.sessionId).toBe("abc123");
    expect(t.savedSearchId).toBe("999");
    expect(t.ref).toBe("salesnav:people:999");
  });

  it("drops the fragment and nothing else", () => {
    const t = normalizeSalesNavUrl(`${LEADS}?sessionId=z#results`);
    expect(t.url).toContain("sessionId=z");
    expect(t.url).not.toContain("#");
  });

  it("reads a page number already on the url", () => {
    expect(normalizeSalesNavUrl(`${LEADS}?page=4`).page).toBe(4);
    expect(normalizeSalesNavUrl(LEADS).page).toBeNull();
  });

  it.each([
    ["", "empty"],
    ["https://example.com/sales/search/people", "not linkedin"],
    ["https://www.linkedin.com/in/someone", "not a sales url"],
    ["https://www.linkedin.com/sales/lists/people", "a sales page but not a search"],
    ["https://www.linkedin.com/sales/search/nonsense", "an unmeasured vertical"],
    ["ftp://www.linkedin.com/sales/search/people", "a non-http scheme"],
    [`${LEADS}?page=0`, "a page number below 1"],
    [`${LEADS}?page=${MAX_PAGE_NUMBER + 1}`, "a page number past the ceiling"],
    [`${LEADS}?page=notanumber`, "a non-numeric page"],
  ])("refuses %s (%s)", (input) => {
    expect(() => normalizeSalesNavUrl(input)).toThrow(CapabilityError);
  });

  it("refuses before any spend, with the operator's own input as evidence", () => {
    try {
      normalizeSalesNavUrl("https://example.com/x");
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(CapabilityError);
      const e = cause as CapabilityError;
      expect(e.code).toBe("SALESNAV_URL_INVALID");
      expect(e.retryable).toBe(false);
      expect(e.evidence).toContain("example.com");
    }
  });

  it("clamps absurdly long input out of the evidence", () => {
    try {
      normalizeSalesNavUrl(`https://example.com/${"x".repeat(5000)}`);
      expect.unreachable();
    } catch (cause) {
      expect((cause as CapabilityError).evidence!.length).toBeLessThan(400);
    }
  });
});

describe("findSearchParam", () => {
  it("finds a plain query parameter", () => {
    expect(findSearchParam(`${LEADS}?sessionId=abc`, "sessionId")).toBe("abc");
  });

  // Sales Navigator packs filters into a percent-encoded blob, and the id can
  // sit inside it rather than beside it.
  it("finds one encoded inside the query blob", () => {
    expect(findSearchParam(`${LEADS}?query=x%26sessionId%3Dinner`, "sessionId")).toBe("inner");
  });

  it("returns null when it is absent", () => {
    expect(findSearchParam(LEADS, "sessionId")).toBeNull();
  });

  it("does not throw on a malformed escape", () => {
    expect(findSearchParam(`${LEADS}?q=%E0%A4%A`, "sessionId")).toBeNull();
  });
});

describe("searchPageUrl", () => {
  it("sets page=N and changes nothing else", () => {
    const t = normalizeSalesNavUrl(`${LEADS}?sessionId=abc&query=deadbeef`);
    const url = new URL(searchPageUrl(t, 2));
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("sessionId")).toBe("abc");
    expect(url.searchParams.get("query")).toBe("deadbeef");
  });

  it("replaces an existing page rather than appending a second one", () => {
    const t = normalizeSalesNavUrl(`${LEADS}?page=3`);
    expect([...new URL(searchPageUrl(t, 5)).searchParams.getAll("page")]).toEqual(["5"]);
  });

  it.each([0, -1, 1.5, MAX_PAGE_NUMBER + 1])("refuses page %s", (page) => {
    expect(() => searchPageUrl(normalizeSalesNavUrl(LEADS), page)).toThrow(CapabilityError);
  });
});

describe("parseSurfaces", () => {
  it("defaults to every surface, in load order", () => {
    expect(parseSurfaces(undefined)).toEqual([...SALESNAV_SURFACES]);
    expect(parseSurfaces("")).toEqual([...SALESNAV_SURFACES]);
  });

  // Surface order is a safety property here, not a preference: `home` is the
  // seat check and must precede anything metered.
  it("returns load order regardless of the order asked for", () => {
    expect(parseSurfaces("accounts,home")).toEqual(["home", "accounts"]);
    expect(parseSurfaces("leads,home")[0]).toBe("home");
  });

  it("de-duplicates", () => {
    expect(parseSurfaces("leads,leads,leads")).toEqual(["leads"]);
  });

  it("refuses an unknown surface by name", () => {
    expect(() => parseSurfaces("leads,jobs")).toThrow(/jobs/);
  });
});

describe("isSearchPage", () => {
  it("meters the results pages and not the app root", () => {
    expect(isSearchPage("home")).toBe(false);
    expect(isSearchPage("leads")).toBe(true);
    expect(isSearchPage("leads2")).toBe(true);
    expect(isSearchPage("accounts")).toBe(true);
  });
});
