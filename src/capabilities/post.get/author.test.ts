import { describe, expect, it, vi } from "vitest";

import { authorWarning, resolveAuthor } from "./author.js";

const URN = "urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA";

describe("author resolution (D330)", () => {
  it("returns the urn the store handed back, and only that", async () => {
    const lookup = vi.fn(async () => ({ urn: URN, vanityMatches: 1 }));
    await expect(resolveAuthor("tankots", lookup)).resolves.toEqual({
      status: "resolved", vanity: "tankots", urn: URN,
    });
    expect(lookup).toHaveBeenCalledWith("tankots");
  });

  it("refuses an ambiguous vanity rather than taking the most recent row (D331)", async () => {
    const resolution = await resolveAuthor("tankots", async () => ({ urn: URN, vanityMatches: 3 }));
    expect(resolution).toMatchObject({ status: "ambiguous", urn: null, matches: 3 });
  });

  it("treats a missing persons row as ordinary, not as an error (D332)", async () => {
    const resolution = await resolveAuthor("never-fetched", async () => null);
    expect(resolution).toMatchObject({ status: "not-found", urn: null });
  });

  it("does not touch the store when the snapshot yielded no vanity", async () => {
    const lookup = vi.fn(async () => ({ urn: URN, vanityMatches: 1 }));
    const resolution = await resolveAuthor(null, lookup);
    expect(resolution).toMatchObject({ status: "no-vanity", urn: null });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("never invents a urn on any refusal path", async () => {
    const outcomes = [
      await resolveAuthor(null, async () => null),
      await resolveAuthor("x", async () => null),
      await resolveAuthor("x", async () => ({ urn: URN, vanityMatches: 2 })),
    ];
    for (const outcome of outcomes) expect(outcome.urn).toBeNull();
  });
});

describe("the refusal said out loud", () => {
  it("says nothing when the author resolved", () => {
    expect(authorWarning({ status: "resolved", vanity: "tankots", urn: URN })).toBeNull();
  });

  it("names the vanity and the fix on a miss", () => {
    const warning = authorWarning({ status: "not-found", vanity: "never-fetched", urn: null })!;
    expect(warning.code).toBe("POST_AUTHOR_NOT_STORED");
    expect(warning.field).toContain("never-fetched");
    expect(warning.field).toContain("profile.get");
  });

  it("counts the colliding rows on an ambiguity", () => {
    const warning = authorWarning({ status: "ambiguous", vanity: "tankots", urn: null, matches: 4 })!;
    expect(warning.code).toBe("POST_AUTHOR_AMBIGUOUS");
    expect(warning.n).toBe(4);
  });

  it("states the consequence when there was no vanity to look up", () => {
    const warning = authorWarning({ status: "no-vanity", vanity: null, urn: null })!;
    expect(warning.code).toBe("POST_AUTHOR_NOT_STORED");
    expect(warning.field).toContain("no post row");
  });
});
