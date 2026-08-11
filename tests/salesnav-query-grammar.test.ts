import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRunsDir } from "../src/core/run/paths.js";
import {
  SalesNavQuerySyntaxError,
  atom,
  list,
  object,
  parseSalesNavQuery,
  rawUrlParam,
  serializeSalesNavQuery,
} from "../src/core/salesnav-query/index.js";

const ARCHIVE_RUNS = [
  "01KZQFCFMVYKAC082JXDRVCAN3",
  "01KZQ5TXC23T3FFBJ72P8CE85J",
  "01KZP693DEWVP0S90K7C7XQ997",
  "01KZQNM34D61NTBDQNDVSZ45AV",
];

function archivedQueries(): string[] {
  const out: string[] = [];
  for (const run of ARCHIVE_RUNS) {
    const raw = join(defaultRunsDir(), run, "raw");
    for (const file of readdirSync(raw).filter((candidate) => candidate.endsWith(".meta.json"))) {
      const metadata = JSON.parse(readFileSync(join(raw, file), "utf8")) as { url?: string };
      if (!/salesApi(?:LeadSearch|AccountSearch)/.test(metadata.url ?? "")) continue;
      const query = rawUrlParam(metadata.url!, "query");
      if (query !== null) out.push(query);
    }
  }
  return out;
}

function archivedSearchUrls(): string[] {
  const out: string[] = [];
  for (const run of ARCHIVE_RUNS) {
    const raw = join(defaultRunsDir(), run, "raw");
    for (const file of readdirSync(raw).filter((candidate) => candidate.endsWith(".meta.json"))) {
      const metadata = JSON.parse(readFileSync(join(raw, file), "utf8")) as { url?: string };
      if (/salesApi(?:LeadSearch|AccountSearch)/.test(metadata.url ?? "")) out.push(metadata.url!);
    }
  }
  return out;
}

describe("Sales Navigator query grammar", () => {
  it("round-trips every archived measured search query byte-for-byte", () => {
    const queries = archivedQueries();
    expect(queries.length).toBe(4);
    for (const query of queries) expect(serializeSalesNavQuery(parseSalesNavQuery(query))).toBe(query);
  });

  it("pins both measured q=searchQuery and q=savedSearch request forms without URLSearchParams rewriting", () => {
    const urls = archivedSearchUrls();
    expect(urls).toHaveLength(6);
    expect(urls.map((url) => rawUrlParam(url, "q"))).toEqual(expect.arrayContaining([
      "searchQuery", "savedSearch",
    ]));
    expect(urls.filter((url) => rawUrlParam(url, "q") === "savedSearch")).toHaveLength(2);
    for (const url of urls) {
      for (const name of ["q", "query", "savedSearchId", "trackingParam"]) {
        const raw = rawUrlParam(url, name);
        if (raw !== null) expect(url).toContain(`${name}=${raw}`);
      }
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
