import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCapabilities } from "../src/cli/registry.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute } from "../src/cli/run.js";
import type { AnyCapability } from "../src/cli/types.js";

/**
 * Exercises the four log-query capabilities through the real `execute()`
 * pipeline — registry lookup, args validation, `RunContext`, receipt
 * assembly — not just their `run()` bodies in isolation. `needsBrowser:
 * false` means `preflight` never opens a session or takes a lease (see
 * `preflight.ts`), so this proves the whole path with no fake browser deps
 * and no Chrome required, which is also the first place `execute()` and
 * `core/log/queries.ts` are proven to compose (CONTEXT.md's fourth shape).
 */

let runsDir: string;
let budgetPath: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "linkedin-os-log-cap-runs-"));
  budgetPath = join(mkdtempSync(join(tmpdir(), "linkedin-os-log-cap-budget-")), "budget.ndjson");
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function seedRun(runId: string, o: { capability?: string; createdAt?: string; events?: string; summary?: unknown }): void {
  const dir = join(runsDir, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      run_id: runId,
      capability: o.capability ?? "seed.capability",
      args: {},
      created_at: o.createdAt ?? new Date().toISOString(),
      resumed_at: [],
    }),
  );
  if (o.events !== undefined) writeFileSync(join(dir, "events.ndjson"), o.events);
  if (o.summary !== undefined) writeFileSync(join(dir, "summary.json"), JSON.stringify(o.summary));
}

function evLine(o: { seq: number; event: string; item_ref?: string; level?: string; detail?: Record<string, unknown> }): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    run_id: "seed",
    seq: o.seq,
    level: o.level ?? "info",
    event: o.event,
    ...(o.item_ref !== undefined ? { item_ref: o.item_ref } : {}),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  });
}

async function loadOne(name: string): Promise<AnyCapability> {
  const registry = await loadCapabilities();
  return registry.get(name);
}

describe("registry integration", () => {
  it("scans src/capabilities and finds all four log-query capabilities", async () => {
    const registry = await loadCapabilities();
    const names = registry.all().map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["log.runs", "log.why", "log.errors", "log.drift"]));
  });

  it.each(["log.runs", "log.why", "log.errors", "log.drift"])("%s is local, needs no browser, costs nothing", async (name) => {
    const def = await loadOne(name);
    expect(def.risk).toBe("local");
    expect(def.needsBrowser).toBe(false);
    expect(def.needsAuth).toBeFalsy();
    expect(def.cost({})).toEqual({ page_loads: 0, search_pages: 0, profile_opens: 0 });
  });
});

describe("log.runs end to end", () => {
  it("lists a seeded run through the real execute() pipeline", async () => {
    seedRun("seeded-run", {
      capability: "profile.get",
      summary: {
        ok: true,
        run_id: "seeded-run",
        capability: "profile.get",
        counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
        warnings: [],
        cost: { search_credits: 0, page_loads: 1, elapsed_ms: 10 },
        artifacts: { events: "events.ndjson", raw: "raw/" },
      },
    });

    const def = await loadOne("log.runs");
    const { receipt } = await execute({
      def,
      rawArgs: { since: "24h" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const data = receipt.data as { runs: Array<{ run_id: string; status: string }> };
    const ids = data.runs.map((r) => r.run_id);
    expect(ids).toContain("seeded-run");
    // this invocation's own run is also visible, mid-run — it has not
    // written its own summary.json yet at the moment log.runs scans.
    expect(data.runs.find((r) => r.run_id === receipt.run_id)?.status).toBe("incomplete");
  });

  it("rejects an unparseable --since as a usage error, not a silent default", async () => {
    const def = await loadOne("log.runs");
    const { receipt } = await execute({
      def,
      rawArgs: { since: "7 days" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("INVALID_DURATION");
    expect(receipt.error.exit).toBe(1);
  });
});

describe("log.why end to end", () => {
  it("returns one item's events from a seeded run", async () => {
    const events = [
      evLine({ seq: 1, event: "capture.hit", item_ref: "lead-1" }),
      evLine({ seq: 2, event: "capture.hit", item_ref: "lead-2" }),
      evLine({ seq: 3, event: "parse.ok", item_ref: "lead-1" }),
    ].join("\n") + "\n";
    seedRun("run-with-items", { events });

    const def = await loadOne("log.why");
    const { receipt } = await execute({
      def,
      rawArgs: { run: "run-with-items", item: "lead-1" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const data = receipt.data as { events: Array<{ event: string }> };
    expect(data.events.map((e) => e.event)).toEqual(["capture.hit", "parse.ok"]);
  });

  it("maps an unknown --run to RUN_NOT_FOUND, exit 1, through the receipt", async () => {
    const def = await loadOne("log.why");
    const { receipt } = await execute({
      def,
      rawArgs: { run: "no-such-run", item: "lead-1" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("RUN_NOT_FOUND");
    expect(receipt.error.exit).toBe(1);
  });

  it("rejects a call missing --item as ARGS_INVALID", async () => {
    const def = await loadOne("log.why");
    const { receipt } = await execute({
      def,
      rawArgs: { run: "run-with-items" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("ARGS_INVALID");
  });
});

describe("log.errors end to end", () => {
  it("returns warn/error events from a seeded run that partly succeeded", async () => {
    const events = [
      evLine({ seq: 1, event: "capture.hit", level: "info" }),
      evLine({ seq: 2, event: "capture.miss", level: "warn", detail: { reason: "evicted" } }),
      evLine({ seq: 3, event: "error", level: "error", detail: { code: "SESSION_DEAD" } }),
    ].join("\n") + "\n";
    seedRun("run-mixed", { events });

    const def = await loadOne("log.errors");
    const { receipt } = await execute({
      def,
      rawArgs: { run: "run-mixed" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const data = receipt.data as { events: Array<{ event: string; level: string }> };
    expect(data.events.map((e) => e.event)).toEqual(["capture.miss", "error"]);
  });
});

describe("log.drift end to end", () => {
  it("groups parse.miss events by capability and field from seeded runs", async () => {
    seedRun("run-a", {
      capability: "profile.get",
      events: evLine({ seq: 1, event: "parse.miss", detail: { field: "headline" } }) + "\n",
    });
    seedRun("run-b", {
      capability: "profile.get",
      events: evLine({ seq: 1, event: "parse.miss", detail: { field: "headline" } }) + "\n",
    });

    const def = await loadOne("log.drift");
    const { receipt } = await execute({
      def,
      rawArgs: { since: "7d" },
      flags: DEFAULT_FLAGS,
      runsDir,
      budgetPath,
    });

    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const data = receipt.data as { groups: Array<{ capability: string; field: string; count: number }> };
    expect(data.groups).toContainEqual({ capability: "profile.get", field: "headline", count: 2 });
  });
});
