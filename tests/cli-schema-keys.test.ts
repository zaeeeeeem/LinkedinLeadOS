import { describe, expect, it } from "vitest";

import { loadCapabilities } from "../src/cli/registry.js";
import { parseArgv } from "../src/cli/flags.js";

/**
 * The one rule this file exists for: **a capability's schema keys must be
 * spellable on the command line.**
 *
 * `parseArgv` camel-cases every flag name before any schema sees it, and every
 * capability schema is `.strict()`. So a key written `"comments-limit"` is
 * unreachable — the CLI accepts `--comments-limit`, hands the schema
 * `commentsLimit`, and strict mode rejects it as unrecognized. The capability
 * still passes its own unit tests, because those build argument objects by hand
 * and never go through the CLI, and `cap list` still advertises the broken
 * spelling because the manifest prints schema keys verbatim.
 *
 * That defect shipped twice — `log.runs`'s `include-queries` and `post.get`'s
 * `comments-limit` / `reactions-limit` — before anything caught it. This test is
 * the guard, and it runs over the whole registry so the next one is caught the
 * day it is written rather than the day someone tries the flag.
 */
const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

describe("every capability's argument schema is reachable from the CLI", () => {
  it("has no schema key that parseArgv would rewrite", async () => {
    const registry = await loadCapabilities();
    const names = registry.names();
    expect(names.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const cap of names.map((n) => registry.get(n))) {
      const schema = cap.args as unknown as { shape?: Record<string, unknown> };
      for (const key of Object.keys(schema.shape ?? {})) {
        if (camel(key) !== key) offenders.push(`${cap.name}: "${key}" is only reachable as "${camel(key)}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("round-trips a real argv through the real parser into the real schema", async () => {
    // The end-to-end version of the same claim, on the capability that had the
    // bug. This is the path a user actually takes, and the path no unit test took.
    const registry = await loadCapabilities();
    expect(registry.has("post.get")).toBe(true);
    const postGet = registry.get("post.get");

    const { args } = parseArgv([
      "post.get",
      "--url=https://www.linkedin.com/posts/x-activity-7491197577439141888-dqLl",
      "--comments",
      "--comments-limit=25",
      "--reactions",
      "--reactions-limit=3",
    ]);
    const parsed = postGet.args.safeParse(args);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({
      comments: true,
      commentsLimit: 25,
      reactions: true,
      reactionsLimit: 3,
    });
  });

  it("round-trips log.runs' flag too, the other instance of the same bug", async () => {
    const registry = await loadCapabilities();
    expect(registry.has("log.runs")).toBe(true);
    const logRuns = registry.get("log.runs");

    const { args } = parseArgv(["log.runs", "--include-queries"]);
    const parsed = logRuns.args.safeParse(args);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toMatchObject({ includeQueries: true });
  });
});
