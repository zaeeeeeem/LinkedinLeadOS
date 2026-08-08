import { describe, expect, it, vi } from "vitest";

import { createPostGetCapability, DEFAULT_COMMENTS_LIMIT, DEFAULT_REACTIONS_LIMIT } from "./index.js";

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

function capture(html = snapshotHtml()) {
  return vi.fn(async () => ({
    snapshotFile: "0026-abc.json.gz",
    sessionUrns: [],
    sessionVanities: ["zaeem-dev"],
    result: { counts: { requested: 1, captured: 1, usable: 1, skipped: 0 }, warnings: [], data: { snapshot: { archived: "0026-abc.json.gz" } } },
    html,
  }));
}

describe("post.get composition", () => {
  it("costs one page load and opens nobody's profile", () => {
    const cap = createPostGetCapability({ capture: capture() as never });
    expect(cap.cost({ url: PERMALINK } as never)).toMatchObject({ page_loads: 1, profile_opens: 0 });
  });

  it("refuses a non-permalink before spending anything", async () => {
    const spy = capture();
    const cap = createPostGetCapability({ capture: spy as never });
    await expect(cap.run(context({ url: "https://www.linkedin.com/in/tankots/" })))
      .rejects.toMatchObject({ code: "POST_GET_URL_INVALID" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reads the post and nothing else by default — no comments, no reactions", async () => {
    const cap = createPostGetCapability({ capture: capture() as never });
    const receipt = await cap.run(context({ url: PERMALINK }));
    const data = receipt.data as { read: { comments: number; reactions: number }; post: { author_vanity: string } };
    expect(data.read).toMatchObject({ comments: 0, reactions: 0 });
    expect(data.post.author_vanity).toBe("tankots");
    // Nothing was asked for, so nothing is reported partial.
    expect((receipt.warnings ?? []).map((w) => w.code)).not.toContain("COMMENTS_PARTIAL");
    expect((receipt.warnings ?? []).map((w) => w.code)).not.toContain("REACTIONS_PARTIAL");
  });

  it("reads comments only when asked, and states plainly that the read is partial", async () => {
    const cap = createPostGetCapability({ capture: capture() as never });
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
    const cap = createPostGetCapability({ capture: capture() as never });
    const off = await cap.run(context({ url: PERMALINK, comments: true, commentsLimit: 1 }));
    expect((off.data as { read: { reactions: number } }).read.reactions).toBe(0);
    const on = await cap.run(context({ url: PERMALINK, reactions: true, reactionsLimit: 1 }));
    expect((on.data as { read: { reactions: number } }).read.reactions).toBe(1);
  });

  it("refuses a snapshot of a different post instead of storing it", async () => {
    const other = snapshotHtml({ urn: "urn:li:activity:999" });
    const cap = createPostGetCapability({ capture: capture(other) as never });
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
    const cap = createPostGetCapability({ capture: noSnap as never });
    await expect(cap.run(context({ url: PERMALINK })))
      .rejects.toMatchObject({ code: "POST_GET_NO_SNAPSHOT", retryable: true });
  });

  it("tags everything it returns as DOM-sourced", async () => {
    const cap = createPostGetCapability({ capture: capture() as never });
    const receipt = await cap.run(context({ url: PERMALINK }));
    expect((receipt.data as { source: string }).source).toBe("dom-snapshot");
    expect((receipt.data as { storage: { mode: string } }).storage.mode).toBe("archive-only");
  });
});
