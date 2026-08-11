import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  SalesNavQuerySyntaxError,
  atom,
  list,
  loadSalesNavArchiveFixtureManifest,
  object,
  parseSalesNavQuery,
  rawUrlParam,
  serializeSalesNavQuery,
} from "../src/core/salesnav-query/index.js";
import { fixtureQueries, fixtureSearchUrls } from "./helpers/salesnav-query-fixtures.js";

describe("Sales Navigator query grammar", () => {
  it("round-trips every promoted measured search query byte-for-byte", () => {
    const queries = fixtureQueries();
    expect(queries).toHaveLength(4);
    for (const query of queries) expect(serializeSalesNavQuery(parseSalesNavQuery(query))).toBe(query);
  });

  it("pins both measured q=searchQuery and q=savedSearch request forms without URLSearchParams rewriting", () => {
    const urls = fixtureSearchUrls();
    expect(urls).toHaveLength(6);
    expect(urls.map((url) => rawUrlParam(url, "q"))).toEqual(expect.arrayContaining(["searchQuery", "savedSearch"]));
    expect(urls.filter((url) => rawUrlParam(url, "q") === "savedSearch")).toHaveLength(2);
    for (const url of urls) {
      for (const name of ["q", "query", "savedSearchId", "trackingParam"]) {
        const raw = rawUrlParam(url, name);
        if (raw !== null) expect(url).toContain(`${name}=${raw}`);
      }
    }
  });

  it("verifies every promoted file and records the operator-private scrub boundary", () => {
    const manifest = loadSalesNavArchiveFixtureManifest();
    expect(manifest.sources).toHaveLength(10);
    expect(manifest.policy).toHaveLength(4);
    expect(manifest.sources.filter((source) => source.scrubbed.length > 0)).toHaveLength(8);
    for (const source of manifest.sources) {
      const bytes = readFileSync(join(SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, source.fixture));
      const text = source.fixture.endsWith(".gz") ? gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      expect(text).not.toMatch(/urn:li:|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i);
      if (source.scrubbed.some((field) => field.includes("savedSearchId"))) expect(text).toContain("SCRUBBED_SAVED_SEARCH_ID");
      if (source.scrubbed.some((field) => field.includes("sessionId"))) expect(text).toContain("SCRUBBED_SESSION");
    }
  });

  it("encodes grammar punctuation, base64 characters, unicode, and spaces exactly once", () => {
    const ast = object([{ key: "filters", value: list([
      object([
        { key: "type", value: atom("CURRENT_TITLE") },
        { key: "values", value: list([object([
          { key: "id", value: atom("ab+c==") },
          { key: "text", value: atom("CEO, founder: (AI) + café") },
          { key: "selectionType", value: atom("INCLUDED") },
        ])]) },
      ]),
    ]) }]);
    const encoded = serializeSalesNavQuery(ast);
    expect(encoded).toContain("ab%2Bc%3D%3D");
    expect(encoded).toContain("CEO%2C%20founder%3A%20%28AI%29%20%2B%20caf%C3%A9");
    expect(encoded).not.toContain("%252B");
    expect(parseSalesNavQuery(encoded)).toEqual(ast);
    expect(() => parseSalesNavQuery(encodeURIComponent(encoded))).toThrow(SalesNavQuerySyntaxError);
  });

  it("supports empty lists and nested range values", () => {
    for (const query of ["(filters:List())", "(filters:List((type:X,rangeValue:(min:10,max:20),selectedSubFilter:8)))"]) {
      expect(serializeSalesNavQuery(parseSalesNavQuery(query))).toBe(query);
    }
  });

  it.each([
    "", "filters:List()", "(filters:List(,))", "(filters:List((type:X,)))",
    "(filters:List((type:X,text:a,b)))", "(filters:List((type:X,text:%ZZ)))",
    "(filters:Other())", "()",
  ])("strictly rejects malformed input: %s", (query) => {
    expect(() => parseSalesNavQuery(query)).toThrow(SalesNavQuerySyntaxError);
  });
});
