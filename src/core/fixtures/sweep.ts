import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { cssPath } from "./dommap.js";

/**
 * Which source carries a field — measured by looking for a value we already
 * know, instead of by guessing at key names.
 *
 * The field maps that came before this one work forwards: a probe describes
 * what a field *might* be called (`/^(headline|occupation)$/`) and the walker
 * reports every path that matches. That is the right tool for a surface nobody
 * has seen, and it is how D119's trap got into a field map — a path can match
 * the shape of a field and hold something else entirely.
 *
 * This works backwards. The operator reads the rendered page and states the
 * ground truth — "the website is `acme.example`" — and the sweep reports every
 * place that exact value actually appears, in which source, at which path. A
 * hit is therefore meaning-checked by construction: it is the value, so it
 * cannot be `105,570 followers` sitting in the location slot (D128).
 *
 * The three sources are `CLAUDE.md`'s, in its order of preference:
 *
 * - `voyager-body` — a captured JSON response. The rule's default.
 * - `embedded-json` — structured JSON server-rendered into the initial document
 *   response, addressed by a path into that parsed JSON (D117).
 * - `dom-snapshot` — the rendered DOM, archived like a body (D124). Sanctioned
 *   for the profile reader and **nowhere else** until the operator extends the
 *   exception per surface (M4 CONTEXT rule 7).
 *
 * A field found only in `dom-snapshot` is therefore not a result the sweep may
 * act on. It is a `[DECISION NEEDED]`.
 */

export type SourceKind = "voyager-body" | "embedded-json" | "dom-snapshot";

/** Preference order, best first. Used to pick a field's verdict when more than
 *  one source carries it. */
export const SOURCE_PREFERENCE: readonly SourceKind[] = [
  "voyager-body",
  "embedded-json",
  "dom-snapshot",
];

/** One document the sweep looks in. */
export type SweepDocument = {
  /** The archived or promoted file name, so a hit can be re-checked by hand. */
  file: string;
  /**
   * How to read it.
   *
   * `json` is a captured response body. `document-html` is the *initial document
   * response* — only its embedded JSON is read, never its markup, because that
   * is the exact line D117 drew. `dom-snapshot` is the archived rendered DOM,
   * and only its markup is read: its inline scripts are post-hydration state,
   * not something a server sent, and reporting them as `embedded-json` would
   * launder a DOM read into the sanctioned source.
   */
  kind: "json" | "document-html" | "dom-snapshot";
  body: string;
};

/** One thing the operator knows to be true about the page. */
export type WantedField = {
  field: string;
  /** The value as it appears to a human reading the page. */
  value: string;
  /** One line for the rendered map: what a parser would do with this. */
  what?: string;
};

export type SweepHit = {
  field: string;
  source: SourceKind;
  file: string;
  /** A concrete, copy-pasteable path — `$.data.company.websiteUrl` for JSON,
   *  a CSS path for the DOM, both prefixed for embedded JSON by the script
   *  element it was parsed out of. */
  path: string;
  /** `exact` when the whole value at that path is the wanted value; `contains`
   *  when the wanted value is a substring of a longer one. Exact is what a
   *  parser can read directly; contains means a parser would have to cut. */
  match: "exact" | "contains";
  /** For a DOM hit: whether it came from element text or from an attribute. */
  via: "value" | "attribute" | "text";
  /** True when this value is also one of the session's own — D119's trap, which
   *  has now been found in four separate places. */
  self: boolean;
};

export type FieldVerdict = {
  field: string;
  what: string;
  /** The best source carrying this field, or `null` when nothing does. */
  source: SourceKind | null;
  /** Every hit, best source first. Bounded by `MAX_HITS_PER_FIELD`. */
  hits: SweepHit[];
  /** How many hits were dropped by that bound. */
  omitted: number;
  /** True when at least one hit resolves to the session's own identity. */
  trap: boolean;
};

export type SweepResult = {
  fields: FieldVerdict[];
  /** Fields carried by no source at all. */
  absent: string[];
  /** Fields whose only source is the rendered DOM — the ones that block Tasks
   *  22–25 until the operator extends the CLAUDE.md exception. */
  domOnly: string[];
  documents: number;
  nodesWalked: number;
  /** True when a walk stopped at `MAX_NODES` — the sweep describes a prefix of
   *  a body, not all of it, and an absent verdict is then not proof of absence. */
  truncated: boolean;
};

/**
 * Bounds. A LinkedIn document is ~1MB and a snapshot ~875KB; a sweep is a
 * development aid and must never be what runs a machine out of memory. Each is
 * exceeded by a test rather than assumed roomy.
 */
export const MAX_NODES = 200_000;
export const MAX_DEPTH = 64;
export const MAX_HITS_PER_FIELD = 20;
export const MAX_ELEMENTS = 100_000;
/** A wanted value shorter than this is only ever matched exactly. `contains` on
 *  a three-character value matches most of a page and reports noise as a find. */
export const MIN_CONTAINS_CHARS = 6;

/** Attributes a value can legitimately live in. `href` is where a website
 *  actually is; the rest carry accessible text LinkedIn renders visually. */
const SCANNED_ATTRIBUTES = ["href", "content", "title", "aria-label", "alt", "datetime"] as const;

/** Whitespace-collapsed and case-folded, the only form values are compared in.
 *  Rendered HTML wraps and indents; a comparison that did not normalize would
 *  miss the value it was handed. */
export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function matchOf(haystack: string, needle: string): "exact" | "contains" | null {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (n === "") return null;
  if (h === n) return "exact";
  if (n.length >= MIN_CONTAINS_CHARS && h.includes(n)) return "contains";
  return null;
}

/** `.foo` for a plain identifier, `["odd key"]` otherwise — so every path this
 *  emits is one that can be pasted into a parser. */
function pathStep(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

type Walked = { hits: Array<Omit<SweepHit, "field" | "source" | "file" | "self">>; nodes: number; truncated: boolean };

/**
 * Every path in a parsed JSON value whose string leaf carries one of the wanted
 * values. Bounded in both node count and depth, and it reports when it stopped.
 *
 * Numbers and booleans are stringified before comparing: a follower count or an
 * employee count is a number in JSON and a string to the operator reading it.
 */
export function walkJson(
  root: unknown,
  wanted: readonly WantedField[],
  prefix = "$",
): Map<string, Walked["hits"]> & { nodes: number; truncated: boolean } {
  const byField = new Map<string, Walked["hits"]>() as Map<string, Walked["hits"]> & {
    nodes: number;
    truncated: boolean;
  };
  byField.nodes = 0;
  byField.truncated = false;

  const stack: Array<{ value: unknown; path: string; depth: number }> = [
    { value: root, path: prefix, depth: 0 },
  ];
  const seen = new WeakSet<object>();

  while (stack.length > 0) {
    if (byField.nodes >= MAX_NODES) {
      byField.truncated = true;
      break;
    }
    const node = stack.pop()!;
    byField.nodes++;
    const value = node.value;

    if (value === null) continue;
    if (typeof value === "object") {
      if (seen.has(value)) continue;
      seen.add(value);
      if (node.depth >= MAX_DEPTH) continue;
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) {
          stack.push({ value: value[i], path: `${node.path}[${i}]`, depth: node.depth + 1 });
        }
      } else {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          stack.push({ value: v, path: `${node.path}${pathStep(k)}`, depth: node.depth + 1 });
        }
      }
      continue;
    }

    const text = typeof value === "string" ? value : String(value);
    for (const want of wanted) {
      const match = matchOf(text, want.value);
      if (match === null) continue;
      const list = byField.get(want.field) ?? [];
      list.push({ path: node.path, match, via: "value" });
      byField.set(want.field, list);
    }
  }

  return byField;
}

/**
 * The JSON a page server-renders into its own document, with the path prefix
 * that says which script element it came out of.
 *
 * `application/ld+json` and `application/json` only. A `<script>` with no type
 * is JavaScript, and evaluating or regex-mining it would be exactly the
 * "element text at a hardcoded position" D121 refused.
 */
export function embeddedJsonOf(html: string): Array<{ prefix: string; value: unknown }> {
  const $ = cheerio.load(html);
  const out: Array<{ prefix: string; value: unknown }> = [];
  $('script[type="application/ld+json"], script[type="application/json"]').each((_, node) => {
    const el = node as Element;
    const raw = $(el).text();
    if (raw.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A script that does not parse is not embedded structured data. Skipped
      // rather than salvaged: a partial parse would produce paths nothing can
      // resolve, which is the one thing a field map may not do.
      return;
    }
    // The path comes from `cssPath`, the same function the DOM walk uses, and
    // for one reason: `:nth-of-type` counts *siblings of the same tag within one
    // parent*, and the `[type=…]` predicate does not narrow that count. A
    // selector numbered by the order these were accumulated — across both
    // types, across parents, skipping the ones that did not parse — resolves to
    // a different script or to nothing at all. A field map may only carry paths
    // that resolve, which is the whole reason it is worth more than prose.
    out.push({ prefix: `${cssPath($, el)} → $`, value: parsed });
  });
  return out;
}

/** Every element whose own text, or one of its scanned attributes, carries a
 *  wanted value. Leaf text only — a value reported on `<body>` because it is
 *  somewhere inside is a path a parser cannot use. */
export function walkDom(
  html: string,
  wanted: readonly WantedField[],
): Map<string, Walked["hits"]> & { nodes: number; truncated: boolean } {
  const byField = new Map<string, Walked["hits"]>() as Map<string, Walked["hits"]> & {
    nodes: number;
    truncated: boolean;
  };
  byField.nodes = 0;
  byField.truncated = false;

  const $ = cheerio.load(html);
  const add = (field: string, hit: Walked["hits"][number]): void => {
    const list = byField.get(field) ?? [];
    list.push(hit);
    byField.set(field, list);
  };

  $("*").each((_, node) => {
    if (byField.nodes >= MAX_ELEMENTS) {
      byField.truncated = true;
      return false;
    }
    const el = node as Element;
    byField.nodes++;

    for (const attr of SCANNED_ATTRIBUTES) {
      const value = el.attribs?.[attr];
      if (value === undefined || value === "") continue;
      for (const want of wanted) {
        const match = matchOf(value, want.value);
        if (match === null) continue;
        add(want.field, { path: `${cssPath($, el)}[${attr}]`, match, via: "attribute" });
      }
    }

    // Leaf elements only. Every ancestor of a match "contains" it, and
    // reporting them all would bury the one path that is usable.
    if ($(el).children().length > 0) return undefined;
    const text = $(el).text();
    if (text.trim() === "") return undefined;
    for (const want of wanted) {
      const match = matchOf(text, want.value);
      if (match === null) continue;
      add(want.field, { path: cssPath($, el), match, via: "text" });
    }
    return undefined;
  });

  return byField;
}

/**
 * Runs every wanted field against every document and returns one verdict each.
 *
 * Pure: documents in, data out, no I/O. That is what lets the bounds above be
 * tested rather than assumed, and what lets the whole sweep be proven offline
 * against synthetic documents before a real one exists.
 */
export function sweepSources(o: {
  documents: readonly SweepDocument[];
  wanted: readonly WantedField[];
  /** The session's own identity, from `/voyager/api/me`. Not a filter — any hit
   *  whose value is one of these is *marked*, so a parser is never written
   *  against the operator's own identity thinking it found the subject's. */
  selfValues?: readonly string[];
}): SweepResult {
  const selfValues = (o.selfValues ?? []).map(normalize).filter((v) => v !== "");
  const isSelf = (want: WantedField): boolean => selfValues.includes(normalize(want.value));

  const hits = new Map<string, SweepHit[]>();
  let nodesWalked = 0;
  let truncated = false;

  const collect = (
    field: string,
    source: SourceKind,
    file: string,
    self: boolean,
    found: Walked["hits"],
    prefix = "",
  ): void => {
    const list = hits.get(field) ?? [];
    for (const hit of found) {
      list.push({ field, source, file, path: `${prefix}${hit.path}`, match: hit.match, via: hit.via, self });
    }
    hits.set(field, list);
  };

  for (const doc of o.documents) {
    if (doc.kind === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(doc.body);
      } catch {
        // Not JSON at all — an image, an html error page, a redirect body.
        continue;
      }
      const found = walkJson(parsed, o.wanted);
      nodesWalked += found.nodes;
      truncated ||= found.truncated;
      for (const want of o.wanted) {
        collect(want.field, "voyager-body", doc.file, isSelf(want), found.get(want.field) ?? []);
      }
      continue;
    }

    if (doc.kind === "document-html") {
      for (const embedded of embeddedJsonOf(doc.body)) {
        // The script element is the *root* of the path, not a string glued to
        // the front of one: `script#state → $.name` resolves, `script#state →
        // $$.name` does not, and a field map may only carry paths that do.
        const found = walkJson(embedded.value, o.wanted, embedded.prefix);
        nodesWalked += found.nodes;
        truncated ||= found.truncated;
        for (const want of o.wanted) {
          collect(want.field, "embedded-json", doc.file, isSelf(want), found.get(want.field) ?? []);
        }
      }
      continue;
    }

    const found = walkDom(doc.body, o.wanted);
    nodesWalked += found.nodes;
    truncated ||= found.truncated;
    for (const want of o.wanted) {
      collect(want.field, "dom-snapshot", doc.file, isSelf(want), found.get(want.field) ?? []);
    }
  }

  const fields: FieldVerdict[] = o.wanted.map((want) => {
    const all = (hits.get(want.field) ?? []).slice().sort(
      (a, b) =>
        SOURCE_PREFERENCE.indexOf(a.source) - SOURCE_PREFERENCE.indexOf(b.source) ||
        // Exact before contains: an exact hit is a path a parser reads directly.
        (a.match === b.match ? 0 : a.match === "exact" ? -1 : 1),
    );
    const best = all[0]?.source ?? null;
    return {
      field: want.field,
      what: want.what ?? "",
      source: best,
      hits: all.slice(0, MAX_HITS_PER_FIELD),
      omitted: Math.max(0, all.length - MAX_HITS_PER_FIELD),
      trap: all.some((h) => h.self),
    };
  });

  return {
    fields,
    absent: fields.filter((f) => f.source === null).map((f) => f.field),
    domOnly: fields.filter((f) => f.source === "dom-snapshot").map((f) => f.field),
    documents: o.documents.length,
    nodesWalked,
    truncated,
  };
}

/**
 * The sweep as the committed FIELD-MAP document.
 *
 * **No captured value is ever printed**, and there is deliberately no flag to
 * print one. The map lands in git while `fixtures/` does not, so it says
 * *where* each field is and the pinning tests beside the gitignored fixture say
 * *what* is there.
 *
 * A samples column would also add nothing: every value here is one the operator
 * stated in `wanted.json`, so the map would be echoing its own input back while
 * turning a committable file into one that leaks whoever the `people` sub-page
 * listed.
 */
export function renderSweep(o: {
  surface: string;
  generatedAt: string;
  sourceRun: string;
  result: SweepResult;
  /** Rendered verbatim under the heading — the sub-page url forms, scroller and
   *  navigation model the probe measured. */
  notes?: readonly string[];
}): string {
  const { result } = o;
  const lines: string[] = [];

  lines.push(`# FIELD-MAP — ${o.surface}`);
  lines.push("");
  lines.push(`Generated ${o.generatedAt} from run \`${o.sourceRun}\`.`);
  lines.push("");
  lines.push(
    "Each row was found by searching for a value the operator read off the rendered page, " +
      "so a hit is the value rather than something the right shape (D128). " +
      "The values themselves are deliberately absent: this file is committed and `fixtures/` " +
      "is not — the pinning tests beside the fixture assert the meaning.",
  );
  lines.push("");

  if (o.notes !== undefined && o.notes.length > 0) {
    lines.push("## What the probe measured");
    lines.push("");
    for (const note of o.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  lines.push("## Verdicts");
  lines.push("");
  lines.push("| field | source | paths | note |");
  lines.push("|---|---|---|---|");
  for (const f of result.fields) {
    const note = f.trap
      ? "⚠ **the value is the session's own identity — a trap, never a source (D119)**"
      : f.source === null
        ? "absent from every source"
        : f.source === "dom-snapshot"
          ? "⚠ DOM-only — blocked on the operator extending the CLAUDE.md exception"
          : "";
    lines.push(`| \`${f.field}\` | ${f.source ?? "_(absent)_"} | ${f.hits.length}${f.omitted > 0 ? ` (+${f.omitted} omitted)` : ""} | ${note} |`);
  }
  lines.push("");

  for (const f of result.fields) {
    lines.push(`### \`${f.field}\``);
    lines.push("");
    if (f.what !== "") {
      lines.push(f.what);
      lines.push("");
    }
    if (f.hits.length === 0) {
      lines.push("⚠ **Not found in any source.** Nothing on this surface carries it, so no parser");
      lines.push("may produce it — leave the column null rather than deriving one (Task 25's rule).");
      lines.push("");
      continue;
    }
    lines.push("| source | file | path | match | via |");
    lines.push("|---|---|---|---|---|");
    for (const hit of f.hits) {
      lines.push(
        `| ${hit.source} | \`${hit.file}\` | \`${hit.path.replace(/\|/g, "\\|")}\` | ${hit.match} | ${hit.via} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Coverage");
  lines.push("");
  lines.push(`- ${result.documents} documents swept, ${result.nodesWalked} nodes walked`);
  if (result.truncated) {
    lines.push("- ⚠ **a walk hit its bound**, so an `absent` verdict here is not proof of absence");
  }
  if (result.domOnly.length > 0) {
    lines.push(
      `- ⚠ **DOM-only fields:** ${result.domOnly.join(", ")} — CONTEXT rule 7 applies, ` +
        "and the consuming tasks stay blocked until the operator's decision lands in `DECISIONS.md`",
    );
  }
  lines.push("");

  return lines.join("\n") + "\n";
}
