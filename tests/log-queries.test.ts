import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RESULT_BYTES,
  listRuns,
  queryDrift,
  queryErrors,
  queryWhy,
} from "../src/core/log/queries.js";
import { CapabilityError } from "../src/core/run/receipt.js";
import type { Receipt } from "../src/core/run/receipt.js";
import type { EventName, EventLevel, LoggedEvent } from "../src/core/run/events.js";
import type { RunMeta } from "../src/core/run/context.js";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "linkedin-os-log-queries-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

// --- test-only run directory builder -----------------------------------
// Writes run.json / events.ndjson / summary.json directly, bypassing
// RunContext entirely, so tests get full control over timestamps and can
// stage corruption RunContext would never itself produce.

type MetaOpt = Partial<RunMeta> | "corrupt" | "absent";
type SummaryOpt = Receipt | "corrupt" | "absent";

function writeRunDir(runId: string, o: { meta?: MetaOpt; events?: string; summary?: SummaryOpt } = {}): string {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });

  const meta = o.meta ?? {};
  if (meta !== "absent") {
    const metaPath = join(dir, "run.json");
    if (meta === "corrupt") {
      writeFileSync(metaPath, '{"run_id": "' + runId + '", "capability":');
    } else {
      const full: RunMeta = {
        run_id: runId,
        capability: "test.capability",
        args: {},
        created_at: new Date().toISOString(),
        resumed_at: [],
        ...meta,
      };
      writeFileSync(metaPath, JSON.stringify(full));
    }
  }

  if (o.events !== undefined) writeFileSync(join(dir, "events.ndjson"), o.events);

  if (o.summary !== undefined && o.summary !== "absent") {
    const summaryPath = join(dir, "summary.json");
    writeFileSync(summaryPath, o.summary === "corrupt" ? '{"ok": true, "run_id"' : JSON.stringify(o.summary));
  }

  return dir;
}

let seq = 0;
function ev(o: { event: EventName; item_ref?: string; level?: EventLevel; ts?: string; detail?: Record<string, unknown> }): string {
  seq += 1;
  const line: LoggedEvent = {
    ts: o.ts ?? new Date().toISOString(),
    run_id: "r",
    seq,
    level: o.level ?? "info",
    event: o.event,
    ...(o.item_ref !== undefined ? { item_ref: o.item_ref } : {}),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  };
  return JSON.stringify(line);
}

function okReceipt(over: Partial<Extract<Receipt, { ok: true }>> = {}): Receipt {
  return {
    ok: true,
    run_id: "r",
    capability: "test.capability",
    counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
    warnings: [],
    cost: { search_credits: 0, page_loads: 0, elapsed_ms: 1 },
    artifacts: { events: "events.ndjson", raw: "raw/" },
    ...over,
  };
}

function errReceipt(over: Partial<{ code: string; exit: 1 | 2 | 3 | 4 | 5 | 6 | 7 }> = {}): Receipt {
  return {
    ok: false,
    run_id: "r",
    capability: "test.capability",
    error: {
      code: over.code ?? "SOMETHING_FAILED",
      exit: over.exit ?? 1,
      retryable: false,
      action: "HALT_AND_NOTIFY",
      message: "it failed",
    },
    cost: { search_credits: 0, page_loads: 0, elapsed_ms: 1 },
  };
}

// -------------------------------------------------------------------------
// queryWhy — per-item filtering, ordered readback, corrupt-line tolerance
// -------------------------------------------------------------------------

describe("queryWhy", () => {
  it("returns only events for the requested item, in the order they were written", () => {
    seq = 0;
    const lines = [
      ev({ event: "capture.hit", item_ref: "lead-1", detail: { n: 1 } }),
      ev({ event: "capture.hit", item_ref: "lead-2", detail: { n: 2 } }),
      ev({ event: "capture.miss", item_ref: "lead-1", level: "warn", detail: { n: 3 } }),
      ev({ event: "capture.hit", item_ref: "lead-1", detail: { n: 4 } }),
    ];
    writeRunDir("run-a", { events: lines.join("\n") + "\n" });

    const result = queryWhy(runsDir, "run-a", "lead-1");
    expect(result.events.map((e) => e.detail?.n)).toEqual([1, 3, 4]);
    // ordered: strictly increasing seq
    const seqs = result.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(result.truncated).toBe(false);
  });

  it("a run that partly succeeded: an item that failed and an item that captured both surface correctly", () => {
    seq = 0;
    const lines = [
      ev({ event: "nav.start" }),
      ev({ event: "capture.hit", item_ref: "lead-ok" }),
      ev({ event: "capture.miss", item_ref: "lead-bad", level: "warn", detail: { reason: "evicted" } }),
      ev({ event: "parse.ok", item_ref: "lead-ok" }),
    ];
    writeRunDir("run-partial", { events: lines.join("\n") + "\n" });

    const ok = queryWhy(runsDir, "run-partial", "lead-ok");
    expect(ok.events.map((e) => e.event)).toEqual(["capture.hit", "parse.ok"]);

    const bad = queryWhy(runsDir, "run-partial", "lead-bad");
    expect(bad.events).toHaveLength(1);
    expect(bad.events[0]?.event).toBe("capture.miss");
    expect(bad.events[0]?.level).toBe("warn");
  });

  it("a run that failed outright: a truncated trailing line does not erase the item's earlier events", () => {
    seq = 0;
    const good = [
      ev({ event: "nav.start", item_ref: "profile-1" }),
      ev({ event: "capture.hit", item_ref: "profile-1" }),
      ev({ event: "error", item_ref: "profile-1", level: "error", detail: { code: "CHALLENGE_PRESENTED" } }),
    ];
    // simulates a process killed mid-write: valid lines, then a partial one with no newline
    const truncated = good.join("\n") + "\n" + '{"ts":"2026-08-08T00:00:00.000Z","run_id":"r","seq":99,"lev';
    writeRunDir("run-killed", { events: truncated });

    const result = queryWhy(runsDir, "run-killed", "profile-1");
    expect(result.events).toHaveLength(3);
    expect(result.events.map((e) => e.event)).toEqual(["nav.start", "capture.hit", "error"]);
  });

  it("an item ref that matches nothing returns an empty list, not an error", () => {
    writeRunDir("run-a", { events: ev({ event: "nav.start", item_ref: "lead-1" }) + "\n" });
    const result = queryWhy(runsDir, "run-a", "lead-does-not-exist");
    expect(result.events).toEqual([]);
  });

  it("an unknown run id is RUN_NOT_FOUND, exit 1", () => {
    expect(() => queryWhy(runsDir, "no-such-run", "lead-1")).toThrow(CapabilityError);
    try {
      queryWhy(runsDir, "no-such-run", "lead-1");
      expect.unreachable();
    } catch (e) {
      expect((e as CapabilityError).code).toBe("RUN_NOT_FOUND");
      expect((e as CapabilityError).exit).toBe(1);
    }
  });

  it("caps at 500 events, keeping the most recent (the tail) when truncated", () => {
    seq = 0;
    const lines: string[] = [];
    for (let i = 0; i < 501; i++) lines.push(ev({ event: "capture.hit", item_ref: "x", detail: { n: i } }));
    writeRunDir("run-big", { events: lines.join("\n") + "\n" });

    const result = queryWhy(runsDir, "run-big", "x");
    expect(result.truncated).toBe(true);
    expect(result.events.length).toBeLessThanOrEqual(500);
    // The tail survives whichever bound bit: the newest event is always present,
    // and the oldest is always the one given up.
    expect(result.events[result.events.length - 1]?.detail?.n).toBe(500);
    expect(result.events[0]?.detail?.n).toBeGreaterThan(0);
    expect(result.dropped).toBe(501 - result.events.length);
  });

  // The bound the count could not express. A live capture's events run ~340
  // bytes; 500 of them serialize to 170KB, which is ~42k tokens on stdout for a
  // capability whose whole purpose is costing hundreds.
  it("stays under the byte budget even when the count bound is never reached", () => {
    seq = 0;
    const wide = { url: "https://www.linkedin.com/in/a-fairly-long-vanity-slug-goes-here/", note: "x".repeat(240) };
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(ev({ event: "capture.hit", item_ref: "x", detail: { i, ...wide } }));
    writeRunDir("run-wide", { events: lines.join("\n") + "\n" });

    const result = queryWhy(runsDir, "run-wide", "x");
    expect(result.events.length).toBeLessThan(400); // the count bound never fired
    expect(JSON.stringify(result.events).length).toBeLessThanOrEqual(MAX_RESULT_BYTES);
    expect(result.truncated).toBe(true);
    expect(result.dropped).toBeGreaterThan(0);
    // Still the tail: the newest event survives, which is what debugging reads first.
    expect(result.events[result.events.length - 1]?.detail?.i).toBe(399);
  });

  it("returns one oversized event rather than nothing at all", () => {
    seq = 0;
    writeRunDir("run-huge", {
      events: ev({ event: "error", item_ref: "x", detail: { blob: "y".repeat(MAX_RESULT_BYTES * 2) } }) + "\n",
    });

    const result = queryWhy(runsDir, "run-huge", "x");
    expect(result.events).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });
});

// -------------------------------------------------------------------------
// queryErrors — warn/error-only filtering
// -------------------------------------------------------------------------

describe("queryErrors", () => {
  it("returns only warn/error-level events, excluding info and debug", () => {
    seq = 0;
    const lines = [
      ev({ event: "nav.start", level: "info" }),
      ev({ event: "capture.miss", level: "warn", detail: { reason: "evicted" } }),
      ev({ event: "render.wait", level: "debug" }),
      ev({ event: "error", level: "error", detail: { code: "CHALLENGE_PRESENTED" } }),
      ev({ event: "capture.hit", level: "info" }),
    ];
    writeRunDir("run-a", { events: lines.join("\n") + "\n" });

    const result = queryErrors(runsDir, "run-a");
    expect(result.events.map((e) => e.event)).toEqual(["capture.miss", "error"]);
  });

  it("a run that partly succeeded still surfaces its warnings alongside a later fatal error", () => {
    seq = 0;
    const lines = [
      ev({ event: "capture.hit", item_ref: "lead-1", level: "info" }),
      ev({ event: "capture.miss", item_ref: "lead-2", level: "warn" }),
      ev({ event: "capture.hit", item_ref: "lead-3", level: "info" }),
      ev({ event: "error", level: "error", detail: { code: "BUDGET_EXCEEDED" } }),
    ];
    writeRunDir("run-partial", { events: lines.join("\n") + "\n" });

    const result = queryErrors(runsDir, "run-partial");
    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.event).toBe("capture.miss");
    expect(result.events[1]?.event).toBe("error");
  });

  it("a truncated trailing line does not erase the real errors written before it", () => {
    seq = 0;
    const good = [ev({ event: "error", level: "error", detail: { code: "SESSION_DEAD" } })];
    const truncated = good.join("\n") + "\n" + '{"ts":"2026-08-08T00:00:00.000Z","seq":2,"lev';
    writeRunDir("run-killed", { events: truncated });

    const result = queryErrors(runsDir, "run-killed");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.detail?.code).toBe("SESSION_DEAD");
  });

  it("a clean run with no warn/error events returns an empty list", () => {
    seq = 0;
    writeRunDir("run-clean", { events: ev({ event: "nav.start", level: "info" }) + "\n" });
    const result = queryErrors(runsDir, "run-clean");
    expect(result.events).toEqual([]);
  });

  it("an unknown run id is RUN_NOT_FOUND, exit 1", () => {
    expect(() => queryErrors(runsDir, "no-such-run")).toThrow(CapabilityError);
  });
});

// -------------------------------------------------------------------------
// listRuns — since-window filtering, status derivation, corrupt tolerance
// -------------------------------------------------------------------------

describe("listRuns", () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.parse("2026-08-08T12:00:00.000Z");

  it("includes a run inside the window and excludes one outside it", () => {
    writeRunDir("run-recent", {
      meta: { created_at: new Date(now - HOUR).toISOString() },
      summary: okReceipt(),
    });
    writeRunDir("run-old", {
      meta: { created_at: new Date(now - 30 * HOUR).toISOString() },
      summary: okReceipt(),
    });

    const { runs } = listRuns(runsDir, { sinceMs: 24 * HOUR, now });
    expect(runs.map((r) => r.run_id)).toEqual(["run-recent"]);
  });

  it("a run resumed recently counts as active even if created long ago", () => {
    writeRunDir("run-resumed", {
      meta: {
        created_at: new Date(now - 100 * HOUR).toISOString(),
        resumed_at: [new Date(now - HOUR).toISOString()],
      },
      summary: okReceipt(),
    });

    const { runs } = listRuns(runsDir, { sinceMs: 24 * HOUR, now });
    expect(runs.map((r) => r.run_id)).toEqual(["run-resumed"]);
  });

  it("sorts most-recently-active first", () => {
    writeRunDir("run-a", { meta: { created_at: new Date(now - 3 * HOUR).toISOString() }, summary: okReceipt() });
    writeRunDir("run-b", { meta: { created_at: new Date(now - 1 * HOUR).toISOString() }, summary: okReceipt() });
    writeRunDir("run-c", { meta: { created_at: new Date(now - 2 * HOUR).toISOString() }, summary: okReceipt() });

    const { runs } = listRuns(runsDir, { now });
    expect(runs.map((r) => r.run_id)).toEqual(["run-b", "run-c", "run-a"]);
  });

  it("derives status ok / error / incomplete from summary.json", () => {
    writeRunDir("run-ok", { meta: { created_at: new Date(now).toISOString() }, summary: okReceipt() });
    writeRunDir("run-err", {
      meta: { created_at: new Date(now).toISOString() },
      summary: errReceipt({ code: "CHALLENGE_PRESENTED", exit: 2 }),
    });
    writeRunDir("run-incomplete", { meta: { created_at: new Date(now).toISOString() } });

    const { runs } = listRuns(runsDir, { now });
    const byId = Object.fromEntries(runs.map((r) => [r.run_id, r]));
    expect(byId["run-ok"]?.status).toBe("ok");
    expect(byId["run-err"]?.status).toBe("error");
    expect(byId["run-err"]?.error_code).toBe("CHALLENGE_PRESENTED");
    expect(byId["run-err"]?.exit).toBe(2);
    expect(byId["run-incomplete"]?.status).toBe("incomplete");
  });

  it("a corrupt run.json is always surfaced, with no timestamp, bypassing the time filter", () => {
    writeRunDir("run-corrupt", { meta: "corrupt" });
    writeRunDir("run-old-and-fine", {
      meta: { created_at: new Date(now - 1000 * HOUR).toISOString() },
      summary: okReceipt(),
    });

    const { runs } = listRuns(runsDir, { sinceMs: HOUR, now });
    expect(runs.map((r) => r.run_id)).toEqual(["run-corrupt"]);
    expect(runs[0]?.status).toBe("corrupt");
    expect(runs[0]?.last_activity).toBeNull();
  });

  it("a corrupt summary.json reports status corrupt rather than throwing", () => {
    writeRunDir("run-bad-summary", { meta: { created_at: new Date(now).toISOString() }, summary: "corrupt" });
    const { runs } = listRuns(runsDir, { now });
    expect(runs[0]?.status).toBe("corrupt");
  });

  it("an empty or missing runs directory returns an empty list, not an error", () => {
    const { runs } = listRuns(join(runsDir, "does-not-exist"));
    expect(runs).toEqual([]);
  });

  it("ignores non-run entries under runs/ (budget.ndjson, tab.lock)", () => {
    writeFileSync(join(runsDir, "budget.ndjson"), "{}\n");
    writeFileSync(join(runsDir, "tab.lock"), "{}");
    writeRunDir("run-a", { meta: { created_at: new Date(now).toISOString() }, summary: okReceipt() });

    const { runs } = listRuns(runsDir, { now });
    expect(runs.map((r) => r.run_id)).toEqual(["run-a"]);
  });

  it("caps at 200 runs, keeping the most recently active", () => {
    for (let i = 0; i < 201; i++) {
      writeRunDir(`run-${String(i).padStart(3, "0")}`, {
        meta: { created_at: new Date(now - i * 1000).toISOString() },
        summary: okReceipt(),
      });
    }
    const { runs, truncated, dropped } = listRuns(runsDir, { now });
    expect(truncated).toBe(true);
    expect(runs.length).toBeLessThanOrEqual(200);
    // the most recent (i=0) survives; the oldest (i=200) was dropped
    expect(runs[0]?.run_id).toBe("run-000");
    expect(runs.some((r) => r.run_id === "run-200")).toBe(false);
    expect(dropped).toBe(201 - runs.length);
  });
});

// -------------------------------------------------------------------------
// queryDrift — parse.miss grouped by capability and field
// -------------------------------------------------------------------------

describe("queryDrift", () => {
  const now = Date.parse("2026-08-08T12:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;

  it("groups parse.miss events by capability and field, counted", () => {
    seq = 0;
    const events = [
      ev({ event: "parse.miss", detail: { field: "headline" }, ts: new Date(now).toISOString() }),
      ev({ event: "parse.miss", detail: { field: "headline" }, ts: new Date(now).toISOString() }),
      ev({ event: "parse.miss", detail: { field: "location" }, ts: new Date(now).toISOString() }),
      ev({ event: "parse.ok", ts: new Date(now).toISOString() }), // not drift, ignored
    ].join("\n") + "\n";
    writeRunDir("run-a", { meta: { capability: "profile.get" }, events });

    const { groups } = queryDrift(runsDir, { now });
    expect(groups).toEqual([
      { capability: "profile.get", field: "headline", count: 2 },
      { capability: "profile.get", field: "location", count: 1 },
    ]);
  });

  it("groups across multiple runs and multiple capabilities separately", () => {
    seq = 0;
    writeRunDir("run-a", {
      meta: { capability: "profile.get" },
      events: ev({ event: "parse.miss", detail: { field: "headline" }, ts: new Date(now).toISOString() }) + "\n",
    });
    writeRunDir("run-b", {
      meta: { capability: "company.get" },
      events: ev({ event: "parse.miss", detail: { field: "headline" }, ts: new Date(now).toISOString() }) + "\n",
    });

    const { groups } = queryDrift(runsDir, { now });
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.capability).sort()).toEqual(["company.get", "profile.get"]);
  });

  it("respects the since window on the event's own timestamp", () => {
    seq = 0;
    const events = [
      ev({ event: "parse.miss", detail: { field: "old" }, ts: new Date(now - 10 * DAY).toISOString() }),
      ev({ event: "parse.miss", detail: { field: "recent" }, ts: new Date(now - 1 * DAY).toISOString() }),
    ].join("\n") + "\n";
    writeRunDir("run-a", { events });

    const { groups } = queryDrift(runsDir, { sinceMs: 7 * DAY, now });
    expect(groups.map((g) => g.field)).toEqual(["recent"]);
  });

  it("falls back to (unknown) for an event missing detail.field, and (unknown) capability for a corrupt run.json", () => {
    seq = 0;
    writeRunDir("run-no-field", {
      events: ev({ event: "parse.miss", ts: new Date(now).toISOString() }) + "\n",
    });
    writeRunDir("run-bad-meta", {
      meta: "corrupt",
      events: ev({ event: "parse.miss", detail: { field: "headline" }, ts: new Date(now).toISOString() }) + "\n",
    });

    const { groups } = queryDrift(runsDir, { now });
    expect(groups).toContainEqual({ capability: "test.capability", field: "(unknown)", count: 1 });
    expect(groups).toContainEqual({ capability: "(unknown)", field: "headline", count: 1 });
  });

  it("no runs and no parse.miss events return an empty group list, not an error", () => {
    const { groups } = queryDrift(runsDir, { now });
    expect(groups).toEqual([]);
  });

  it("caps at 200 groups, keeping the highest counts", () => {
    seq = 0;
    const lines: string[] = [];
    for (let i = 0; i < 201; i++) {
      // field "f000" gets 202 hits (the clear top); f001..f200 get one each
      lines.push(ev({ event: "parse.miss", detail: { field: "f000" }, ts: new Date(now).toISOString() }));
      lines.push(ev({ event: "parse.miss", detail: { field: `f${String(i).padStart(3, "0")}` }, ts: new Date(now).toISOString() }));
    }
    writeRunDir("run-big", { events: lines.join("\n") + "\n" });

    const { groups, truncated } = queryDrift(runsDir, { now });
    expect(truncated).toBe(true);
    expect(groups).toHaveLength(200);
    expect(groups[0]).toEqual({ capability: "test.capability", field: "f000", count: 202 });
  });
});
