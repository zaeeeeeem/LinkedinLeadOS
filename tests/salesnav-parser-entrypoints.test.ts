import { describe, expect, it } from "vitest";
import { capability as accounts } from "../src/capabilities/salesnav.accounts.list/index.js";
import { capability as leads } from "../src/capabilities/salesnav.leads.list/index.js";

describe("salesnav accounts live entry point", () => {
  it("is metered, browser-bound, and defaults to two company-search pages", () => {
    expect(accounts.needsBrowser).toBe(true);
    expect(accounts.risk).toBe("read-metered");
    const parsed = accounts.args.parse({ url: "https://www.linkedin.com/sales/search/company" });
    expect(parsed).toMatchObject({ pages: 2, limit: 50 });
    expect(accounts.cost(parsed)).toEqual({ page_loads: 2, search_pages: 2, profile_opens: 0 });
  });
});

describe("salesnav leads live entry point", () => {
  it("is metered, browser-bound, and defaults to two pages", () => {
    expect(leads.needsBrowser).toBe(true);
    expect(leads.risk).toBe("read-metered");
    const parsed = leads.args.parse({ url: "https://www.linkedin.com/sales/search/people" });
    expect(parsed).toMatchObject({ pages: 2, limit: 50 });
    expect(leads.cost(parsed)).toEqual({ page_loads: 2, search_pages: 2, profile_opens: 0 });
  });
});
