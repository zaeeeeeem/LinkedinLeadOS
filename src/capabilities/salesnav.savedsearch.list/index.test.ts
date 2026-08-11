import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSavedSearchListCapability } from "./index.js";
import type { SavedSearchCaptureResult } from "./capture.js";

const lead = readFileSync(join(import.meta.dirname, "test-fixtures", "saved-leads.synthetic.json"), "utf8");
const account = readFileSync(join(import.meta.dirname, "test-fixtures", "saved-accounts.synthetic.json"), "utf8");

function captured(payloads: SavedSearchCaptureResult["payloads"] = [
  { file: "0001-leads.json.gz", bytes: lead.length, patterns: ["salesapi-saved-searches"], vertical: "lead" },
  { file: "0002-accounts.json.gz", bytes: account.length, patterns: ["salesapi-saved-searches"], vertical: "account" },
]): SavedSearchCaptureResult {
  return {
    payloads, snapshot: null,
    summary: { patterns: [], captured: 2, profile_ish: 2, unmatched_profile_ish: 0, misses: 0, endpoints: [] },
    clicks: [
      { kind: "saved searches", control: "Saved searches", tag: "button", revealPasses: 0, x: 100, y: 50 },
      { kind: "saved account searches tab", control: "saved account searches tab", tag: "button", revealPasses: 0, x: 100, y: 50 },
    ],
    warnings: [], foreground: { ok: true, via: "already" },
  };
}

function context() {
  return {
    args: {}, flags: { noStore: false },
    run: {
      runId: "RUN", paths: { raw: "/runs/RUN/raw" }, log: vi.fn(),
      artifacts: () => ({ run: "runs/RUN" }),
    },
    browser: { archive: { readText: vi.fn(async (file: string) => file.includes("leads") ? lead : account) } },
  } as any;
}

describe("salesnav.savedsearch.list — composition", () => {
  it("declares one page load and zero search/profile spend", () => {
    expect(createSavedSearchListCapability().cost({})).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 0,
    });
  });

  it("lists both verticals and records both trusted clicks without writing storage", async () => {
    const ctx = context();
    const result = await createSavedSearchListCapability({ capture: async () => captured() }).run(ctx);
    expect(result.counts).toEqual({ requested: 2, captured: 2, usable: 2, skipped: 0 });
    expect(result.data).toMatchObject({
      source: "sales-api-body",
      read: { saved_searches: 2, lead: 1, account: 1 },
      clicks: [
        { kind: "saved searches", control: "Saved searches" },
        { kind: "saved account searches tab" },
      ],
      storage: { mode: "deferred-to-first-execution", rows: 0 },
    });
    expect(ctx.browser.archive.readText).toHaveBeenCalledTimes(2);
  });

  it("permits operator labels but strips third-party filter and keyword values from receipt and logs", async () => {
    const ctx = context();
    const result = await createSavedSearchListCapability({ capture: async () => captured() }).run(ctx);
    const serialized = JSON.stringify({ result, logs: ctx.run.log.mock.calls });
    expect(serialized).toContain("SYNTHETIC_OPERATOR_LEAD_SEARCH");
    expect(serialized).toContain("SYNTHETIC_OPERATOR_ACCOUNT_SEARCH");
    for (const secret of [
      "SYNTHETIC_THIRD_PARTY_TITLE", "SYNTHETIC_THIRD_PARTY_INDUSTRY",
      "SYNTHETIC_THIRD_PARTY_KEYWORD",
    ]) expect(serialized).not.toContain(secret);
  });

  it("accepts a measured empty envelope but refuses absent/unparseable labeled bodies", async () => {
    const emptyCtx = context();
    emptyCtx.browser.archive.readText.mockResolvedValue('{"elements":[],"paging":{"count":0}}');
    const empty = await createSavedSearchListCapability({ capture: async () => captured([
      { file: "empty.json.gz", bytes: 37, patterns: ["salesapi-saved-searches"], vertical: "lead" },
    ]) }).run(emptyCtx);
    expect(empty.data).toMatchObject({ read: { saved_searches: 0 }, searches: [] });

    const badCtx = context();
    badCtx.browser.archive.readText.mockResolvedValue("{}");
    await expect(createSavedSearchListCapability({ capture: async () => captured() }).run(badCtx))
      .rejects.toMatchObject({ code: "SAVED_SEARCH_LIST_NO_LABELED_PAYLOAD", exit: 5 });
  });
});
