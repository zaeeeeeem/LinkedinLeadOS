import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import buildCapability from "../src/capabilities/salesnav.filters.build/index.js";
import vocabCapability from "../src/capabilities/salesnav.filters.vocab/index.js";

const ROOT = resolve(import.meta.dirname, "..");
const ENTRY = join(ROOT, "src/capabilities/salesnav.filters.build/index.ts");

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    const normalized = normalize(file);
    if (seen.has(normalized)) return;
    seen.add(normalized);
    const source = readFileSync(normalized, "utf8");
    const imports = source.matchAll(/^import(?!\s+type\b)[\s\S]*?from\s+["']([^"']+)["'];?$/gm);
    for (const match of imports) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      const candidate = resolve(dirname(normalized), specifier.replace(/\.js$/, ".ts"));
      visit(candidate);
    }
  };
  visit(entry);
  return [...seen].map((file) => relative(ROOT, file)).sort();
}

describe("salesnav.filters.build import graph", () => {
  it("keeps Task 41 tests independent of the gitignored operator run archive", () => {
    for (const file of [
      "tests/salesnav-query-grammar.test.ts",
      "tests/salesnav-filter-builder.test.ts",
      "tests/salesnav-filter-vocabulary.test.ts",
    ]) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).not.toContain("defaultRunsDir");
      expect(source).not.toContain("core/run/paths");
    }
  });

  it("declares both Task 41 capabilities as offline and zero-cost", () => {
    for (const capability of [buildCapability, vocabCapability]) {
      expect(capability.needsBrowser).toBe(false);
      expect(capability.needsAuth).toBe(false);
      expect(capability.risk).toBe("local");
      expect(capability.cost({} as never)).toEqual({ page_loads: 0, search_pages: 0, profile_opens: 0 });
    }
  });
  it("cannot reach browser, network, budget, session, tap, or paged modules", () => {
    const graph = reachable(ENTRY);
    expect(graph).toContain("src/capabilities/salesnav.filters.build/index.ts");
    for (const forbidden of [
      "src/core/chrome/", "src/core/cdp/", "src/core/session/", "src/core/tap/",
      "src/core/input/", "src/core/budget/", "src/core/paged/", "src/cli/preflight.ts", "src/cli/run.ts",
    ]) expect(graph.filter((file) => file.startsWith(forbidden))).toEqual([]);
  });
});
