import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { defaultRunsDir } from "../run/paths.js";
import { parseSalesNavQuery, rawUrlParam, type QueryObject, type QueryValue } from "./grammar.js";
import type { SalesNavVertical } from "./catalog.js";
import { SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT } from "./archive-fixture.js";

export const PUBLIC_VOCABULARY_PATH = new URL("./vocabulary.registry.json", import.meta.url);
export const PRIVATE_VOCABULARY_FILENAME = "salesnav-filter-vocabulary.private.json";
export const MAX_VOCABULARY_ROWS = 10_000;
export const MAX_PROVENANCE_PER_ROW = 100;
export const MAX_HARVEST_RUNS = 50;
export const MAX_META_FILES_PER_RUN = 1_000;

export type VocabularySource = {
  kind: "request-url" | "archive-body";
  runId: string;
  archiveId: string;
  file: string;
  locator: string;
};

export type VocabularyRow = {
  rowId: string;
  vertical: SalesNavVertical;
  facet: string;
  id: string;
  text: string;
  operatorScoped: boolean;
  provenance: VocabularySource[];
  /** Request-url sources that prove this exact id may omit its `text` field.
   * Empty for the ordinary `(id,text,selectionType)` spelling. */
  textOmissionProvenance: VocabularySource[];
};

export type VocabularyRegistry = {
  version: 1;
  rows: VocabularyRow[];
};

export type VocabularyHarvestWarning = {
  code: "VOCAB_META_INVALID" | "VOCAB_META_UNREADABLE" | "VOCAB_RESPONSE_STATUS_SKIPPED" |
    "VOCAB_QUERY_INVALID" | "VOCAB_BODY_INVALID";
  runId: string;
  archiveId: string;
  file: string;
};

export type VocabularyWriteOps = {
  writeFile: typeof writeFile;
  rename: typeof rename;
  unlink: typeof unlink;
};

const VOCABULARY_WRITE_OPS: VocabularyWriteOps = { writeFile, rename, unlink };

export const OPERATOR_SCOPED_FACETS = new Set([
  "ACCOUNT_LIST", "LEAD_LIST", "PERSONA", "LEADS_IN_CRM", "ACCOUNTS_IN_CRM",
]);

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function vocabularyIdentity(row: Pick<VocabularyRow, "vertical" | "facet" | "id">): string {
  return `${row.vertical}\0${row.facet}\0${row.id}`;
}

export function vocabularyRowId(row: Pick<VocabularyRow, "vertical" | "facet" | "id" | "text">): string {
  return createHash("sha256")
    .update(`${row.vertical}\0${row.facet}\0${row.id}\0${row.text}`)
    .digest("hex")
    .slice(0, 24);
}

function sourceIdentity(source: VocabularySource): string {
  return `${source.kind}\0${source.runId}\0${source.archiveId}\0${source.locator}`;
}

export class VocabularyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "VocabularyError";
  }
}

export function validateVocabularyRegistry(value: unknown): VocabularyRegistry {
  const root = record(value);
  if (root?.["version"] !== 1 || !Array.isArray(root["rows"])) {
    throw new VocabularyError("VOCAB_REGISTRY_INVALID", "vocabulary registry must be version 1 with a rows array");
  }
  if (root["rows"].length > MAX_VOCABULARY_ROWS) {
    throw new VocabularyError("VOCAB_REGISTRY_BOUNDED", `vocabulary registry exceeds ${MAX_VOCABULARY_ROWS} rows`);
  }
  const rows: VocabularyRow[] = [];
  const identities = new Map<string, VocabularyRow>();
  for (const [index, candidate] of root["rows"].entries()) {
    const row = record(candidate);
    const vertical = row?.["vertical"];
    const facet = nonempty(row?.["facet"]);
    const id = nonempty(row?.["id"]);
    const text = nonempty(row?.["text"]);
    const rowId = nonempty(row?.["rowId"]);
    const provenance = row?.["provenance"];
    const omissionProvenance = row?.["textOmissionProvenance"];
    if ((vertical !== "LEAD" && vertical !== "ACCOUNT") || facet === null || id === null || text === null ||
        rowId === null || typeof row?.["operatorScoped"] !== "boolean" || !Array.isArray(provenance) || provenance.length === 0 ||
        provenance.length > MAX_PROVENANCE_PER_ROW || !Array.isArray(omissionProvenance) || omissionProvenance.length > MAX_PROVENANCE_PER_ROW) {
      throw new VocabularyError("VOCAB_ROW_INVALID", `vocabulary row ${index} is missing identity, scope, or provenance`);
    }
    const sourceOf = (sourceCandidate: unknown, sourceIndex: number, label: string): VocabularySource => {
      const source = record(sourceCandidate);
      const kind = source?.["kind"];
      const runId = nonempty(source?.["runId"]);
      const archiveId = nonempty(source?.["archiveId"]);
      const file = nonempty(source?.["file"]);
      const locator = nonempty(source?.["locator"]);
      if ((kind !== "request-url" && kind !== "archive-body") || runId === null || archiveId === null || file === null || locator === null) {
        throw new VocabularyError("VOCAB_PROVENANCE_INVALID", `vocabulary row ${index} ${label} ${sourceIndex} is incomplete`);
      }
      return { kind, runId, archiveId, file, locator };
    };
    const sources: VocabularySource[] = provenance.map((candidate, sourceIndex) => sourceOf(candidate, sourceIndex, "provenance"));
    const omissionSources: VocabularySource[] = omissionProvenance.map((candidate, sourceIndex) => sourceOf(candidate, sourceIndex, "text omission provenance"));
    if (omissionSources.some((source) => source.kind !== "request-url")) {
      throw new VocabularyError("VOCAB_PROVENANCE_INVALID", `vocabulary row ${index} text omission is not request-url evidence`);
    }
    const parsed: VocabularyRow = {
      rowId, vertical, facet, id, text,
      operatorScoped: row["operatorScoped"],
      provenance: sources,
      textOmissionProvenance: omissionSources,
    };
    if (vocabularyRowId(parsed) !== rowId) {
      throw new VocabularyError("VOCAB_ROW_ID_INVALID", `vocabulary row ${index} has a rowId that does not match its content`);
    }
    if (parsed.operatorScoped !== OPERATOR_SCOPED_FACETS.has(parsed.facet)) {
      throw new VocabularyError("VOCAB_SCOPE_INVALID", `vocabulary row ${rowId} has the wrong operator-scoped classification`);
    }
    const identity = vocabularyIdentity(parsed);
    const previous = identities.get(identity);
    if (previous && previous.text !== parsed.text) {
      throw new VocabularyError("VOCAB_ID_CONFLICT", `${vertical}/${facet}/${id} resolves to more than one display text`);
    }
    if (previous) throw new VocabularyError("VOCAB_ROW_DUPLICATE", `vocabulary row ${rowId} duplicates ${previous.rowId}`);
    identities.set(identity, parsed);
    rows.push(parsed);
  }
  return { version: 1, rows };
}

export async function readVocabularyFile(path: string | URL): Promise<VocabularyRegistry> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, rows: [] };
    throw cause;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new VocabularyError("VOCAB_REGISTRY_INVALID", `vocabulary registry ${String(path)} is not JSON`);
  }
  return validateVocabularyRegistry(parsed);
}

export function mergeVocabularyRegistries(...registries: readonly VocabularyRegistry[]): VocabularyRegistry {
  const merged = new Map<string, VocabularyRow>();
  for (const registry of registries) {
    for (const row of registry.rows) {
      const identity = vocabularyIdentity(row);
      const previous = merged.get(identity);
      if (previous && previous.text !== row.text) {
        throw new VocabularyError("VOCAB_ID_CONFLICT", `${row.vertical}/${row.facet}/${row.id} has conflicting display text`);
      }
      if (previous) {
        const sources = new Map(previous.provenance.map((source) => [sourceIdentity(source), source]));
        for (const source of row.provenance) sources.set(sourceIdentity(source), source);
        previous.provenance = [...sources.values()].sort((a, b) => sourceIdentity(a).localeCompare(sourceIdentity(b)));
        const omissions = new Map(previous.textOmissionProvenance.map((source) => [sourceIdentity(source), source]));
        for (const source of row.textOmissionProvenance) omissions.set(sourceIdentity(source), source);
        previous.textOmissionProvenance = [...omissions.values()].sort((a, b) => sourceIdentity(a).localeCompare(sourceIdentity(b)));
        if (previous.provenance.length > MAX_PROVENANCE_PER_ROW || previous.textOmissionProvenance.length > MAX_PROVENANCE_PER_ROW) {
          throw new VocabularyError("VOCAB_REGISTRY_BOUNDED", `${row.vertical}/${row.facet}/${row.id} exceeds ${MAX_PROVENANCE_PER_ROW} provenance sources`);
        }
      } else {
        merged.set(identity, {
          ...row,
          provenance: [...row.provenance],
          textOmissionProvenance: [...row.textOmissionProvenance],
        });
      }
    }
  }
  return { version: 1, rows: [...merged.values()].sort(compareRows) };
}

function compareRows(a: VocabularyRow, b: VocabularyRow): number {
  return a.vertical.localeCompare(b.vertical) || a.facet.localeCompare(b.facet) ||
    a.text.localeCompare(b.text) || a.id.localeCompare(b.id);
}

export function privateVocabularyPath(runsDir = defaultRunsDir()): string {
  return join(runsDir, PRIVATE_VOCABULARY_FILENAME);
}

export async function loadVocabulary(options: {
  publicPath?: string | URL;
  privatePath?: string | URL;
} = {}): Promise<VocabularyRegistry> {
  return mergeVocabularyRegistries(
    await readVocabularyFile(options.publicPath ?? PUBLIC_VOCABULARY_PATH),
    await readVocabularyFile(options.privatePath ?? privateVocabularyPath()),
  );
}

function entry(object: QueryObject, key: string): QueryValue | null {
  return object.entries.find((candidate) => candidate.key === key)?.value ?? null;
}

function atomOf(value: QueryValue | null): string | null {
  return value?.kind === "atom" ? value.value : null;
}

type TextOmission = {
  vertical: SalesNavVertical;
  facet: string;
  id: string;
  source: VocabularySource;
};

function queryVocabulary(ast: QueryObject, vertical: SalesNavVertical, source: Omit<VocabularySource, "locator">): {
  rows: VocabularyRow[];
  omissions: TextOmission[];
} {
  const filters = entry(ast, "filters");
  if (filters?.kind !== "list") return { rows: [], omissions: [] };
  const rows: VocabularyRow[] = [];
  const omissions: TextOmission[] = [];
  filters.items.forEach((candidate, filterIndex) => {
    if (candidate.kind !== "object") return;
    const facet = atomOf(entry(candidate, "type"));
    const values = entry(candidate, "values");
    if (facet === null || values?.kind !== "list") return;
    values.items.forEach((valueCandidate, valueIndex) => {
      if (valueCandidate.kind !== "object") return;
      const id = atomOf(entry(valueCandidate, "id"));
      const text = atomOf(entry(valueCandidate, "text"));
      if (id === null) return;
      const locatedSource = { ...source, locator: `query.filters[${filterIndex}].values[${valueIndex}]` };
      if (text === null) {
        omissions.push({ vertical, facet, id, source: locatedSource });
        return;
      }
      const base = { vertical, facet, id, text };
      rows.push({
        ...base,
        rowId: vocabularyRowId(base),
        operatorScoped: OPERATOR_SCOPED_FACETS.has(facet),
        provenance: [locatedSource],
        textOmissionProvenance: [],
      });
    });
  });
  return { rows, omissions };
}

function savedSearchVocabulary(body: string, vertical: SalesNavVertical, source: Omit<VocabularySource, "locator">): VocabularyRow[] {
  const root = record(JSON.parse(body));
  const elements = root?.["elements"];
  if (!Array.isArray(elements)) return [];
  const rows: VocabularyRow[] = [];
  elements.forEach((elementCandidate, elementIndex) => {
    const filters = record(elementCandidate)?.["filters"];
    if (!Array.isArray(filters)) return;
    filters.forEach((wrapperCandidate, filterIndex) => {
      const metadata = record(record(wrapperCandidate)?.["singleFilterMetadata"]);
      const facet = nonempty(metadata?.["type"]);
      const values = metadata?.["values"];
      if (facet === null || !Array.isArray(values)) return;
      values.forEach((valueCandidate, valueIndex) => {
        const value = record(valueCandidate);
        const id = nonempty(value?.["id"]);
        const text = nonempty(value?.["displayValue"]);
        if (id === null || text === null) return;
        const base = { vertical, facet, id, text };
        rows.push({
          ...base,
          rowId: vocabularyRowId(base),
          operatorScoped: OPERATOR_SCOPED_FACETS.has(facet),
          provenance: [{
            ...source,
            locator: `$.elements[${elementIndex}].filters[${filterIndex}].singleFilterMetadata.values[${valueIndex}]`,
          }],
          textOmissionProvenance: [],
        });
      });
    });
  });
  return rows;
}

export async function harvestVocabulary(options: {
  runsDir?: string;
  runIds: readonly string[];
  onWarning?: (warning: VocabularyHarvestWarning) => void;
}): Promise<VocabularyRegistry> {
  const runsDir = resolve(options.runsDir ?? defaultRunsDir());
  if (options.runIds.length === 0 || options.runIds.length > MAX_HARVEST_RUNS) {
    throw new VocabularyError("VOCAB_HARVEST_BOUNDED", `harvest needs 1-${MAX_HARVEST_RUNS} run ids`);
  }
  const registries: VocabularyRegistry[] = [];
  const omissions: TextOmission[] = [];
  for (const runId of options.runIds) {
    if (!/^[A-Z0-9]+$/.test(runId)) throw new VocabularyError("VOCAB_RUN_ID_INVALID", `invalid run id ${JSON.stringify(runId)}`);
    const rawDir = join(runsDir, runId, "raw");
    const files = await readdir(rawDir).catch((cause) => {
      throw new VocabularyError("VOCAB_RUN_UNREADABLE", `cannot read archive for run ${runId}: ${String(cause)}`);
    });
    const metaFiles = files.filter((candidate) => candidate.endsWith(".meta.json")).sort();
    if (metaFiles.length > MAX_META_FILES_PER_RUN) {
      throw new VocabularyError("VOCAB_HARVEST_BOUNDED", `run ${runId} exceeds ${MAX_META_FILES_PER_RUN} meta files`);
    }
    for (const file of metaFiles) {
      const metaPath = join(rawDir, file);
      const archiveId = file.slice(0, -".meta.json".length);
      const relativeFile = relative(runsDir, metaPath);
      const warn = (code: VocabularyHarvestWarning["code"]) => options.onWarning?.({ code, runId, archiveId, file: relativeFile });
      let metadata: Json | null;
      try {
        metadata = record(JSON.parse(await readFile(metaPath, "utf8")));
      } catch (cause) {
        warn((cause as NodeJS.ErrnoException).code === undefined ? "VOCAB_META_INVALID" : "VOCAB_META_UNREADABLE");
        continue;
      }
      const url = nonempty(metadata?.["url"]);
      if (metadata === null || url === null) {
        warn("VOCAB_META_INVALID");
        continue;
      }
      let parsedUrl: URL;
      try { parsedUrl = new URL(url, "https://www.linkedin.com"); } catch {
        warn("VOCAB_META_INVALID");
        continue;
      }
      const leadSearch = /\/sales-api\/salesApiLeadSearch$/i.test(parsedUrl.pathname);
      const accountSearch = /\/sales-api\/salesApiAccountSearch$/i.test(parsedUrl.pathname);
      const savedSearches = /\/sales-api\/salesApiSavedSearchesV2$/i.test(parsedUrl.pathname);
      if (!leadSearch && !accountSearch && !savedSearches) continue;
      const status = metadata["status"];
      if (typeof status !== "number" || status < 200 || status >= 300) {
        warn("VOCAB_RESPONSE_STATUS_SKIPPED");
        continue;
      }
      const sourceBase = { runId, archiveId, file: relativeFile };
      if (leadSearch || accountSearch) {
        const raw = rawUrlParam(url, "query");
        if (raw === null) continue;
        const vertical: SalesNavVertical = leadSearch ? "LEAD" : "ACCOUNT";
        let observed: ReturnType<typeof queryVocabulary>;
        try {
          observed = queryVocabulary(parseSalesNavQuery(raw), vertical, { ...sourceBase, kind: "request-url" });
        } catch {
          warn("VOCAB_QUERY_INVALID");
          continue;
        }
        registries.push({ version: 1, rows: observed.rows });
        omissions.push(...observed.omissions);
      }
      if (savedSearches) {
        const q = parsedUrl.searchParams.get("q");
        const vertical: SalesNavVertical | null = q === "savedPeopleSearches" ? "LEAD" : q === "savedCompanySearches" ? "ACCOUNT" : null;
        if (vertical === null) continue;
        const bodyPath = join(rawDir, `${archiveId}.json.gz`);
        let rows: VocabularyRow[];
        try {
          const body = gunzipSync(await readFile(bodyPath)).toString("utf8");
          rows = savedSearchVocabulary(body, vertical, {
            ...sourceBase,
            kind: "archive-body",
            file: relative(runsDir, bodyPath),
          });
        } catch {
          warn("VOCAB_BODY_INVALID");
          continue;
        }
        registries.push({
          version: 1,
          rows,
        });
      }
    }
  }
  const merged = mergeVocabularyRegistries(...registries);
  for (const omission of omissions) {
    const row = merged.rows.find((candidate) => candidate.vertical === omission.vertical && candidate.facet === omission.facet && candidate.id === omission.id);
    if (row === undefined) continue; // An id with no measured display text is not vocabulary.
    const sources = new Map(row.textOmissionProvenance.map((source) => [sourceIdentity(source), source]));
    sources.set(sourceIdentity(omission.source), omission.source);
    row.textOmissionProvenance = [...sources.values()].sort((a, b) => sourceIdentity(a).localeCompare(sourceIdentity(b)));
  }
  if (merged.rows.length > MAX_VOCABULARY_ROWS) {
    throw new VocabularyError("VOCAB_HARVEST_BOUNDED", `harvest exceeds ${MAX_VOCABULARY_ROWS} vocabulary rows`);
  }
  return merged;
}

export async function writeVocabularyFile(
  path: string,
  registry: VocabularyRegistry,
  operations: VocabularyWriteOps = VOCABULARY_WRITE_OPS,
): Promise<void> {
  const validated = validateVocabularyRegistry(registry);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp.${process.pid}.${randomUUID()}`;
  try {
    await operations.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await operations.rename(temporary, path);
  } catch (cause) {
    await operations.unlink(temporary).catch(() => {});
    throw cause;
  }
}

export function splitVocabulary(registry: VocabularyRegistry): { publicRows: VocabularyRegistry; privateRows: VocabularyRegistry } {
  return {
    publicRows: { version: 1, rows: registry.rows.filter((row) => !row.operatorScoped) },
    privateRows: { version: 1, rows: registry.rows.filter((row) => row.operatorScoped) },
  };
}

async function auditVocabularyRowAt(row: VocabularyRow, runsDir: string): Promise<{ ok: boolean; checked: number }> {
  let checked = 0;
  const byRun = new Map<string, VocabularyRegistry>();
  for (const source of [...row.provenance, ...row.textOmissionProvenance]) {
    let harvested = byRun.get(source.runId);
    if (harvested === undefined) {
      harvested = await harvestVocabulary({ runsDir, runIds: [source.runId] });
      byRun.set(source.runId, harvested);
    }
    checked++;
    const resolved = harvested.rows.some((candidate) =>
      candidate.vertical === row.vertical && candidate.facet === row.facet &&
      candidate.id === row.id && candidate.text === row.text &&
      [...candidate.provenance, ...candidate.textOmissionProvenance]
        .some((candidateSource) => sourceIdentity(candidateSource) === sourceIdentity(source))
    );
    if (!resolved) return { ok: false, checked };
  }
  return { ok: checked > 0, checked };
}

export async function auditVocabularyRow(row: VocabularyRow, runsDir?: string): Promise<{ ok: boolean; checked: number }> {
  if (runsDir !== undefined) return auditVocabularyRowAt(row, runsDir);
  try {
    return await auditVocabularyRowAt(row, defaultRunsDir());
  } catch (cause) {
    if (!(cause instanceof VocabularyError) || cause.code !== "VOCAB_RUN_UNREADABLE") throw cause;
    return auditVocabularyRowAt(row, SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT);
  }
}
