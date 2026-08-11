import { describe, expect, it } from "vitest";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { trustedControlExpression } from "../salesnav.probe/pager.js";
import { captureSavedSearches, type SavedSearchCaptureDeps } from "./capture.js";
import { SAVED_ACCOUNT_TAB_CONTROL, SAVED_SEARCHES_CONTROL } from "./control.js";
import { carriesSavedSearchPayload } from "./patterns.js";

function archived(file: string) {
  return {
    seq: 1, id: "capture-1", file, path: `/tmp/${file}`, shapeHash: "shape",
    url: "https://www.linkedin.com/sales-api/salesApiSavedSearchesV2", status: 200,
    capturedAt: "2026-08-11T00:00:00.000Z", bytes: 80,
  };
}

function harness(o: { clickError?: Error } = {}) {
  const events: string[] = [];
  let releases = 0;
  let drains = 0;
  let waits = 0;
  const body = '{"elements":[{"id":1,"name":"SYNTHETIC"}],"paging":{"start":0,"count":1}}';
  const leadCapture = {
    seq: 0, pattern: "salesapi-saved-searches", patterns: ["salesapi-saved-searches", "sales-api-any"],
    requestId: "request-lead", url: "https://www.linkedin.com/sales-api/salesApiSavedSearchesV2",
    status: 200, body, bytes: body.length, archived: archived("0001-lead.json.gz"),
    capturedAt: "2026-08-11T00:00:00.000Z",
  };
  const accountCapture = {
    seq: 1, pattern: "salesapi-saved-searches", patterns: ["salesapi-saved-searches", "sales-api-any"],
    requestId: "request-account", url: "https://www.linkedin.com/sales-api/salesApiSavedSearchesV2",
    status: 200, body, bytes: body.length, archived: archived("0002-account.json.gz"),
    capturedAt: "2026-08-11T00:00:00.000Z",
  };
  const landed: typeof leadCapture[] = [];
  const tap = {
    get cursor() { return landed.length; },
    watch: () => { events.push("watch"); return () => { releases++; }; },
    drain: async () => { events.push("drain"); drains++; },
    captures: () => [...landed],
    misses: () => [],
  };
  const ctx = {
    run: { runId: "RUN", log: () => undefined },
    args: {},
    budget: {
      check: async () => { events.push("check"); },
      spend: async () => { events.push("spend"); },
    },
    browser: {
      tab: {
        ensureForeground: async () => ({ ok: true, via: "already", state: { hidden: false } }),
        navigate: async () => { events.push("navigate"); },
      },
      tap,
      cursor: { pause: async () => 0 },
      archive: {},
    },
  };
  const deps: SavedSearchCaptureDeps = {
    gate: async () => ({ kind: "clean", clean: true, signal: "none", detail: "test" }),
    wait: async () => {
      waits++;
      if (waits === 2) landed.push(leadCapture);
      if (waits === 3) landed.push(accountCapture);
      return waits < 3 ? leadCapture : accountCapture;
    },
    click: async (input) => {
      events.push("click");
      expect([SAVED_SEARCHES_CONTROL, SAVED_ACCOUNT_TAB_CONTROL]).toContainEqual(input.spec);
      if (o.clickError) throw o.clickError;
      return {
        kind: input.spec.label, control: input.spec.label, tag: "button",
        revealPasses: 0, x: 100, y: 50,
      };
    },
    snapshot: async () => ({
      archived: archived("0002-dom.html.gz"), probe: null, rendered: true,
      failure: null, detail: null,
    }),
  };
  return { ctx: ctx as any, deps, events, releases: () => releases, drains: () => drains };
}

describe("salesnav.savedsearch.list capture — spend and cleanup", () => {
  it("spends before navigation and records the exact granted click", async () => {
    const h = harness();
    const result = await captureSavedSearches(h.ctx, h.deps);
    expect(h.events.indexOf("spend")).toBeLessThan(h.events.indexOf("navigate"));
    expect(h.events.indexOf("navigate")).toBeLessThan(h.events.indexOf("click"));
    expect(result.clicks.map((click) => click.kind)).toEqual([
      "saved searches", "saved account searches tab",
    ]);
    expect(result.payloads.map((payload) => payload.vertical)).toEqual(["lead", "account"]);
    expect(h.drains()).toBe(3);
    expect(h.releases()).toBeGreaterThan(0);
  });

  it("drains and releases every watch when the trusted click refuses", async () => {
    const lower = new CapabilityError({
      code: "SAVED_SEARCHES_CONTROL_AMBIGUOUS", exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY", retryable: false, message: "two controls",
    });
    const h = harness({ clickError: lower });
    await expect(captureSavedSearches(h.ctx, h.deps)).rejects.toBe(lower);
    expect(h.drains()).toBeGreaterThanOrEqual(1);
    expect(h.releases()).toBeGreaterThan(0);
  });

  it("recognizes a saved-search body by content, not by endpoint alone", () => {
    const endpoint = "https://www.linkedin.com/sales-api/salesApiSavedSearchesV2?q=test";
    expect(carriesSavedSearchPayload('{"elements":[]}', endpoint)).toBe(true);
    expect(carriesSavedSearchPayload('{"elements":[]}', "https://www.linkedin.com/sales-api/salesApiLists")).toBe(false);
  });

  it("pins the D409 Account tab to the measured button role and full accessible name", () => {
    const expression = trustedControlExpression(SAVED_ACCOUNT_TAB_CONTROL);
    expect(expression).toContain('button[role=\\"tab\\"][aria-label=\\"Account- View all account saved searches\\"]');
    expect(expression).toContain("^account- view all account saved searches$");
    expect(expression).not.toContain(".click()");
  });
});
