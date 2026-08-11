import { describe, expect, it } from "vitest";
import { capability as accounts } from "../src/capabilities/salesnav.accounts.list/index.js";
import { capability as leads } from "../src/capabilities/salesnav.leads.list/index.js";

describe.each([["leads", leads], ["accounts", accounts]] as const)("salesnav %s parser-only entry point", (_, capability) => {
  it("cannot acquire a browser or spend before its runner task lands", async () => {
    expect(capability.needsBrowser).toBe(false);
    expect(capability.needsAuth).toBe(false);
    expect(capability.cost({})).toEqual({ page_loads: 0, search_pages: 0, profile_opens: 0 });
    await expect(capability.run({} as never)).rejects.toMatchObject({ code: "CAPABILITY_NOT_IMPLEMENTED", retryable: false });
  });
});
