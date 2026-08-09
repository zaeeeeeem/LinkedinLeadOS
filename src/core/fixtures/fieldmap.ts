/**
 * Where things actually live in a captured JSON body.
 *
 * A parser has to be written against real paths, and LinkedIn's are deep,
 * GraphQL-enveloped, and not guessable from memory. Rather than a human reading
 * a 2MB body and writing a document by hand — which is slow and goes stale the
 * next time the response shifts — this walks the body and reports every path
 * whose key or value looks like the field a parser is hunting for.
 *
 * Pure and offline: the input is a parsed JSON value, the output is data. It is
 * therefore provable against synthetic trees, which is what lets its bounds be
 * tested rather than assumed.
 */

/**
 * One thing a parser author needs to find.
 *
 * `key` matches the property name, `value` matches a string value, `number`
 * matches a numeric value, `object` matches a node by the shape of its own
 * keys. A probe may use any combination; a node matches if any of them does.
 *
 * `number` exists because `value` only ever sees strings, and the one question
 * Task 26 had to answer — does any source carry an *absolute* timestamp — is
 * about epoch millis, which are numbers. Without it a body full of
 * `createdAt: 1754697600000` reports as carrying no timestamp at all (D224).
 */
export type FieldProbe = {
  name: string;
  /** One line, for the rendered map. Says what a parser would do with this. */
  what: string;
  key?: RegExp;
  /** A `RegExp` satisfies this structurally; a shape predicate that is not
   *  expressible as one (`looksIso8601` parses as well as matches) satisfies it
   *  too, without a cast. */
  value?: StringMatcher;
  number?: (value: number) => boolean;
  object?: (keys: readonly string[]) => boolean;
};

/** Anything that can say yes or no about a string. `RegExp` is the usual one. */
export type StringMatcher = { test(value: string): boolean };

/** One place a probe matched, grouped across array indices. */
export type FieldHit = {
  /** A concrete, copy-pasteable path into the body: `$.data.elements[0].firstName`. */
  path: string;
  /** The same path with array indices collapsed: `$.data.elements[].firstName`. */
  template: string;
  /** How many concrete paths shared this template. */
  count: number;
  /** A truncated rendering of the value found there. */
  sample: string;
  /** True when the value found here is the session's own identity rather than
   *  the subject's. A parser written against such a path scores green offline
   *  and returns the operator's own account forever (D119). */
  self: boolean;
};

export type ProbeReport = {
  name: string;
  what: string;
  hits: FieldHit[];
  /** True when more templates matched than `MAX_TEMPLATES_PER_PROBE` allows. */
  truncated: boolean;
};

export type FieldMap = {
  probes: ProbeReport[];
  nodesWalked: number;
  /** True when the walk stopped at `MAX_NODES` — the map describes a prefix of
   *  the body, not all of it, and a parser author must know that. */
  walkTruncated: boolean;
  /** Depth at which the walk stopped descending, if it ever did. */
  depthTruncated: boolean;
};

/**
 * Bounds. A LinkedIn profile response is large and deeply nested, and a field
 * map is a development aid — it must never be the thing that runs a machine out
 * of memory. Each of these is exceeded by a test rather than assumed roomy.
 */
export const MAX_NODES = 200_000;
export const MAX_DEPTH = 64;
export const MAX_TEMPLATES_PER_PROBE = 25;
export const MAX_SAMPLE_CHARS = 120;

/** What a person parser (Task 16) has to locate. Ordered as a parser reads them. */
export const PROFILE_PROBES: readonly FieldProbe[] = [
  {
    name: "person_urn",
    what: "the person's stable identity — the store's primary key (§7)",
    value: /^urn:li:(fsd_profile|fs_profile|fs_salesProfile|member):/,
  },
  {
    name: "vanity",
    what: "the /in/<vanity> slug",
    key: /^(publicIdentifier|vanityName)$/,
  },
  { name: "first_name", what: "given name", key: /^firstName$/ },
  { name: "last_name", what: "family name", key: /^lastName$/ },
  { name: "full_name", what: "pre-joined display name, when the response has one", key: /^(fullName|formattedName)$/ },
  { name: "headline", what: "the headline under the name", key: /^(headline|occupation)$/ },
  {
    name: "location",
    what: "where the person is",
    key: /^(locationName|geoLocationName|defaultLocalizedName|geoCountryName|geoRegion|locality|country)$/,
  },
  {
    name: "experience",
    what: "the container holding positions — walk this for experience rows",
    key: /^(positions|positionGroups|profilePositionGroups|positionView|experience)$/,
  },
  { name: "position_title", what: "job title on one position", key: /^(title|jobTitle)$/ },
  { name: "position_company", what: "employer on one position", key: /^(companyName|company)$/ },
  {
    name: "position_dates",
    what: "start/end of one position",
    key: /^(dateRange|timePeriod|startedOn|endedOn|startDate|endDate)$/,
  },
  {
    name: "company_urn",
    what: "the employer's own urn, for the company tables",
    value: /^urn:li:(fsd_company|fs_normalized_company|company):/,
  },
  { name: "education", what: "schools", key: /^(educations|educationView|profileEducations)$/ },
  { name: "skills", what: "skills", key: /^(skills|skillView|profileSkills)$/ },
  { name: "about", what: "the about/summary text", key: /^(summary|about)$/ },
  {
    name: "connections",
    what: "connection count",
    key: /^(numOfConnections|connectionsCount|numConnections|connectionsCountFormatted)$/,
  },
  {
    name: "graphql_envelope",
    what: "how the response is wrapped — where a parser has to start from",
    object: (keys) => keys.includes("data") || keys.includes("included") || keys.includes("elements"),
  },
];

function sampleOf(value: unknown): string {
  if (Array.isArray(value)) return `[array, ${value.length} item${value.length === 1 ? "" : "s"}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return `{object, keys: ${keys.slice(0, 6).join(", ")}${keys.length > 6 ? ", …" : ""}}`;
  }
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  return text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}…` : text;
}

/** `$.a.b[3].c` → `$.a.b[].c`, so one shape reports once instead of 40 times. */
function templateOf(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

function matches(probe: FieldProbe, key: string | null, value: unknown): boolean {
  if (probe.key && key !== null && probe.key.test(key)) return true;
  if (probe.value && typeof value === "string" && probe.value.test(value)) return true;
  if (probe.number && typeof value === "number" && Number.isFinite(value) && probe.number(value)) return true;
  if (probe.object && value !== null && typeof value === "object" && !Array.isArray(value)) {
    if (probe.object(Object.keys(value as Record<string, unknown>))) return true;
  }
  return false;
}

/**
 * Walks a parsed JSON value and reports where each probe matched.
 *
 * The walk is iterative rather than recursive: a 2MB GraphQL body nests deeply
 * enough that recursion is a stack-overflow risk on exactly the input this
 * exists for, and a crash here would take out the promotion of an already-spent
 * capture.
 */
export function buildFieldMap(
  root: unknown,
  probes: readonly FieldProbe[] = PROFILE_PROBES,
  o: {
    /** Values that are the session's own identity, not the subject's. A hit on
     *  one is reported and marked, never dropped — an operator needs to see
     *  that the only `person_urn` in a body is their own. */
    selfValues?: readonly string[];
  } = {},
): FieldMap {
  const selfValues = (o.selfValues ?? []).filter((v) => v !== "");
  const isSelf = (value: unknown): boolean =>
    typeof value === "string" && selfValues.some((v) => value === v || value.includes(v));

  // Grouped as we go: template → first concrete path, count, first sample.
  const found = new Map<string, Map<string, { path: string; count: number; sample: string; self: boolean }>>();
  for (const p of probes) found.set(p.name, new Map());

  const seen = new WeakSet<object>();
  const stack: Array<{ value: unknown; key: string | null; path: string; depth: number }> = [
    { value: root, key: null, path: "$", depth: 0 },
  ];

  let nodesWalked = 0;
  let walkTruncated = false;
  let depthTruncated = false;

  while (stack.length > 0) {
    const node = stack.pop()!;
    if (nodesWalked >= MAX_NODES) {
      walkTruncated = true;
      break;
    }
    nodesWalked++;

    for (const probe of probes) {
      if (!matches(probe, node.key, node.value)) continue;
      const byTemplate = found.get(probe.name)!;
      const template = templateOf(node.path);
      const existing = byTemplate.get(template);
      if (existing) {
        existing.count++;
      } else if (byTemplate.size < MAX_TEMPLATES_PER_PROBE) {
        byTemplate.set(template, {
          path: node.path, count: 1, sample: sampleOf(node.value), self: isSelf(node.value),
        });
      } else {
        // Over the cap: record that it happened rather than dropping it silently.
        byTemplate.set("…", byTemplate.get("…") ?? { path: "…", count: 0, sample: "", self: false });
        byTemplate.get("…")!.count++;
      }
    }

    const value = node.value;
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (node.depth >= MAX_DEPTH) {
      depthTruncated = true;
      continue;
    }

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], key: node.key, path: `${node.path}[${i}]`, depth: node.depth + 1 });
      }
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, v] = entries[i]!;
        stack.push({ value: v, key: k, path: `${node.path}.${k}`, depth: node.depth + 1 });
      }
    }
  }

  const report: ProbeReport[] = probes.map((p) => {
    const byTemplate = found.get(p.name)!;
    const overflow = byTemplate.get("…");
    const hits: FieldHit[] = [...byTemplate.entries()]
      .filter(([template]) => template !== "…")
      .map(([template, hit]) => ({
        path: hit.path, template, count: hit.count, sample: hit.sample, self: hit.self,
      }));
    return { name: p.name, what: p.what, hits, truncated: overflow !== undefined };
  });

  return { probes: report, nodesWalked, walkTruncated, depthTruncated };
}

/** The field map as the markdown document Task 16's parser is written against. */
export function renderFieldMap(o: {
  capability: string;
  generatedAt: string;
  fixtures: Array<{
    file: string;
    path: string;
    queryId: string | null;
    status: number;
    bytes: number;
    shapeHash: string;
    sourceRun: string;
    /** Whether this body actually names the capture's subject. `null` for a
     *  fixture promoted before that was recorded. */
    subjectMatch?: boolean | null;
    map: FieldMap | null;
    /** Why there is no map: the body was not JSON. */
    note?: string;
  }>;
  /** Pre-rendered sections for the DOM snapshots (D123). They are html rather
   *  than JSON, so they carry their own map; they lead the document because the
   *  snapshot is where the profile's content actually is. */
  domSections?: readonly string[];
}): string {
  const lines: string[] = [];
  lines.push(`# Field map — \`${o.capability}\``);
  lines.push("");
  lines.push(`Generated ${o.generatedAt} by \`npm run fixtures:promote\`. Do not edit by hand —`);
  lines.push("re-run promotion instead. This file is gitignored along with the fixtures it describes.");
  lines.push("");
  lines.push("Every path below is a real path into the file named in its section, discovered by");
  lines.push("walking the captured body. `$` is the parsed root; `[]` means the path repeated");
  lines.push("across array indices and the concrete path shown is the first one.");
  lines.push("");

  for (const section of o.domSections ?? []) {
    lines.push(section.replace(/\n$/, ""));
    lines.push("");
  }

  for (const f of o.fixtures) {
    lines.push(`## \`${f.file}\``);
    lines.push("");
    lines.push(`- endpoint: \`${f.path}\``);
    lines.push(`- graphql operation: ${f.queryId ? `\`${f.queryId}\`` : "_(not a graphql call)_"}`);
    lines.push(`- http status: ${f.status} · ${f.bytes} bytes · shape \`${f.shapeHash}\``);
    lines.push(`- captured by run \`${f.sourceRun}\``);
    if (f.subjectMatch === false) {
      lines.push("- ⚠ **does not name the capture's subject** — do not write a parser against this body");
    } else if (f.subjectMatch === true) {
      lines.push("- names the capture's subject");
    }
    lines.push("");

    if (!f.map) {
      lines.push(`_${f.note ?? "no field map available"}_`);
      lines.push("");
      continue;
    }

    const hitting = f.map.probes.filter((p) => p.hits.length > 0);
    const missing = f.map.probes.filter((p) => p.hits.length === 0);

    if (hitting.length === 0) {
      lines.push("_No probe matched anything in this body._");
      lines.push("");
    }

    for (const probe of hitting) {
      lines.push(`### ${probe.name}`);
      lines.push("");
      lines.push(`${probe.what}`);
      lines.push("");
      lines.push("| path | seen | sample |");
      lines.push("|---|---|---|");
      for (const hit of probe.hits) {
        const marker = hit.self ? " ⚠ session's own identity" : "";
        lines.push(`| \`${hit.template}\` | ${hit.count} | ${mdCell(hit.sample)}${marker} |`);
      }
      if (probe.truncated) {
        lines.push(`| _(more than ${MAX_TEMPLATES_PER_PROBE} distinct paths — list truncated)_ | | |`);
      }
      lines.push("");

      const usable = probe.hits.filter((h) => !h.self);
      if (usable.length === 0) {
        // The exact trap this marking exists for: every path here resolves to
        // the logged-in account, so a parser built on them returns the operator
        // for every prospect and passes its own tests doing it.
        lines.push(
          "⚠ **Every path above is the session's own identity, not the subject's.** " +
            "There is no usable path for this field in this body.",
        );
      } else {
        lines.push(`First concrete path: \`${usable[0]!.path}\``);
      }
      lines.push("");
    }

    if (missing.length > 0) {
      lines.push(`**Not found in this body:** ${missing.map((p) => `\`${p.name}\``).join(", ")}`);
      lines.push("");
    }
    if (f.map.walkTruncated || f.map.depthTruncated) {
      lines.push(
        `> ⚠ The walk stopped early (${f.map.nodesWalked} nodes` +
          `${f.map.walkTruncated ? `, node cap ${MAX_NODES} reached` : ""}` +
          `${f.map.depthTruncated ? `, depth cap ${MAX_DEPTH} reached` : ""}). This map is partial.`,
      );
      lines.push("");
    }
  }

  return lines.join("\n") + "\n";
}

/** Keeps a sample from breaking the table it sits in. */
function mdCell(text: string): string {
  const escaped = text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  return `\`${escaped}\``;
}
