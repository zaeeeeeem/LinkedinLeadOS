import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import {
  MAX_DEPTH, MAX_ELEMENTS, MAX_HITS_PER_FIELD, MAX_NODES, MIN_CONTAINS_CHARS,
  embeddedJsonOf, normalize, renderSweep, sweepSources, walkDom, walkJson,
} from "../src/core/fixtures/sweep.js";
import type { SweepDocument, WantedField } from "../src/core/fixtures/sweep.js";

const WANT: WantedField[] = [
  { field: "name", what: "companies.name", value: "Acme Robotics" },
  { field: "website", what: "companies.website", value: "https://acme.example" },
  { field: "hq", what: "companies.hq", value: "Berlin, Germany" },
];

const VOYAGER: SweepDocument = {
  file: "aaa.json.gz",
  kind: "json",
  body: JSON.stringify({
    data: { company: { name: "Acme Robotics", websiteUrl: "https://acme.example" } },
  }),
};

const DOCUMENT: SweepDocument = {
  file: "bbb.json.gz",
  kind: "document-html",
  body:
    "<html><head>" +
    '<script type="application/ld+json">' +
    JSON.stringify({ "@type": "Organization", name: "Acme Robotics", url: "https://acme.example" }) +
    "</script></head><body>" +
    // Markup in the document response is never read (D117). If this were read,
    // `hq` would resolve to `embedded-json`, which it must not.
    "<p>Berlin, Germany</p></body></html>",
};

const SNAPSHOT: SweepDocument = {
  file: "ccc-dom-snapshot.html",
  kind: "dom-snapshot",
  body:
    '<html><body><main id="workspace">' +
    "<h1>Acme Robotics</h1>" +
    '<a href="https://acme.example">acme.example</a>' +
    "<p>Berlin, Germany</p>" +
    // A stranger's row, to prove leaf-only text reporting does not bubble.
    "<aside><p>Globex</p></aside>" +
    "</main></body></html>",
};

describe("sweepSources — which source carries a field", () => {
  it("prefers a voyager body over embedded json over the rendered DOM", () => {
    const result = sweepSources({ documents: [SNAPSHOT, DOCUMENT, VOYAGER], wanted: WANT });
    const by = Object.fromEntries(result.fields.map((f) => [f.field, f]));
    expect(by["name"]!.source).toBe("voyager-body");
    expect(by["website"]!.source).toBe("voyager-body");
    // Nothing but the rendered page carries the HQ, which is the finding that
    // blocks the consuming tasks until the operator extends the exception.
    expect(by["hq"]!.source).toBe("dom-snapshot");
    expect(result.domOnly).toEqual(["hq"]);
  });

  it("reports a field no source carries as absent rather than as a weak guess", () => {
    const result = sweepSources({
      documents: [VOYAGER],
      wanted: [{ field: "size_range", value: "51-200 employees" }],
    });
    expect(result.fields[0]!.source).toBeNull();
    expect(result.absent).toEqual(["size_range"]);
  });

  it("gives a concrete, resolvable path for every source", () => {
    const result = sweepSources({ documents: [VOYAGER, DOCUMENT, SNAPSHOT], wanted: WANT });
    const paths = result.fields.flatMap((f) => f.hits.map((h) => `${h.source} ${h.path}`));
    expect(paths).toContain("voyager-body $.data.company.name");
    expect(paths).toContain("embedded-json head > script → $.name");
    expect(paths.some((p) => p.startsWith("dom-snapshot main#workspace"))).toBe(true);
  });

  it("reads only embedded json out of a document response, never its markup (D117)", () => {
    const result = sweepSources({ documents: [DOCUMENT], wanted: WANT });
    const hq = result.fields.find((f) => f.field === "hq")!;
    // The string is right there in the document's `<p>`, and it is still absent:
    // markup, element text and CSS selectors are not a source in that document.
    expect(hq.hits).toEqual([]);
    expect(hq.source).toBeNull();
  });

  it("reads only markup out of a DOM snapshot, never laundering its inline scripts into embedded-json", () => {
    const snapshotWithScript: SweepDocument = {
      file: "ddd-dom-snapshot.html",
      kind: "dom-snapshot",
      body: '<html><body><script type="application/json">{"name":"Acme Robotics"}</script></body></html>',
    };
    const result = sweepSources({ documents: [snapshotWithScript], wanted: WANT });
    expect(result.fields.find((f) => f.field === "name")!.hits.every((h) => h.source === "dom-snapshot")).toBe(true);
  });

  it("distinguishes an exact value from one embedded in a longer string", () => {
    const doc: SweepDocument = {
      file: "e.json.gz",
      kind: "json",
      body: JSON.stringify({ exact: "Acme Robotics", inside: "Welcome to Acme Robotics, Berlin" }),
    };
    const hits = sweepSources({ documents: [doc], wanted: [WANT[0]!] }).fields[0]!.hits;
    expect(hits.find((h) => h.path === "$.exact")!.match).toBe("exact");
    expect(hits.find((h) => h.path === "$.inside")!.match).toBe("contains");
    // Exact sorts first: it is the path a parser can read directly.
    expect(hits[0]!.match).toBe("exact");
  });

  it("marks a hit whose value is the session's own identity as a trap (D119)", () => {
    const own = "urn:li:fsd_profile:ACoAAoperator";
    const doc: SweepDocument = { file: "f.json.gz", kind: "json", body: JSON.stringify({ urn: own }) };
    const result = sweepSources({
      documents: [doc],
      wanted: [{ field: "subject_urn", value: own }],
      selfValues: [own],
    });
    expect(result.fields[0]!.trap).toBe(true);
    expect(result.fields[0]!.hits.every((h) => h.self)).toBe(true);
  });

  it("finds a value living in an attribute, which is where a website actually is", () => {
    const result = sweepSources({ documents: [SNAPSHOT], wanted: [WANT[1]!] });
    const attr = result.fields[0]!.hits.find((h) => h.via === "attribute");
    expect(attr).toBeDefined();
    expect(attr!.path).toMatch(/\[href\]$/);
  });

  it("skips a body that is not json rather than failing the sweep", () => {
    const result = sweepSources({
      documents: [{ file: "g.json.gz", kind: "json", body: "<html>not json</html>" }, VOYAGER],
      wanted: [WANT[0]!],
    });
    expect(result.fields[0]!.source).toBe("voyager-body");
  });

  it("bounds the hits per field and says how many it dropped", () => {
    const many = { list: Array.from({ length: MAX_HITS_PER_FIELD + 7 }, () => "Acme Robotics") };
    const result = sweepSources({
      documents: [{ file: "h.json.gz", kind: "json", body: JSON.stringify(many) }],
      wanted: [WANT[0]!],
    });
    expect(result.fields[0]!.hits).toHaveLength(MAX_HITS_PER_FIELD);
    expect(result.fields[0]!.omitted).toBe(7);
  });
});

describe("walkJson — bounds, exceeded rather than assumed roomy", () => {
  it("stops at MAX_NODES and says so, so an absent verdict is not read as proof", () => {
    const big = { list: Array.from({ length: MAX_NODES + 10 }, (_, i) => `filler-${i}`) };
    const found = walkJson(big, [{ field: "x", value: "filler-1" }]);
    expect(found.truncated).toBe(true);
    expect(found.nodes).toBeLessThanOrEqual(MAX_NODES);
  });

  it("surfaces truncation on the result, where a reader will see it", () => {
    const big = { list: Array.from({ length: MAX_NODES + 10 }, (_, i) => `filler-${i}`) };
    const result = sweepSources({
      documents: [{ file: "i.json.gz", kind: "json", body: JSON.stringify(big) }],
      wanted: [{ field: "x", value: "nowhere-at-all" }],
    });
    expect(result.truncated).toBe(true);
    expect(renderSweep({ surface: "s", generatedAt: "t", sourceRun: "r", result })).toMatch(
      /a walk hit its bound/,
    );
  });

  it("stops descending at MAX_DEPTH", () => {
    let node: Record<string, unknown> = { value: "Acme Robotics" };
    for (let i = 0; i < MAX_DEPTH + 5; i++) node = { child: node };
    expect(walkJson(node, [{ field: "x", value: "Acme Robotics" }]).get("x")).toBeUndefined();
  });

  it("does not loop forever on a cyclic object", () => {
    const cyclic: Record<string, unknown> = { name: "Acme Robotics" };
    cyclic["self"] = cyclic;
    expect(walkJson(cyclic, [WANT[0]!]).get("name")).toHaveLength(1);
  });

  it("stringifies numbers, because a count is a number in json and a string to a reader", () => {
    const found = walkJson({ staffCount: 1200 }, [{ field: "size", value: "1200" }]);
    expect(found.get("size")?.[0]?.path).toBe("$.staffCount");
  });

  it("quotes a path step that is not a plain identifier, so every path is pasteable", () => {
    const found = walkJson({ "*elements": ["Acme Robotics"] }, [WANT[0]!]);
    expect(found.get("name")?.[0]?.path).toBe('$["*elements"][0]');
  });
});

describe("walkDom", () => {
  it("reports leaf elements only — an ancestor containing the value is not a usable path", () => {
    const hits = walkDom(
      "<html><body><div><span>Acme Robotics</span></div></body></html>",
      [WANT[0]!],
    ).get("name")!;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.path.endsWith("span")).toBe(true);
  });

  it("stops at MAX_ELEMENTS and says so — the bound is exceeded here, not assumed roomy", () => {
    const html = `<html><body>${"<p>x</p>".repeat(MAX_ELEMENTS + 50)}</body></html>`;
    const found = walkDom(html, [{ field: "x", value: "nothing" }]);
    expect(found.nodes).toBeLessThanOrEqual(MAX_ELEMENTS);
    expect(found.truncated).toBe(true);
  });

  it("does not claim truncation on a page that fits", () => {
    const found = walkDom(`<html><body>${"<p>x</p>".repeat(50)}</body></html>`, [
      { field: "x", value: "nothing" },
    ]);
    expect(found.truncated).toBe(false);
  });
});

describe("matching", () => {
  it("normalizes whitespace and case, because rendered html wraps and indents", () => {
    expect(normalize("  Acme\n  Robotics ")).toBe("acme robotics");
    const hits = walkDom(
      "<html><body><p>\n  Acme\n  Robotics\n</p></body></html>",
      [WANT[0]!],
    ).get("name")!;
    expect(hits[0]!.match).toBe("exact");
  });

  it("never substring-matches a value shorter than MIN_CONTAINS_CHARS", () => {
    const short = "IBM".slice(0, MIN_CONTAINS_CHARS - 4) || "IBM";
    const found = walkJson({ noise: `not ${short} really` }, [{ field: "n", value: short }]);
    expect(found.get("n")).toBeUndefined();
  });
});

describe("embeddedJsonOf", () => {
  it("takes ld+json and application/json and refuses everything else", () => {
    const found = embeddedJsonOf(
      '<html><head><script type="application/ld+json">{"a":1}</script>' +
        '<script type="application/json">{"b":2}</script>' +
        "<script>window.x = {c: 3}</script></head></html>",
    );
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.value)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips a script that does not parse rather than salvaging part of it", () => {
    expect(embeddedJsonOf('<script type="application/json">{oops</script>')).toEqual([]);
  });

  // LinkedIn does not use either script type. It streams its server-rendered
  // Voyager JSON into `<code id="bpr-guid-N">` elements — the Big Pipe data
  // islands — and the payload is HTML-entity-escaped, so cheerio's text()
  // returns the JSON only after unescaping. Measured on the company surface,
  // run 01KZKGD683T76H70YA4DMRCRZH: 18 islands in the About document carrying
  // websiteUrl, description, employeeCountRange and headquarter.address. See
  // D184.
  it("takes LinkedIn's bpr-guid code islands, which carry the server-rendered JSON", () => {
    const found = embeddedJsonOf(
      '<html><body><code style="display: none" id="bpr-guid-586526">' +
        "{&quot;included&quot;:[{&quot;websiteUrl&quot;:&quot;https://acme.example/&quot;}]}" +
        "</code></body></html>",
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.value).toEqual({ included: [{ websiteUrl: "https://acme.example/" }] });
    expect(found[0]!.prefix).toBe("code#bpr-guid-586526 → $");
  });

  it("takes an unescaped code island too — the escaping is incidental, the id is the marker", () => {
    const found = embeddedJsonOf('<code id="bpr-guid-1">{"a":1}</code>');
    expect(found.map((f) => f.value)).toEqual([{ a: 1 }]);
  });

  it("leaves a code element that is not a bpr island alone, even when it holds json", () => {
    // A `<code>` in a post or an article is rendered content, not a data
    // island. Reading it as embedded JSON would launder page text into the
    // labeled-field source, which is the one confusion the sweep exists to
    // prevent.
    const found = embeddedJsonOf('<code id="example-1">{"a":1}</code><code>{"b":2}</code>');
    expect(found).toEqual([]);
  });

  it("skips a bpr island that does not parse, like any other source", () => {
    expect(embeddedJsonOf('<code id="bpr-guid-9">{oops</code>')).toEqual([]);
  });

  it("prefers a script id to a positional selector when there is one", () => {
    const found = embeddedJsonOf('<script id="state" type="application/json">{"a":1}</script>');
    expect(found[0]!.prefix).toBe("script#state → $");
  });

  it("numbers a positional selector by sibling position, not by how many it has collected", () => {
    // `:nth-of-type` counts siblings of the same *tag* within one parent, and
    // `[type=…]` does not narrow that count. Here the ld+json script is the
    // second `<script>` in `<head>`, and a selector numbered `1` because it is
    // the first thing collected would resolve to the JavaScript above it.
    const html =
      "<html><head>" +
      "<script>var a = 1;</script>" +
      '<script type="application/ld+json">{"a":1}</script>' +
      "</head><body>" +
      '<script type="application/json">{"b":2}</script>' +
      "</body></html>";
    const found = embeddedJsonOf(html);
    expect(found).toHaveLength(2);
    expect(found[0]!.prefix).toBe("head > script:nth-of-type(2) → $");
    // A different parent restarts the count, which an accumulator cannot do.
    expect(found[1]!.prefix).toBe("body > script → $");
  });

  it("does not let an unparseable script shift the numbering of the ones after it", () => {
    const html =
      "<html><head>" +
      '<script type="application/json">{oops</script>' +
      '<script type="application/json">{"a":1}</script>' +
      "</head></html>";
    const found = embeddedJsonOf(html);
    expect(found).toHaveLength(1);
    // Second script of its parent, regardless of the first having been skipped.
    expect(found[0]!.prefix).toBe("head > script:nth-of-type(2) → $");
  });

  it("gives every embedded hit a path that resolves back to the script it came from", () => {
    const html =
      "<html><head><script>noise()</script>" +
      '<script type="application/ld+json">{"name":"Acme Robotics"}</script></head></html>';
    const result = sweepSources({
      documents: [{ file: "z.json.gz", kind: "document-html", body: html }],
      wanted: [WANT[0]!],
    });
    const hit = result.fields[0]!.hits[0]!;
    const selector = hit.path.slice(0, hit.path.indexOf(" → "));
    // The claim a field map makes is that its paths resolve. Checked, not asserted.
    expect(cheerio.load(html)(selector).attr("type")).toBe("application/ld+json");
  });
});

describe("renderSweep — what may be committed", () => {
  const result = sweepSources({ documents: [SNAPSHOT, VOYAGER], wanted: WANT });
  const render = () =>
    renderSweep({ surface: "company page family", generatedAt: "2026-08-09T00:00:00Z", sourceRun: "R", result });

  it("prints no captured value, because this file is committed and fixtures are not", () => {
    const md = render();
    expect(md).not.toContain("Acme Robotics");
    expect(md).not.toContain("acme.example");
    expect(md).not.toContain("Berlin, Germany");
    expect(md).toMatch(/the pinning tests beside the fixture assert the meaning/);
  });

  it("still names the field, the source, the file and the path", () => {
    const md = render();
    expect(md).toContain("`name`");
    expect(md).toContain("voyager-body");
    expect(md).toContain("$.data.company.name");
    expect(md).toContain("aaa.json.gz");
  });

  it("marks a DOM-only field as blocked on the operator's decision", () => {
    expect(render()).toMatch(/DOM-only.*extending the CLAUDE\.md exception/);
    expect(render()).toMatch(/\*\*DOM-only fields:\*\* hq/);
  });

  it("has no way to ask for samples at all", () => {
    // The flag that used to be here rendered nothing and only swapped the
    // preamble for a warning about a risk it was not taking. A knob that does
    // not do what its name says is worse than no knob.
    expect("samples" in ({} as Parameters<typeof renderSweep>[0])).toBe(false);
    expect(render()).not.toMatch(/must not be committed/);
  });

  it("marks a trap row rather than presenting it as a source", () => {
    const own = "urn:li:fsd_profile:ACoAAoperator";
    const trapped = sweepSources({
      documents: [{ file: "t.json.gz", kind: "json", body: JSON.stringify({ urn: own }) }],
      wanted: [{ field: "company_urn", value: own }],
      selfValues: [own],
    });
    expect(
      renderSweep({ surface: "s", generatedAt: "t", sourceRun: "r", result: trapped }),
    ).toMatch(/the session's own identity — a trap/);
  });
});
