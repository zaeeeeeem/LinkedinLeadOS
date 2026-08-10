import { describe, expect, it, vi } from "vitest";

import type { AuthorLookup } from "./author.js";
import { createPostGetCapability, DEFAULT_COMMENTS_LIMIT, DEFAULT_REACTIONS_LIMIT } from "./index.js";

/**
 * The default author lookup in these tests finds nothing, which is the ordinary
 * case for a post by someone never fetched with `profile.get` (D332) — and it
 * keeps every pre-Task-34 assertion about archive-only behaviour honest.
 */
function make(
  captureFn: unknown,
  o: { findAuthor?: AuthorLookup; store?: (row: never) => Promise<number> } = {},
) {
  return createPostGetCapability({
    capture: captureFn as never,
    findAuthor: o.findAuthor ?? (async () => null),
    store: (o.store ?? (async () => 1)) as never,
  });
}

const URN = "urn:li:activity:7491197577439141888";
const PERMALINK = `https://www.linkedin.com/posts/tankots_five-years-activity-7491197577439141888-dqLl`;

/** The smallest snapshot that satisfies every anchor the parser resolves on. */
function snapshotHtml(o: { urn?: string; comments?: number; commentsTotal?: number; reactionsTotal?: number } = {}): string {
  const urn = o.urn ?? URN;
  const rows = Array.from({ length: o.comments ?? 3 }, (_, i) => {
    const id = `urn:li:comment:(${urn},${1000 + i})`;
    return `<div id="replaceableComment_${id}">
      <a href="https://www.linkedin.com/in/commenter-${i}/">c${i}</a>
      <div data-testid="expandable-text-box">comment ${i}</div>
    </div>`;
  }).join("");
  return `<html><body>
    <a href="https://www.linkedin.com/in/zaeem-dev/">operator rail</a>
    <div data-testid="expandable-text-box">the post body</div>
    <a href="https://www.linkedin.com/in/tankots/">author</a>
    <span>${o.reactionsTotal ?? 1013} reactions</span>
    <span>${o.commentsTotal ?? 73} comments</span>
    <span>5 reposts</span>
    <div data-testid="ReactionFacepileCollection-${urn}">
      <a href="https://www.linkedin.com/in/dhruvcodes/"><div aria-label="Dhruv Tyagi reacted with Like"></div></a>
      <a href="https://www.linkedin.com/in/someoneelse/"><div aria-label="Some One reacted with Celebrate"></div></a>
    </div>
    <div data-testid="commentList-FeedType_FEED_DETAIL">${rows}</div>
  </body></html>`;
}

function context(args: Record<string, unknown>, html = snapshotHtml()) {
  return {
    args: {
      comments: false,
      commentsLimit: DEFAULT_COMMENTS_LIMIT,
      reactions: false,
      reactionsLimit: DEFAULT_REACTIONS_LIMIT,
      ...args,
    },
    flags: { noStore: false },
    run: { runId: "run", log: vi.fn(), paths: { raw: "/runs/run/raw" } },
    browser: {
      tap: { captures: () => [] },
      archive: { readText: async () => html },
    },
  } as never;
}

function capture(html = snapshotHtml(), reactionBodies: string[] = []) {
  return vi.fn(async () => ({
    snapshotFile: "0026-abc.json.gz",
    sessionUrns: [],
    sessionVanities: ["zaeem-dev"],
    reactionBodies,
    result: { counts: { requested: 1, captured: 1, usable: 1, skipped: 0 }, warnings: [], data: { snapshot: { archived: "0026-abc.json.gz" } } },
    html,
  }));
}

describe("post.get composition", () => {
  it("passes no surface hint down to the capture — a permalink names itself", async () => {
    // The live failure of 2026-08-10: `--surface=post` is refused as naming no
    // page on its own, so the delegated capture must not receive it.
    const spy = capture();
    const cap = make(spy);
    await cap.run(context({ url: PERMALINK }));
    expect(spy).toHaveBeenCalledTimes(1);
    const captureArgs = (spy.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1];
    expect(captureArgs).not.toHaveProperty("surface");
    expect(captureArgs).toMatchObject({ url: expect.stringContaining("7491197577439141888") });
  });

  it("costs one page load and opens nobody's profile", () => {
    const cap = make(capture());
    expect(cap.cost({ url: PERMALINK } as never)).toMatchObject({ page_loads: 1, profile_opens: 0 });
  });

  it("refuses a non-permalink before spending anything", async () => {
    const spy = capture();
    const cap = make(spy);
    await expect(cap.run(context({ url: "https://www.linkedin.com/in/tankots/" })))
      .rejects.toMatchObject({ code: "POST_GET_URL_INVALID" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the post and nothing else by default — no comments, no reactions", async () => {
    const cap = make(capture());
    const receipt = await cap.run(context({ url: PERMALINK }));
    const data = receipt.data as { read: { comments: number; reactions: number }; post: { author_vanity: string } };
    expect(data.read).toMatchObject({ comments: 0, reactions: 0 });
    expect(data.post.author_vanity).toBe("tankots");
    // Nothing was asked for, so nothing is reported partial.
    expect((receipt.warnings ?? []).map((w) => w.code)).not.toContain("COMMENTS_PARTIAL");
    expect((receipt.warnings ?? []).map((w) => w.code)).not.toContain("REACTIONS_PARTIAL");
  });

  it("prefers the labeled reactions body over the rendered facepile (D341)", async () => {
    const body = JSON.stringify({
      data: { data: { socialDashReactionsByReactionType: { paging: { total: 1052 } } } },
      included: [{
        $type: "com.linkedin.voyager.dash.social.Reaction",
        actorUrn: "urn:li:fsd_profile:AAA",
        reactionType: "PRAISE",
        entityUrn: `urn:li:fsd_reaction:(urn:li:fsd_profile:AAA,${URN},0)`,
        reactorLockup: { title: { text: "From The Body" }, navigationUrl: "https://www.linkedin.com/in/AAA" },
      }],
    });
    const receipt = await make(capture(snapshotHtml(), [body])).run(
      context({ url: PERMALINK, reactions: true }),
    );
    const data = receipt.data as { read: { reactions_source: string; reactions: number }; post: { reactions_total: number } };
    expect(data.read.reactions_source).toBe("voyager");
    expect(data.read.reactions).toBe(1);
    // paging.total is what LinkedIn says; 1013 is what the fixture's label renders.
    expect(data.post.reactions_total).toBe(1052);
  });

  it("falls back to the facepile when the page fetched no reactions body", async () => {
    const receipt = await make(capture()).run(context({ url: PERMALINK, reactions: true }));
    const data = receipt.data as { read: { reactions_source: string; reactions: number }; post: { reactions_total: number } };
    expect(data.read.reactions_source).toBe("dom-snapshot");
    expect(data.read.reactions).toBe(2);
    expect(data.post.reactions_total).toBe(1013);
  });

  it("reads no reactions body at all unless reactions were asked for", async () => {
    // A body with a real, in-scope row: if the default run consulted it at all,
    // the total would move off the rendered label and the source would flip.
    const body = JSON.stringify({
      data: { data: { socialDashReactionsByReactionType: { paging: { total: 1052 } } } },
      included: [{
        $type: "com.linkedin.voyager.dash.social.Reaction",
        actorUrn: "urn:li:fsd_profile:AAA",
        reactionType: "LIKE",
        entityUrn: `urn:li:fsd_reaction:(urn:li:fsd_profile:AAA,${URN},0)`,
        reactorLockup: { title: { text: "Not Read" }, navigationUrl: "https://www.linkedin.com/in/AAA" },
      }],
    });
    const receipt = await make(capture(snapshotHtml(), [body])).run(context({ url: PERMALINK }));
    const data = receipt.data as { read: { reactions: number; reactions_source: string }; post: { reactions_total: number } };
    expect(data.read.reactions).toBe(0);
    // The body was present and deliberately not consulted: D313's default holds.
    expect(data.read.reactions_source).toBe("dom-snapshot");
    expect(data.post.reactions_total).toBe(1013);
  });

  it("names the renderer on the receipt, and parses an Ember snapshot through the same wiring", async () => {
    // The receipt says which app it read (D340). A silent switch is what made
    // the 2026-08-10 gate cost two page loads to diagnose.
    const sdui = await make(capture()).run(context({ url: PERMALINK }));
    expect((sdui.data as { renderer: string }).renderer).toBe("sdui");

    const ember = `<html><body>
      <div class="feed-shared-update-v2" data-urn="${URN}">
        <a class="update-components-actor__meta-link" href="https://www.linkedin.com/in/tankots?miniProfileUrn=x">Tanay Kothari</a>
        <div aria-label="Open control menu for post by Tanay Kothari"></div>
        <div class="update-components-update-v2__commentary">the post body</div>
        <span aria-label="1,049 reactions"></span>
        <span aria-label="73 comments on Tanay Kothari's post"></span>
      </div>
    </body></html>`;
    const receipt = await make(capture(ember)).run(context({ url: PERMALINK }, ember));
    const data = receipt.data as { renderer: string; post: { author_vanity: string; reactions_total: number } };
    expect(data.renderer).toBe("ember");
    expect(data.post.author_vanity).toBe("tankots");
    expect(data.post.reactions_total).toBe(1049);
  });

  it("reads comments only when asked, and states plainly that the read is partial", async () => {
    const cap = make(capture());
    const receipt = await cap.run(context({ url: PERMALINK, comments: true, commentsLimit: 2 }));
    const data = receipt.data as { read: { comments: number; comments_complete: boolean } };
    expect(data.read.comments).toBe(2);
    expect(data.read.comments_complete).toBe(false);
    const partial = (receipt.warnings ?? []).find((w) => w.code === "COMMENTS_PARTIAL");
    expect(partial).toBeDefined();
    expect(partial!.n).toBe(71);
    // And the receipt tells the operator the next read is explicit, never implicit.
    expect(receipt.next).toContain("--comments-limit");
  });

  it("reads reactions only when asked", async () => {
    const cap = make(capture());
    const off = await cap.run(context({ url: PERMALINK, comments: true, commentsLimit: 1 }));
    expect((off.data as { read: { reactions: number } }).read.reactions).toBe(0);
    const on = await cap.run(context({ url: PERMALINK, reactions: true, reactionsLimit: 1 }));
    expect((on.data as { read: { reactions: number } }).read.reactions).toBe(1);
  });

  it("refuses a snapshot of a different post instead of storing it", async () => {
    const other = snapshotHtml({ urn: "urn:li:activity:999" });
    const cap = make(capture(other));
    await expect(cap.run(context({ url: PERMALINK }, other)))
      .rejects.toMatchObject({ code: "POST_GET_IDENTITY_UNRESOLVED", exit: 5 });
  });

  it("fails transiently, not silently, when no snapshot was archived", async () => {
    const noSnap = vi.fn(async () => ({
      snapshotFile: null,
      sessionUrns: [],
      sessionVanities: [],
      result: { counts: { requested: 1, captured: 0, usable: 0, skipped: 0 }, warnings: [], data: {} },
    }));
    const cap = make(noSnap);
    await expect(cap.run(context({ url: PERMALINK })))
      .rejects.toMatchObject({ code: "POST_GET_NO_SNAPSHOT", retryable: true });
  });

  it("tags everything it returns as DOM-sourced", async () => {
    const cap = make(capture());
    const receipt = await cap.run(context({ url: PERMALINK }));
    expect((receipt.data as { source: string }).source).toBe("dom-snapshot");
    expect((receipt.data as { storage: { mode: string } }).storage.mode).toBe("archive-only");
  });
});

const AUTHOR_URN = "urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA";

describe("post.get write path (D330)", () => {
  it("writes exactly one row, keyed on the post urn, when the author resolves", async () => {
    const store = vi.fn(async () => 1);
    const cap = make(capture(), {
      findAuthor: async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }),
      store: store as never,
    });
    const receipt = await cap.run(context({ url: PERMALINK }));

    expect(store).toHaveBeenCalledTimes(1);
    expect((store.mock.calls[0] as unknown as [unknown])[0]).toEqual({
      urn: URN,
      person_urn: AUTHOR_URN,
      text: "the post body",
      posted_at: expect.stringMatching(/^\d{4}-/),
      reactions: 1013,
      comments: 73,
    });
    expect(receipt.stored).toMatchObject({ table: "person_posts", rows: 1 });
    expect(receipt.data).toMatchObject({
      author: { vanity: "tankots", urn: AUTHOR_URN, status: "resolved" },
      storage: { mode: "stored", table: "person_posts", rows: 1 },
    });
    expect(receipt.next).toContain("person_posts");
  });

  it("looks the author up by the exact parsed vanity, and spends no page load doing it", async () => {
    const findAuthor = vi.fn(async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }));
    const cap = make(capture(), { findAuthor, store: (async () => 1) as never });
    await cap.run(context({ url: PERMALINK }));
    expect(findAuthor).toHaveBeenCalledWith("tankots");
    expect(cap.cost({ url: PERMALINK } as never)).toMatchObject({ page_loads: 1, profile_opens: 0 });
  });

  it("does not write when the vanity is ambiguous, and says why (D331)", async () => {
    const store = vi.fn(async () => 1);
    const cap = make(capture(), {
      findAuthor: async () => ({ urn: AUTHOR_URN, vanityMatches: 2 }),
      store: store as never,
    });
    const receipt = await cap.run(context({ url: PERMALINK }));

    expect(store).not.toHaveBeenCalled();
    expect(receipt.stored).toBeUndefined();
    const warning = (receipt.warnings ?? []).find((w) => w.code === "POST_AUTHOR_AMBIGUOUS");
    expect(warning).toBeDefined();
    expect(warning!.n).toBe(2);
    expect(receipt.data).toMatchObject({
      author: { urn: null, status: "ambiguous" },
      storage: { mode: "archive-only" },
    });
  });

  it("does not write and does not fail when the author was never fetched (D332)", async () => {
    const store = vi.fn(async () => 1);
    const cap = make(capture(), { findAuthor: async () => null, store: store as never });
    const receipt = await cap.run(context({ url: PERMALINK }));

    expect(store).not.toHaveBeenCalled();
    const warning = (receipt.warnings ?? []).find((w) => w.code === "POST_AUTHOR_NOT_STORED");
    expect(warning!.field).toContain("tankots");
    expect(receipt.counts).toMatchObject({ usable: 1 });
    expect((receipt.data as { author: { status: string } }).author.status).toBe("not-found");
  });

  it("does not write when the snapshot resolved no author at all", async () => {
    // Two non-session profile links outside the comment and facepile scopes:
    // the parser refuses to name an author, so the write path must too.
    const ambiguousHtml = snapshotHtml().replace(
      "<span>5 reposts</span>",
      "<a href=\"https://www.linkedin.com/in/second-person/\">also</a><span>5 reposts</span>",
    );
    const store = vi.fn(async () => 1);
    const findAuthor = vi.fn(async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }));
    const cap = make(capture(ambiguousHtml), { findAuthor, store: store as never });
    const receipt = await cap.run(context({ url: PERMALINK }, ambiguousHtml));

    expect(findAuthor).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect((receipt.data as { author: { status: string } }).author.status).toBe("no-vanity");
    expect((receipt.warnings ?? []).map((w) => w.code)).toContain("PARSE_AUTHOR_AMBIGUOUS");
  });

  it("touches the store for nothing at all under --no-store", async () => {
    const store = vi.fn(async () => 1);
    const findAuthor = vi.fn(async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }));
    const cap = make(capture(), { findAuthor, store: store as never });
    const ctx = context({ url: PERMALINK }) as unknown as { flags: { noStore: boolean } };
    ctx.flags.noStore = true;
    const receipt = await cap.run(ctx as never);

    expect(findAuthor).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect(receipt.stored).toBeUndefined();
    expect(receipt.data).toMatchObject({
      author: { status: "not-looked-up", urn: null },
      storage: { mode: "archive-only", reason: "--no-store" },
    });
  });

  it("refuses a company-authored post rather than half-storing it", async () => {
    // Task 29's parser resolves `/in/` links only, so a post authored by a
    // company page yields no vanity and therefore no row. That is the safe
    // default, not the finished feature: whether such a permalink even carries
    // the same anchors is unmeasured, and `company_posts` stays untouched until
    // it is (D334).
    const companyAuthored = snapshotHtml()
      .replace("<a href=\"https://www.linkedin.com/in/tankots/\">author</a>",
        "<a href=\"https://www.linkedin.com/company/anthropic/\">author</a>");
    const store = vi.fn(async () => 1);
    const findAuthor = vi.fn(async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }));
    const cap = make(capture(companyAuthored), { findAuthor, store: store as never });
    const receipt = await cap.run(context({ url: PERMALINK }, companyAuthored));

    expect(findAuthor).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
    expect((receipt.data as { author: { status: string } }).author.status).toBe("no-vanity");
    expect((receipt.warnings ?? []).map((w) => w.code)).toContain("PARSE_AUTHOR_UNRESOLVED");
  });

  it("refuses the write when the author resolved but the timestamp did not", async () => {
    // `posted_at` is derived from the activity snowflake; an unparseable one
    // yields null, and the shared projection has no null to put there.
    const overflowed = "urn:li:activity:999999999999999999999999999999";
    const noTime = snapshotHtml({ urn: overflowed });
    const store = vi.fn(async () => 1);
    const cap = make(capture(noTime), {
      findAuthor: async () => ({ urn: AUTHOR_URN, vanityMatches: 1 }),
      store: store as never,
    });
    const receipt = await cap.run(
      context({ url: `https://www.linkedin.com/feed/update/${overflowed}/` }, noTime),
    );
    expect(store).not.toHaveBeenCalled();
    expect((receipt.data as { storage: { reason: string } }).storage.reason).toBe("posted_at unresolved");
  });
});
