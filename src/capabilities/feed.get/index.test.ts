import { describe, expect, it, vi } from "vitest";

import { createFeedGetCapability } from "./index.js";
import { DEFAULT_FEED_LIMIT, MAX_FEED_PASSES } from "./constants.js";
import type { FeedCaptureResult } from "./capture.js";

/** The smallest snapshot that satisfies every anchor the parser resolves on. */
function snapshotHtml(cards = 2): string {
  const rows = Array.from({ length: cards }, (_, i) =>
    `<div><div componentkey="expandedTRACK${i}FeedType_MAIN_FEED_RELEVANCE">` +
    `<div componentkey="TRACK${i}">` +
    `<button aria-label="Open control menu for post by Person ${i}"></button>` +
    `<a href="https://www.linkedin.com/in/person-${i}/">` +
    `<svg aria-label="View Person ${i}’s profile"></svg></a>` +
    `<span data-testid="expandable-text-box">body ${i}</span>` +
    `<span>${i} reactions</span>` +
    `</div></div></div>`,
  ).join("");
  return `<html><body><div data-testid="mainFeed">${rows}</div></body></html>`;
}

function captureResult(o: { archived?: string | null; html?: string } = {}): FeedCaptureResult {
  const html = o.html ?? snapshotHtml();
  const archived = o.archived === undefined ? "0026-abc.json.gz" : o.archived;
  return {
    snapshot: archived === null
      ? { archived: null, probe: null, rendered: false, failure: "probe-failed", detail: "no" }
      : {
          archived: { file: archived, bytes: html.length } as never,
          probe: { html, htmlChars: html.length, textChars: 10, container: null } as never,
          rendered: true,
          failure: null,
          detail: null,
        },
    reading: null,
    summary: {
      captured: 26, profile_ish: 2, unmatched_profile_ish: 1, misses: 0,
      patterns: [
        { name: "gql-feed-updates", tier: "specific", hits: 0, profile_ish: 0, misses: 0 },
        // The document watch is `specific` too and always hits. It is not a
        // feed endpoint, and counting it would report "1" on a run where no
        // feed endpoint answered — the exact claim D280 makes.
        { name: "feed-document", tier: "specific", hits: 1, profile_ish: 1, misses: 0 },
      ],
      endpoints: [],
    } as never,
    sessionUrns: ["urn:li:fsd_profile:OPERATOR"],
    sessionVanities: ["zaeem-dev"],
    bodySweep: { inventoried: 2, notInventoried: 0, inventory: { distinct: {}, total: {}, truncated: [] } },
    warnings: [{ code: "PATTERN_MISMATCH", n: 1, field: "x" }],
    foreground: { ok: true, via: "already" },
  };
}

function context(args: Record<string, unknown> = {}, html = snapshotHtml()) {
  return {
    args: { limit: DEFAULT_FEED_LIMIT, ...args },
    flags: { noStore: false },
    run: { runId: "run", log: vi.fn(), paths: { raw: "/runs/run/raw" }, artifacts: () => ({}) },
    browser: {
      tap: { stats: () => ({ captures: 26 }) },
      archive: { readText: async () => html },
    },
  } as never;
}

describe("feed.get — composition", () => {
  it("costs one page load and never a profile open or a search page", () => {
    // A feed is other people's content, but no profile is visited to read it.
    // Zero is an assertion: a spend of either kind under this name is exit 7.
    expect(createFeedGetCapability().cost({} as never)).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 0,
    });
  });

  it("derives a bounded pass count from --limit and never seeks the bottom", async () => {
    const passes: Array<{ passes: number }> = [];
    const capture = vi.fn(async (_ctx: never, o: { passes: number }) => {
      passes.push(o);
      return captureResult();
    });
    await createFeedGetCapability({ capture } as never).run(context({ limit: 100 }));
    expect(passes[0]).toEqual({ passes: MAX_FEED_PASSES });
  });

  it("passes an explicit --scrolls through as the instruction it is", async () => {
    const passes: Array<{ passes: number }> = [];
    const capture = vi.fn(async (_ctx: never, o: { passes: number }) => {
      passes.push(o);
      return captureResult();
    });
    await createFeedGetCapability({ capture } as never).run(context({ limit: 100, scrolls: 2 }));
    expect(passes[0]).toEqual({ passes: 2 });
  });

  it("parses the archived bytes, not the live probe html", async () => {
    // The probe html is what the page returned; the archive is what was written.
    // Raw-first means the parser reads the second (D2).
    const readText = vi.fn(async () => snapshotHtml(2));
    const ctx = context();
    (ctx as { browser: { archive: { readText: unknown } } }).browser.archive.readText = readText;
    const capture = vi.fn(async () => captureResult({ html: snapshotHtml(5) }));
    const r = await createFeedGetCapability({ capture }).run(ctx);
    expect(readText).toHaveBeenCalledWith("0026-abc.json.gz");
    expect((r.data as { items: unknown[] }).items).toHaveLength(2);
  });

  it("carries the capture's warnings and the parse's onto one receipt", async () => {
    const capture = vi.fn(async () => captureResult());
    const r = await createFeedGetCapability({ capture }).run(context({ limit: 10 }));
    const codes = (r.warnings ?? []).map((w) => w.code);
    expect(codes).toContain("PATTERN_MISMATCH");
    expect(codes).toContain("FEED_PARTIAL");
  });

  it("reports the read as partial and states archive-only storage", async () => {
    const capture = vi.fn(async () => captureResult());
    const r = await createFeedGetCapability({ capture }).run(context());
    const data = r.data as { read: { partial: boolean }; storage: { mode: string }; source: string };
    expect(data.read.partial).toBe(true);
    expect(data.storage.mode).toBe("archive-only");
    expect(data.source).toBe("dom-snapshot");
  });

  it("keeps the measurement on the receipt so it cannot go stale unnoticed", async () => {
    // D325's condition: the probe still measures, every run.
    const capture = vi.fn(async () => captureResult());
    const r = await createFeedGetCapability({ capture }).run(context());
    const probe = (r.data as { probe: { feed_api_pattern_hits: number; feed_ish_bodies: number } }).probe;
    expect(probe.feed_api_pattern_hits).toBe(0);
    expect(probe.feed_ish_bodies).toBe(2);
  });

  it("carries no post text onto the receipt, only its length", async () => {
    const capture = vi.fn(async () => captureResult());
    const r = await createFeedGetCapability({ capture }).run(context());
    const items = (r.data as { items: Array<Record<string, unknown>> }).items;
    expect(items.every((i) => !("text" in i))).toBe(true);
    expect(items[0]!["text_chars"]).toBe(6);
  });

  it("refuses transiently when the capture archived no snapshot", async () => {
    const capture = vi.fn(async () => captureResult({ archived: null }));
    await expect(createFeedGetCapability({ capture }).run(context())).rejects.toMatchObject({
      code: "FEED_GET_NO_SNAPSHOT",
      exit: 6,
    });
  });

  it("records parse drift when the archived snapshot has no feed container", async () => {
    const capture = vi.fn(async () => captureResult());
    const ctx = context({}, "<html><body><main></main></body></html>");
    await expect(createFeedGetCapability({ capture }).run(ctx)).rejects.toMatchObject({
      code: "FEED_GET_CONTAINER_MISSING",
      exit: 5,
    });
  });

  it("lets a lower-layer failure through rather than reclassifying it", async () => {
    const capture = vi.fn(async () => {
      throw Object.assign(new Error("challenge"), { code: "CHALLENGE_DETECTED", exit: 2 });
    });
    await expect(createFeedGetCapability({ capture }).run(context())).rejects.toMatchObject({
      code: "CHALLENGE_DETECTED",
      exit: 2,
    });
  });
});
