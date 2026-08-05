import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCapability } from "../src/cli/types.js";
import { CAPABILITIES_DIR, Registry, loadCapabilities } from "../src/cli/registry.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

const noop = defineCapability({
  name: "demo.one",
  risk: "read-cheap",
  summary: "a demo capability",
  args: z.object({ who: z.string().optional() }).strict(),
  needsBrowser: false,
  cost: () => ({ page_loads: 2, search_pages: 0, profile_opens: 1 }),
  run: async () => ({ counts: { usable: 1 } }),
});

const needsArgs = defineCapability({
  name: "demo.two",
  risk: "read-metered",
  summary: "a demo capability with required args",
  args: z.object({ url: z.string() }).strict(),
  needsBrowser: true,
  cost: () => ({ page_loads: 5, search_pages: 1, profile_opens: 0 }),
  run: async () => ({}),
});

describe("Registry", () => {
  it("registers and returns capabilities sorted by name", () => {
    const r = new Registry();
    r.register(needsArgs);
    r.register(noop);
    expect(r.all().map((d) => d.name)).toEqual(["demo.one", "demo.two"]);
  });

  it("refuses a duplicate name rather than letting one shadow the other", () => {
    const r = new Registry();
    r.register(noop);
    expect(() => r.register({ ...noop })).toThrowError(/already registered/);
  });

  it("reports an unknown capability as a usage error naming what does exist", () => {
    const r = new Registry();
    r.register(noop);
    try {
      r.get("demo.nope");
      expect.unreachable("get should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(CapabilityError);
      const err = e as CapabilityError;
      expect(err.code).toBe("CAPABILITY_UNKNOWN");
      expect(err.exit).toBe(EXIT.GENERIC);
      expect(err.message).toContain("demo.one");
    }
  });
});

describe("manifest", () => {
  it("carries name, risk, cost and a JSON-schema view of the args", () => {
    const r = new Registry();
    r.register(noop);
    const [entry] = r.manifest();
    expect(entry).toMatchObject({
      name: "demo.one",
      risk: "read-cheap",
      summary: "a demo capability",
      needs_browser: false,
      needs_auth: false,
      cost: { page_loads: 2, search_pages: 0, profile_opens: 1 },
    });
    const schema = entry!.args_schema as { properties: Record<string, unknown>; additionalProperties?: unknown };
    expect(Object.keys(schema.properties)).toEqual(["who"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("reports cost as null when the capability cannot be costed without args", () => {
    const r = new Registry();
    r.register(needsArgs);
    const [entry] = r.manifest();
    expect(entry!.cost).toBeNull();
    expect(entry!.needs_auth).toBe(true);
  });

  it("is JSON-serializable end to end — it is what a context-less agent reads", () => {
    const r = new Registry();
    r.register(noop);
    r.register(needsArgs);
    const round = JSON.parse(JSON.stringify(r.manifest()));
    expect(round).toHaveLength(2);
    expect(round[0].args_schema).toBeTypeOf("object");
  });
});

describe("loadCapabilities", () => {
  it("finds health.check by scanning src/capabilities, with no hand-written wiring", async () => {
    const r = await loadCapabilities();
    const names = r.all().map((d) => d.name);
    expect(names).toContain("health.check");
    const health = r.get("health.check");
    expect(health.needsBrowser).toBe(true);
    expect(health.needsAuth).toBe(false);
    expect(health.risk).toBe("local");
    expect(health.cost({})).toEqual({ page_loads: 0, search_pages: 0, profile_opens: 0 });
  });

  it("rejects a capability whose directory name is not its capability name", async () => {
    await expect(
      loadCapabilities({ dir: new URL("./fixtures-cli/bad-name/", import.meta.url) }),
    ).rejects.toThrow(/directory/i);
  });

  it("classifies a capability module that fails to load, naming the directory", async () => {
    await expect(
      loadCapabilities({ dir: new URL("./fixtures-cli/broken/", import.meta.url) }),
    ).rejects.toThrow(/broken\.cap/);
  });

  it("scans a real directory tree and every entry it finds is a well-formed capability", async () => {
    const r = await loadCapabilities();
    expect(r.all().length).toBeGreaterThan(0);
    for (const def of r.all()) {
      expect(def.name).toMatch(/^[a-z0-9]+(\.[a-z0-9]+)+$/);
      expect(typeof def.run).toBe("function");
      expect(typeof def.cost).toBe("function");
      expect(CAPABILITIES_DIR.pathname).toContain("capabilities");
    }
  });
});
