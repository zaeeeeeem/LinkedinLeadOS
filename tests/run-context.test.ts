import {
  existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunContext } from "../src/core/run/context.js";
import { readEvents } from "../src/core/run/events.js";
import { EXIT } from "../src/core/run/receipt.js";

let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), "linkedin-os-runs-"));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

describe("RunContext.open — create", () => {
  it("mints a run id, creates raw/ and shots/, and writes run.json", () => {
    const ctx = RunContext.open({ capability: "health.check", args: { a: 1 }, runsDir });

    expect(ctx.resumed).toBe(false);
    expect(existsSync(ctx.paths.raw)).toBe(true);
    expect(existsSync(ctx.paths.shots)).toBe(true);
    expect(existsSync(ctx.paths.meta)).toBe(true);

    const meta = JSON.parse(readFileSync(ctx.paths.meta, "utf8"));
    expect(meta.capability).toBe("health.check");
    expect(meta.args).toEqual({ a: 1 });
    expect(meta.run_id).toBe(ctx.runId);
    expect(meta.resumed_at).toEqual([]);
    expect(typeof meta.created_at).toBe("string");
  });

  it("run ids are unique across opens", () => {
    const a = RunContext.open({ capability: "health.check", runsDir });
    const b = RunContext.open({ capability: "health.check", runsDir });
    expect(a.runId).not.toBe(b.runId);
  });
});

describe("event logging via RunContext", () => {
  it("writes one JSON object per line with ts/run_id/seq/level/event, strictly increasing seq", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    ctx.log("nav.start");
    ctx.log("nav.done", { detail: { url: "x" } });
    ctx.log("capture.hit");

    const events = readEvents(ctx.paths.events);
    expect(events.length).toBe(3);
    let lastSeq = 0;
    for (const e of events) {
      expect(typeof e.ts).toBe("string");
      expect(e.run_id).toBe(ctx.runId);
      expect(typeof e.seq).toBe("number");
      expect(e.seq).toBeGreaterThan(lastSeq);
      lastSeq = e.seq;
      expect(typeof e.level).toBe("string");
      expect(typeof e.event).toBe("string");
    }
  });

  it("defaults level to info", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const logged = ctx.log("nav.start");
    expect(logged.level).toBe("info");
  });

  it("respects an explicit level", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const logged = ctx.log("error", { level: "error" });
    expect(logged.level).toBe("error");
  });

  it("rejects an event name outside the closed set", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    expect(() => ctx.log("not.a.real.event" as never)).toThrow();
  });
});

describe("checkpoint", () => {
  it("round-trips arbitrary nested JSON state", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const state = { page: 3, cursor: "urn:li:abc", nested: { a: [1, 2, 3], b: null } };
    ctx.checkpoint(state);
    expect(ctx.lastCheckpoint()).toEqual(state);
  });

  it("returns null when there is no checkpoint yet", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    expect(ctx.lastCheckpoint()).toBeNull();
  });

  it("latest checkpoint wins", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    ctx.checkpoint({ page: 1 });
    ctx.checkpoint({ page: 2 });
    ctx.checkpoint({ page: 3 });
    expect(ctx.lastCheckpoint()).toEqual({ page: 3 });
  });

  it("logs a checkpoint.save event", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    ctx.checkpoint({ page: 1 });
    const events = readEvents(ctx.paths.events);
    expect(events.some((e) => e.event === "checkpoint.save")).toBe(true);
  });
});

describe("resume", () => {
  it("reuses the directory, sees the prior checkpoint, marks resumed, continues seq", () => {
    const first = RunContext.open({ capability: "health.check", args: { x: 1 }, runsDir });
    first.checkpoint({ page: 2 });
    first.log("nav.start");
    first.log("nav.done");
    const seqBefore = first.log("capture.hit").seq;
    first.finish({
      ok: true, run_id: first.runId, capability: "health.check",
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      warnings: [], cost: { search_credits: 0, page_loads: 0, elapsed_ms: 1 },
      artifacts: first.artifacts(),
    });

    const second = RunContext.open({ capability: "health.check", runId: first.runId, runsDir });
    expect(second.resumed).toBe(true);
    expect(second.dir).toBe(first.dir);
    expect(second.lastCheckpoint()).toEqual({ page: 2 });

    const logged = second.log("nav.start");
    expect(logged.seq).toBeGreaterThan(seqBefore);
  });

  it("allows resuming without passing a capability, adopting the stored one", () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    const second = RunContext.open({ runId: first.runId, runsDir });
    expect(second.capability).toBe("health.check");
  });

  it("records a resumed_at timestamp on run.json", () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    RunContext.open({ capability: "health.check", runId: first.runId, runsDir });
    const meta = JSON.parse(readFileSync(first.paths.meta, "utf8"));
    expect(meta.resumed_at.length).toBe(1);
  });

  it("logs a checkpoint.resume event noting whether a prior checkpoint existed", () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    first.checkpoint({ page: 1 });
    const second = RunContext.open({ capability: "health.check", runId: first.runId, runsDir });
    const events = readEvents(second.paths.events);
    const resumeEvent = events.find((e) => e.event === "checkpoint.resume");
    expect(resumeEvent).toBeDefined();
    expect(resumeEvent?.detail?.prior_checkpoint_found).toBe(true);
  });

  it("rejects resuming a nonexistent run id as RUN_NOT_FOUND with exit 1", () => {
    expect.assertions(3);
    try {
      RunContext.open({ runId: "01JNOPE0000000000000000000", runsDir });
    } catch (err: unknown) {
      const e = err as { code: string; exit: number };
      expect(e.code).toBe("RUN_NOT_FOUND");
      expect(e.exit).toBe(EXIT.GENERIC);
      expect(e.exit).toBe(1);
    }
  });

  it("rejects a capability mismatch on resume", () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    expect.assertions(1);
    try {
      RunContext.open({ capability: "profile.get", runId: first.runId, runsDir });
    } catch (err: unknown) {
      expect((err as { code: string }).code).toBe("RUN_CAPABILITY_MISMATCH");
    }
  });
});

describe("artifacts", () => {
  it("returns events and raw paths shaped per receipt.ts's Artifacts type", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const a = ctx.artifacts();
    expect(a.events.endsWith("events.ndjson")).toBe(true);
    expect(a.raw.endsWith("raw/")).toBe(true);
  });
});

describe("finish", () => {
  it("writes summary.json with the receipt", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const receipt = {
      ok: true as const, run_id: ctx.runId, capability: "health.check",
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      warnings: [], cost: { search_credits: 0, page_loads: 0, elapsed_ms: 5 },
      artifacts: ctx.artifacts(),
    };
    ctx.finish(receipt);
    const written = JSON.parse(readFileSync(ctx.paths.summary, "utf8"));
    expect(written).toEqual(receipt);
  });

  it("is safe to call twice", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const receipt = {
      ok: true as const, run_id: ctx.runId, capability: "health.check",
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      warnings: [], cost: { search_credits: 0, page_loads: 0, elapsed_ms: 5 },
      artifacts: ctx.artifacts(),
    };
    expect(() => {
      ctx.finish(receipt);
      ctx.finish(receipt);
    }).not.toThrow();
  });
});

describe("elapsedMs", () => {
  it("is a non-negative number that grows over time", async () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const t0 = ctx.elapsedMs();
    await new Promise((r) => setTimeout(r, 5));
    const t1 = ctx.elapsedMs();
    expect(t0).toBeGreaterThanOrEqual(0);
    expect(t1).toBeGreaterThanOrEqual(t0);
  });
});

describe("screenshot", () => {
  it("writes a zero-padded, sanitized filename under shots/ and returns an absolute path", async () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const writes: string[] = [];
    const fakeTab = {
      async screenshot(filePath: string): Promise<void> {
        writes.push(filePath);
        const { writeFileSync } = await import("node:fs");
        writeFileSync(filePath, Buffer.from([0]));
      },
    };

    const p1 = await ctx.screenshot(fakeTab, "before nav!");
    const p2 = await ctx.screenshot(fakeTab, "after-nav");

    expect(p1).toMatch(/001-before-nav-\.png$/);
    expect(p2).toMatch(/002-after-nav\.png$/);
    expect(p1).toBe(writes[0]);
    expect(existsSync(p1)).toBe(true);
    expect(existsSync(p2)).toBe(true);
  });

  it("does not collide with prior screenshots after a resume", async () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    const fakeTab = {
      async screenshot(filePath: string): Promise<void> {
        const { writeFileSync } = await import("node:fs");
        writeFileSync(filePath, Buffer.from([0]));
      },
    };
    await first.screenshot(fakeTab, "one");
    await first.screenshot(fakeTab, "two");

    const second = RunContext.open({ capability: "health.check", runId: first.runId, runsDir });
    const p3 = await second.screenshot(fakeTab, "three");
    expect(p3).toMatch(/003-three\.png$/);

    const files = readdirSync(second.paths.shots);
    expect(files.length).toBe(3);
  });

  it("seeds the counter from the highest surviving NNN- prefix, not the file count", async () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    const fakeTab = {
      async screenshot(filePath: string): Promise<void> {
        writeFileSync(filePath, Buffer.from("original-003"));
      },
    };
    await ctx.screenshot(fakeTab, "a"); // 001-a.png
    await ctx.screenshot(fakeTab, "b"); // 002-b.png
    await ctx.screenshot(fakeTab, "c"); // 003-c.png

    rmSync(join(ctx.paths.shots, "002-b.png"));

    const fakeTab2 = {
      async screenshot(filePath: string): Promise<void> {
        writeFileSync(filePath, Buffer.from("new"));
      },
    };
    const p4 = await ctx.screenshot(fakeTab2, "d");

    expect(p4).toMatch(/004-d\.png$/);
    const survivor = join(ctx.paths.shots, "003-c.png");
    expect(existsSync(survivor)).toBe(true);
    expect(readFileSync(survivor, "utf8")).toBe("original-003");
  });
});

describe("corrupt archive files", () => {
  it("classifies a truncated run.json as a CapabilityError, not a raw SyntaxError", () => {
    const first = RunContext.open({ capability: "health.check", runsDir });
    const raw = readFileSync(first.paths.meta, "utf8");
    writeFileSync(first.paths.meta, raw.slice(0, Math.floor(raw.length / 2)));

    expect.assertions(3);
    try {
      RunContext.open({ runId: first.runId, runsDir });
    } catch (err: unknown) {
      const e = err as { name: string; code: string; exit: number };
      expect(e.name).toBe("CapabilityError");
      expect(e.code).toBe("RUN_META_CORRUPT");
      expect(e.exit).toBe(EXIT.GENERIC);
    }
  });

  it("classifies a truncated checkpoint.json as a CapabilityError, not a raw SyntaxError", () => {
    const ctx = RunContext.open({ capability: "health.check", runsDir });
    ctx.checkpoint({ page: 1 });
    const raw = readFileSync(ctx.paths.checkpoint, "utf8");
    writeFileSync(ctx.paths.checkpoint, raw.slice(0, Math.floor(raw.length / 2)));

    expect.assertions(3);
    try {
      ctx.lastCheckpoint();
    } catch (err: unknown) {
      const e = err as { name: string; code: string; exit: number };
      expect(e.name).toBe("CapabilityError");
      expect(e.code).toBe("RUN_CHECKPOINT_CORRUPT");
      expect(e.exit).toBe(EXIT.GENERIC);
    }
  });
});
