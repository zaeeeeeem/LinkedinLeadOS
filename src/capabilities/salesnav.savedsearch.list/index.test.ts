import { describe, expect, it } from "vitest";
import { createSavedSearchListCapability } from "./index.js";

describe("salesnav.savedsearch.list — probe-first composition", () => {
  it("declares one page load and zero search/profile spend", () => {
    expect(createSavedSearchListCapability().cost({})).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 0,
    });
  });

  it("records the granted click on the receipt while withholding rows before the real fixture", async () => {
    const capability = createSavedSearchListCapability({
      capture: async () => ({
        payloads: [{ file: "0001.json.gz", bytes: 80, patterns: ["salesapi-saved-searches"] }],
        snapshot: null,
        summary: {
          patterns: [], captured: 1, profile_ish: 1, unmatched_profile_ish: 0, misses: 0,
          endpoints: [],
        },
        click: {
          kind: "saved searches", control: "Saved searches", tag: "button",
          revealPasses: 0, x: 100, y: 50,
        },
        warnings: [],
        foreground: { ok: true, via: "already" },
      }),
    });
    const result = await capability.run({
      args: {},
      run: {
        runId: "RUN", paths: { raw: "/tmp/raw" }, log: () => undefined,
        artifacts: () => ({ run: "runs/RUN" }),
      },
    } as any);
    expect(result.counts).toEqual({ requested: 0, captured: 1, usable: 0, skipped: 0 });
    expect(result.data).toMatchObject({
      read: { saved_searches: null },
      click: { kind: "saved searches", control: "Saved searches" },
      storage: { mode: "archive-only-pending-decision" },
    });
  });
});

