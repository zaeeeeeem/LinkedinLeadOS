import { describe, expect, it } from "vitest";
import { capability as accounts } from "../src/capabilities/salesnav.accounts.list/index.js";
import { capability as leads } from "../src/capabilities/salesnav.leads.list/index.js";

describe("salesnav accounts parser-only entry point", () => {
  it("cannot acquire a browser or spend before its runner task lands", async () => {
    expect(accounts.needsBrowser).toBe(false);
    expect(accounts.needsAuth).toBe(false);
    expect(accounts.cost({})).toEqual({ page_loads: 0, search_pages: 0, profile_opens: 0 });
    await expect(accounts.run({} as never)).rejects.toMatchObject({ code: "CAPABILITY_NOT_IMPLEMENTED", retryable: false });
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
