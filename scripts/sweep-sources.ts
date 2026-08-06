#!/usr/bin/env -S npx tsx
/**
 * Answers, for one archived run: which source carries each field, and where.
 *
 *   npm run sweep -- --run=<runId> --surface="company page family" \
 *     --want='name=Acme Robotics' --want='website=acme.example' --out=docs/capabilities/company-surface-field-map.md
 *
 *   npm run sweep -- --run=<runId> --want-file=fixtures/company.get/wanted.json
 *
 * Nothing here touches LinkedIn or the browser: it reads files a capture already
 * wrote. Safe to re-run.
 *
 * The `--want` values are ground truth the operator read off the rendered page.
 * The sweep looks for each one in every archived body, in the embedded JSON of
 * the document response, and in the DOM snapshot, and reports which source
 * carries it — so no parser is ever designed against a guessed key name (D152).
 *
 * Only counts, paths and field names reach stdout, and the rendered map carries
 * no captured value at all — the values are the ones the operator stated, and
 * the pinning tests beside the gitignored fixture assert the meaning.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { RawArchive } from "../src/core/archive/raw.js";
import { isDomSnapshotEntry } from "../src/capabilities/profile.capture/snapshot.js";
import { isPrivateEndpoint, personUrnsIn } from "../src/core/fixtures/promote.js";
import { renderSweep, sweepSources } from "../src/core/fixtures/sweep.js";
import type { SweepDocument, WantedField } from "../src/core/fixtures/sweep.js";
import { defaultRunsDir } from "../src/core/run/paths.js";

type Options = {
  run: string | null;
  latest: boolean;
  surface: string;
  wanted: WantedField[];
  wantFile: string | null;
  runsDir: string;
  out: string | null;
  notes: string[];
};

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "usage: npm run sweep -- (--run=<runId> | --latest) [--surface=<name>] " +
      "(--want=<field>=<value> ... | --want-file=<path>) [--note=<line>] " +
      "[--out=<path>] [--runs-dir=<dir>]\n",
  );
  process.exit(1);
}

function parse(argv: string[]): Options {
  const o: Options = {
    run: null, latest: false, surface: "company page family", wanted: [],
    wantFile: null, runsDir: defaultRunsDir(), out: null, notes: [],
  };
  for (const token of argv) {
    if (!token.startsWith("--")) usage(`unknown argument ${token}`);
    const name = token.slice(2).split("=")[0]!;
    const value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : null;
    switch (name) {
      case "run": o.run = value ?? usage("--run needs a run id"); break;
      case "latest": o.latest = true; break;
      case "surface": o.surface = value ?? usage("--surface needs a name"); break;
      case "want": {
        const raw = value ?? usage("--want needs <field>=<value>");
        const at = raw.indexOf("=");
        if (at <= 0) usage(`--want needs <field>=<value>, got ${raw}`);
        o.wanted.push({ field: raw.slice(0, at), value: raw.slice(at + 1) });
        break;
      }
      case "want-file": o.wantFile = resolve(value ?? usage("--want-file needs a path")); break;
      case "note": o.notes.push(value ?? usage("--note needs a line")); break;
      case "out": o.out = resolve(value ?? usage("--out needs a path")); break;
      case "runs-dir": o.runsDir = resolve(value ?? usage("--runs-dir needs a path")); break;
      default: usage(`unknown argument ${token}`);
    }
  }
  if (o.run === null && !o.latest) usage("name the run: --run=<runId>, or --latest");
  return o;
}

/** `[{ "field": "name", "value": "Acme", "what": "companies.name" }, …]` — the
 *  form that survives shell quoting, which a company name with a comma does not. */
function readWantFile(path: string): WantedField[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    usage(`--want-file ${path} could not be read as json: ${String(cause)}`);
  }
  if (!Array.isArray(parsed)) usage(`--want-file ${path} must hold an array of {field, value}`);
  return parsed.map((row, i) => {
    const r = row as Record<string, unknown>;
    if (typeof r["field"] !== "string" || typeof r["value"] !== "string") {
      usage(`--want-file ${path} row ${i} needs string "field" and "value"`);
    }
    return {
      field: r["field"],
      value: r["value"],
      ...(typeof r["what"] === "string" ? { what: r["what"] } : {}),
    };
  });
}

function latestRun(runsDir: string): string {
  if (!existsSync(runsDir)) usage(`no runs directory at ${runsDir}`);
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "run.json")))
    .map((e) => ({ name: e.name, mtime: statSync(join(runsDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) usage(`no runs found under ${runsDir}`);
  return candidates[0]!.name;
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const wanted = [...o.wanted, ...(o.wantFile === null ? [] : readWantFile(o.wantFile))];
  if (wanted.length === 0) usage("nothing to look for: pass --want or --want-file");

  const runId = o.run ?? latestRun(o.runsDir);
  const archiveDir = join(o.runsDir, runId, "raw");
  if (!existsSync(archiveDir)) usage(`run ${runId} has no raw/ directory at ${archiveDir}`);

  const archive = new RawArchive(archiveDir);
  const documents: SweepDocument[] = [];
  const selfValues = new Set<string>();
  const unreadable: string[] = [];
  let privateSkipped = 0;

  for (const entry of await archive.list()) {
    const snapshot = isDomSnapshotEntry(entry);
    // A private endpoint is the operator's own correspondence and is never a
    // fixture candidate (D118). A snapshot has no endpoint — its url is
    // synthetic — so this is not asked of it.
    if (!snapshot && isPrivateEndpoint(entry.url)) {
      privateSkipped++;
      continue;
    }
    let body: string;
    try {
      body = await archive.readText(entry);
    } catch {
      unreadable.push(entry.file);
      continue;
    }
    if (/\/voyager\/api\/me\b/.test(entry.url)) {
      for (const urn of personUrnsIn(body)) selfValues.add(urn);
    }
    if (snapshot) {
      documents.push({ file: entry.file, kind: "dom-snapshot", body });
      continue;
    }
    try {
      JSON.parse(body);
      documents.push({ file: entry.file, kind: "json", body });
    } catch {
      // Not JSON: the initial document response, most often. Only its embedded
      // structured JSON is read from it — never its markup (D117).
      documents.push({ file: entry.file, kind: "document-html", body });
    }
  }

  const result = sweepSources({ documents, wanted, selfValues: [...selfValues] });

  if (o.out !== null) {
    writeFileSync(
      o.out,
      renderSweep({
        surface: o.surface,
        generatedAt: new Date().toISOString(),
        sourceRun: runId,
        result,
        notes: o.notes,
      }),
      "utf8",
    );
  }

  // Field names, sources and counts only. Never a captured value.
  process.stdout.write(
    JSON.stringify(
      {
        run: runId,
        documents: result.documents,
        private_endpoints_skipped: privateSkipped,
        unreadable,
        session_urns_found: selfValues.size,
        nodes_walked: result.nodesWalked,
        truncated: result.truncated,
        verdicts: result.fields.map((f) => ({
          field: f.field,
          source: f.source,
          hits: f.hits.length,
          omitted: f.omitted,
          trap: f.trap,
        })),
        absent: result.absent,
        dom_only: result.domOnly,
        field_map: o.out,
      },
      null,
      2,
    ) + "\n",
  );

  if (result.domOnly.length > 0) {
    process.stderr.write(
      `[DECISION NEEDED] ${result.domOnly.length} field(s) are carried only by the rendered DOM: ` +
        `${result.domOnly.join(", ")}. CLAUDE.md's network-tap exception covers the profile reader ` +
        "and nothing else; extending it to this surface is the operator's decision and must land in " +
        "DECISIONS.md before any parser reads them.\n",
    );
  }
  if (result.absent.length > 0) {
    process.stderr.write(
      `${result.absent.length} field(s) were found in no source: ${result.absent.join(", ")}. ` +
        "Either the value stated does not appear as written, or this surface does not carry it.\n",
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
