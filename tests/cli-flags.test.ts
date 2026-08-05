import { describe, expect, it } from "vitest";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import { DEFAULT_FLAGS, parseArgv } from "../src/cli/flags.js";

const parse = (line: string) => parseArgv(line.split(" ").filter(Boolean));

describe("parseArgv", () => {
  it("defaults every universal flag to off", () => {
    const p = parse("health.check");
    expect(p.command).toBe("health.check");
    expect(p.flags).toEqual(DEFAULT_FLAGS);
    expect(p.args).toEqual({});
  });

  it("parses every universal flag of spec 4.4 plus --force-release", () => {
    const p = parse("profile.get --run-id=01ABC --dry-run --fields=name,headline --no-store --budget=3 --force-release");
    expect(p.flags).toEqual({
      runId: "01ABC",
      dryRun: true,
      fields: ["name", "headline"],
      noStore: true,
      budget: 3,
      forceRelease: true,
    });
    expect(p.args).toEqual({});
  });

  it("routes non-universal flags to the capability's args, kebab-case to camelCase", () => {
    const p = parse("profile.get --url=https://x --max-pages=3 --verbose");
    expect(p.args).toEqual({ url: "https://x", maxPages: "3", verbose: true });
  });

  it("collects a repeated capability flag into an array", () => {
    const p = parse("profile.get --section=basics --section=skills");
    expect(p.args).toEqual({ section: ["basics", "skills"] });
  });

  it("refuses a positional argument, and says how to pass a value", () => {
    try {
      parse("profile.get https://x");
      expect.unreachable("should have thrown");
    } catch (e) {
      const err = e as CapabilityError;
      expect(err).toBeInstanceOf(CapabilityError);
      expect(err.code).toBe("FLAG_POSITIONAL");
      expect(err.exit).toBe(EXIT.GENERIC);
      expect(err.message).toContain("--name=value");
    }
  });

  it("refuses a value-taking universal flag written without =", () => {
    expect(() => parse("profile.get --run-id 01ABC")).toThrowError(/--run-id=/);
  });

  it("refuses a non-numeric or negative budget", () => {
    expect(() => parse("profile.get --budget=abc")).toThrowError(/FLAG_INVALID|whole number/);
    expect(() => parse("profile.get --budget=-1")).toThrowError(/whole number/);
    expect(parse("profile.get --budget=0").flags.budget).toBe(0);
  });

  it("refuses an empty --fields rather than projecting nothing", () => {
    expect(() => parse("profile.get --fields=")).toThrowError(/--fields/);
  });

  it("treats a bare invocation as no command", () => {
    expect(parse("").command).toBeNull();
    expect(parse("--help").help).toBe(true);
  });

  it("keeps the flags object free of prototype pollution from a hostile arg name", () => {
    const p = parse("profile.get --__proto__=oops");
    expect(Object.getPrototypeOf({})).not.toHaveProperty("oops");
    expect(p.args["__proto__"]).toBe("oops");
  });
});
