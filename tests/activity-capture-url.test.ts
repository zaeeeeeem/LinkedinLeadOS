import { describe, expect, it } from "vitest";
import {
  ACTIVITY_SURFACES,
  looksLikePostPermalink,
  normalizeActivityUrl,
} from "../src/capabilities/activity.capture/url.js";
import { normalizeProfileUrl } from "../src/capabilities/profile.capture/url.js";
import { CapabilityError } from "../src/core/run/receipt.js";

function refusal(input: string, o?: { surface?: "posts" | "comments" | "reactions" }): CapabilityError {
  try {
    normalizeActivityUrl(input, o ?? {});
  } catch (e) {
    if (e instanceof CapabilityError) return e;
    throw e;
  }
  throw new Error(`expected ${input} to be refused`);
}

describe("normalizeActivityUrl — the person surfaces", () => {
  it("keeps the recent-activity path instead of collapsing it to the profile", () => {
    // The property this module exists for. `normalizeProfileUrl` deliberately
    // collapses sub-paths onto `/in/<vanity>/` — reusing it here would navigate
    // every probe to the profile page and measure nothing.
    const input = "https://www.linkedin.com/in/tankots/recent-activity/all/";
    expect(normalizeProfileUrl(input).url).toBe("https://www.linkedin.com/in/tankots/");
    expect(normalizeActivityUrl(input).url).toBe(
      "https://www.linkedin.com/in/tankots/recent-activity/all/",
    );
  });

  it("maps every known tab to its surface", () => {
    const of = (tab: string) =>
      normalizeActivityUrl(`https://www.linkedin.com/in/jane-doe/recent-activity/${tab}/`).surface;
    expect(of("all")).toBe("posts");
    expect(of("shares")).toBe("posts");
    expect(of("posts")).toBe("posts");
    expect(of("comments")).toBe("comments");
    expect(of("reactions")).toBe("reactions");
  });

  it("refuses a tab this build has not measured rather than guessing", () => {
    const err = refusal("https://www.linkedin.com/in/jane-doe/recent-activity/documents/");
    expect(err.code).toBe("ACTIVITY_URL_INVALID");
    expect(err.message).toContain("has not measured");
  });

  it("carries the profile_open dedupe key in profile.capture's own spelling", () => {
    // Not cosmetic: the ledger dedupes distinct profiles on this string, so a
    // different spelling would count one person twice in a day (D223).
    const activity = normalizeActivityUrl("https://www.linkedin.com/in/Tankots/recent-activity/all/");
    const profile = normalizeProfileUrl("https://www.linkedin.com/in/Tankots/");
    expect(activity.personRef).toBe(profile.ref);
    expect(activity.personRef).toBe("in:tankots");
  });

  it("gives each surface of one person its own ref", () => {
    const refs = (["posts", "comments", "reactions"] as const).map(
      (surface) => normalizeActivityUrl("jane-doe", { surface }).ref,
    );
    expect(new Set(refs).size).toBe(3);
    expect(refs).toContain("comments:in:jane-doe");
  });

  it("defaults a bare vanity to the posts tab and accepts an explicit surface", () => {
    expect(normalizeActivityUrl("jane-doe").url).toBe(
      "https://www.linkedin.com/in/jane-doe/recent-activity/all/",
    );
    expect(normalizeActivityUrl("jane-doe", { surface: "reactions" }).url).toBe(
      "https://www.linkedin.com/in/jane-doe/recent-activity/reactions/",
    );
  });

  it("refuses a --surface that disagrees with the url instead of picking one", () => {
    const err = refusal("https://www.linkedin.com/in/jane-doe/recent-activity/comments/", {
      surface: "posts",
    });
    expect(err.message).toContain("they must agree");
  });

  it("accepts a --surface that agrees with the url", () => {
    const target = normalizeActivityUrl(
      "https://www.linkedin.com/in/jane-doe/recent-activity/comments/",
      { surface: "comments" },
    );
    expect(target.surface).toBe("comments");
  });

  it("drops every query parameter and fragment", () => {
    const target = normalizeActivityUrl(
      "https://www.linkedin.com/in/jane-doe/recent-activity/all/?trk=abc&lipi=xyz#feed",
    );
    expect(target.url).toBe("https://www.linkedin.com/in/jane-doe/recent-activity/all/");
  });

  it("accepts the bare in/<vanity> and scheme-less host forms", () => {
    expect(normalizeActivityUrl("in/jane-doe/recent-activity/comments/").surface).toBe("comments");
    expect(normalizeActivityUrl("www.linkedin.com/in/jane-doe/recent-activity/reactions/").surface)
      .toBe("reactions");
  });

  it("accepts a non-www linkedin subdomain", () => {
    expect(normalizeActivityUrl("https://ca.linkedin.com/in/jane-doe/recent-activity/all/").surface)
      .toBe("posts");
  });
});

describe("normalizeActivityUrl — a single post", () => {
  it("reads the activity urn out of a /feed/update/ permalink", () => {
    const target = normalizeActivityUrl(
      "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
    );
    expect(target.surface).toBe("post");
    expect(target.postUrn).toBe("urn:li:activity:7123456789012345678");
    expect(target.ref).toBe("post:urn:li:activity:7123456789012345678");
    // No person is opened by a permalink, so there is nothing to dedupe on.
    expect(target.personRef).toBeUndefined();
  });

  it("accepts ugcPost and share spellings", () => {
    expect(normalizeActivityUrl("https://www.linkedin.com/feed/update/urn:li:ugcPost:7123456789/").postUrn)
      .toBe("urn:li:ugcPost:7123456789");
    expect(normalizeActivityUrl("https://www.linkedin.com/feed/update/urn:li:share:7123456789/").postUrn)
      .toBe("urn:li:share:7123456789");
  });

  it("reads the id out of a /posts/ slug and navigates the /posts/ form unchanged", () => {
    const target = normalizeActivityUrl(
      "https://www.linkedin.com/posts/jane-doe_hiring-activity-7123456789012345678-Ab1c",
    );
    expect(target.postUrn).toBe("urn:li:activity:7123456789012345678");
    // The page LinkedIn actually serves for that link, not a rewrite of it: a
    // probe that rewrote the url would measure a redirect.
    expect(target.url).toBe(
      "https://www.linkedin.com/posts/jane-doe_hiring-activity-7123456789012345678-Ab1c",
    );
  });

  it("refuses a /posts/ slug with no activity component", () => {
    expect(refusal("https://www.linkedin.com/posts/jane-doe_hiring-abc").message)
      .toContain("-activity-");
  });

  it("refuses a permalink whose urn is not a post urn", () => {
    expect(refusal("https://www.linkedin.com/feed/update/urn:li:fsd_profile:ACoAAA/").message)
      .toContain("is not a post urn");
  });

  it("refuses --surface=post, which names no page on its own", () => {
    // `post` is a surface of the family, not a tab: without a permalink there
    // is no post to open, and defaulting to one would be an invention.
    let err: unknown;
    try {
      normalizeActivityUrl("jane-doe", { surface: "post" as never });
    } catch (e) {
      err = e;
    }
    expect((err as CapabilityError).message).toContain("names no page on its own");
  });
});

describe("normalizeActivityUrl — refusals", () => {
  it("refuses an empty input, a non-linkedin host, and a non-http scheme", () => {
    expect(refusal("   ").message).toContain("empty");
    expect(refusal("https://example.com/in/jane-doe/recent-activity/all/").message)
      .toContain("not a linkedin.com host");
    expect(refusal("javascript:alert(1)").message).toContain("only http and https");
  });

  it("refuses a linkedin page that is not in this family", () => {
    expect(refusal("https://www.linkedin.com/company/acme/posts/").message)
      .toContain("not a person-activity or post url");
  });

  it("refuses an /in/ page that is not recent-activity", () => {
    expect(refusal("https://www.linkedin.com/in/jane-doe/details/experience/").message)
      .toContain("is not a recent-activity page");
  });

  it("treats /in/<vanity>/ with no tail as the posts tab", () => {
    expect(normalizeActivityUrl("https://www.linkedin.com/in/jane-doe/").surface).toBe("posts");
  });

  it("echoes the operator's input back, truncated, so a refusal is actionable", () => {
    const long = `https://www.linkedin.com/in/${"a".repeat(400)}`;
    const err = refusal(long);
    expect(err.evidence).toContain("… (");
    expect(err.evidence!.length).toBeLessThan(360);
  });
});

describe("looksLikePostPermalink", () => {
  it("is total — garbage answers false rather than throwing", () => {
    // `cost()` runs where a throw is reported as COST_ESTIMATE_FAILED and the
    // real message is lost, so this must never throw.
    for (const input of ["", "   ", "javascript:alert(1)", "https://example.com", "%%%"]) {
      expect(() => looksLikePostPermalink(input)).not.toThrow();
      expect(looksLikePostPermalink(input)).toBe(false);
    }
  });

  it("agrees with the normalizer on both kinds of target", () => {
    const permalink = "https://www.linkedin.com/feed/update/urn:li:activity:7123456789/";
    const person = "https://www.linkedin.com/in/jane-doe/recent-activity/all/";
    expect(looksLikePostPermalink(permalink)).toBe(true);
    expect(normalizeActivityUrl(permalink).surface).toBe("post");
    expect(looksLikePostPermalink(person)).toBe(false);
    expect(normalizeActivityUrl(person).surface).not.toBe("post");
  });
});

describe("ACTIVITY_SURFACES", () => {
  it("is the closed set the arg schema and the probe both read", () => {
    expect([...ACTIVITY_SURFACES]).toEqual(["posts", "comments", "reactions", "post"]);
  });
});
