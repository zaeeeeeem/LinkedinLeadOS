/** Promote Task 41's measured request metadata and saved-search bodies into a
 * committed, archive-shaped fixture after removing operator-owned values.
 *
 * This script reads only already-paid archives. It performs no network I/O.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  OPERATOR_SCOPED_FACETS,
  REFUSED_TYPEAHEAD_TYPES,
  parseSalesNavQuery,
  rawUrlParam,
  serializeSalesNavQuery,
  type QueryObject,
  type QueryValue,
} from "../src/core/salesnav-query/index.js";
import { defaultRunsDir } from "../src/core/run/paths.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNS_ROOT = defaultRunsDir();
const FIXTURE_ROOT = resolve(REPO_ROOT, "src/core/salesnav-query/test-fixtures/archive");

const META_SOURCES = [
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0037-6721a5820194c523"],
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0039-93b72711dc6cac2e"],
  ["01KZQFCFMVYKAC082JXDRVCAN3", "0016-c413e8471fda6d7e"],
  ["01KZQFCFMVYKAC082JXDRVCAN3", "0066-1ba9d64ca68d9915"],
  ["01KZQ5TXC23T3FFBJ72P8CE85J", "0016-67ea927af64cc179"],
  ["01KZP693DEWVP0S90K7C7XQ997", "0018-f371faaa3af8763b"],
  ["01KZQNM34D61NTBDQNDVSZ45AV", "0015-bb6d235df6f31471"],
  ["01KZQNM34D61NTBDQNDVSZ45AV", "0041-7da00af0f64d100c"],
  ["01KZSZF6MXC6HHP9Z4RQBHXP19", "0016-5e81b94c63cd41b8"],
] as const;

/** Closed-enum typeahead bodies from the Task 43 operator-driven harvests.
 * Public taxonomy only: the promoter refuses anything D442 scopes to the
 * operator or refuses outright, so a mistake here fails the build rather than
 * quietly committing an operator's data. */
const TYPEAHEAD_SOURCES = [
  ["01KZR9KTGPVR1BB03WPQS6YVMB", "0056-f836d3b836631df0", "SENIORITY_V2"],
  ["01KZR9KTGPVR1BB03WPQS6YVMB", "0086-f836d3b836631df0", "TENURE"],
  ["01KZR9KTGPVR1BB03WPQS6YVMB", "0038-f836d3b836631df0", "COMPANY_SIZE"],
  ["01KZR9KTGPVR1BB03WPQS6YVMB", "0043-f836d3b836631df0", "COMPANY_TYPE"],
  ["01KZR9KTGPVR1BB03WPQS6YVMB", "0164-f836d3b836631df0", "RELATIONSHIP"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0040-f836d3b836631df0", "COMPANY_SIZE_ACCOUNT_SEARCH"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0084-f836d3b836631df0", "FORTUNE"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0069-f836d3b836631df0", "NUM_OF_FOLLOWERS"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0074-f836d3b836631df0", "ACCOUNT_ACTIVITIES"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0071-f836d3b836631df0", "JOB_OPPORTUNITIES"],
  ["01KZRAKXXJMTXDV38NEAHJYTF0", "0077-f836d3b836631df0", "RELATIONSHIP_ACCOUNT_SEARCH"],
] as const;

const BODY_SOURCES = [
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0037-6721a5820194c523"],
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0039-93b72711dc6cac2e"],
] as const;

const SEARCH_RESPONSE_SOURCES = [
  ["01KZSZF6MXC6HHP9Z4RQBHXP19", "0016-5e81b94c63cd41b8"],
] as const;

const ENTITY_BEARING_RESPONSE_FILTERS = new Set(["CURRENT_COMPANY", "PAST_COMPANY", "SCHOOL"]);

type Json = Record<string, unknown>;
type ManifestRow = {
  runId: string;
  archiveId: string;
  kind: "request-meta" | "saved-search-body" | "typeahead-body" | "search-response-body";
  sourceSha256: string;
  fixture: string;
  fixtureSha256: string;
  scrubbed: string[];
};

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function child(parent: QueryObject, key: string): QueryValue | null {
  return parent.entries.find((entry) => entry.key === key)?.value ?? null;
}

function atom(parent: QueryObject, key: string): QueryValue | null {
  return child(parent, key);
}

function scrubQuery(raw: string): string {
  const root = parseSalesNavQuery(raw);
  const filters = child(root, "filters");
  if (filters?.kind !== "list") return raw;
  for (const filter of filters.items) {
    if (filter.kind !== "object") continue;
    const facet = atom(filter, "type");
    if (facet?.kind !== "atom" || !OPERATOR_SCOPED_FACETS.has(facet.value)) continue;
    const values = child(filter, "values");
    if (values?.kind !== "list") continue;
    for (const value of values.items) {
      if (value.kind !== "object") continue;
      const id = atom(value, "id");
      const text = atom(value, "text");
      if (id?.kind === "atom") id.value = "SCRUBBED_OPERATOR_FILTER_ID";
      if (text?.kind === "atom") text.value = "Scrubbed operator filter";
    }
  }
  return serializeSalesNavQuery(root);
}

function replaceRawParam(url: string, name: string, replacement: string): string {
  const queryStart = url.indexOf("?");
  if (queryStart === -1) return url;
  const fragmentStart = url.indexOf("#", queryStart);
  const suffix = fragmentStart === -1 ? "" : url.slice(fragmentStart);
  const parts = url.slice(queryStart + 1, fragmentStart === -1 ? undefined : fragmentStart).split("&");
  const replaced = parts.map((part) => {
    const equals = part.indexOf("=");
    const rawKey = equals === -1 ? part : part.slice(0, equals);
    try {
      if (decodeURIComponent(rawKey) === name) return `${rawKey}=${replacement}`;
    } catch { /* An unrelated malformed key is preserved byte-for-byte. */ }
    return part;
  });
  return `${url.slice(0, queryStart + 1)}${replaced.join("&")}${suffix}`;
}

function scrubUrl(url: string): { url: string; scrubbed: string[] } {
  let next = url;
  const scrubbed: string[] = [];
  const query = rawUrlParam(next, "query");
  if (query !== null) {
    const clean = scrubQuery(query);
    if (clean !== query) {
      next = replaceRawParam(next, "query", clean);
      scrubbed.push("query.filters[].operatorScoped.values[].id/text");
    }
  }
  if (rawUrlParam(next, "savedSearchId") !== null) {
    next = replaceRawParam(next, "savedSearchId", "SCRUBBED_SAVED_SEARCH_ID");
    scrubbed.push("savedSearchId");
  }
  if (rawUrlParam(next, "trackingParam") !== null) {
    next = replaceRawParam(next, "trackingParam", "(sessionId:SCRUBBED_SESSION)");
    scrubbed.push("trackingParam.sessionId");
  }
  return { url: next, scrubbed };
}

function scrubSavedSearchBody(body: string): { body: string; scrubbed: string[] } {
  const root = record(JSON.parse(body));
  if (root === null || !Array.isArray(root["elements"])) throw new Error("saved-search body has no elements array");
  const scrubbed = new Set<string>();
  for (const [elementIndex, candidate] of root["elements"].entries()) {
    const element = record(candidate);
    if (element === null) continue;
    for (const [key, replacement] of [
      ["id", "SCRUBBED_SAVED_SEARCH_ID"],
      ["name", "Scrubbed saved search"],
      ["seat", "SCRUBBED_SEAT"],
      ["createdAt", 0],
      ["lastViewedAt", 0],
      ["links", []],
      ["keywords", "Scrubbed keywords"],
    ] as const) {
      if (key in element) {
        element[key] = structuredClone(replacement);
        scrubbed.add(`$.elements[${elementIndex}].${key}`);
      }
    }
    const filters = element["filters"];
    if (!Array.isArray(filters)) continue;
    filters.forEach((wrapperCandidate, filterIndex) => {
      const metadata = record(record(wrapperCandidate)?.["singleFilterMetadata"]);
      const facet = metadata?.["type"];
      const values = metadata?.["values"];
      if (typeof facet !== "string" || !OPERATOR_SCOPED_FACETS.has(facet) || !Array.isArray(values)) return;
      values.forEach((valueCandidate, valueIndex) => {
        const value = record(valueCandidate);
        if (value === null) return;
        if ("id" in value) value["id"] = "SCRUBBED_OPERATOR_FILTER_ID";
        if ("displayValue" in value) value["displayValue"] = "Scrubbed operator filter";
        scrubbed.add(`$.elements[${elementIndex}].filters[${filterIndex}].singleFilterMetadata.values[${valueIndex}].id/displayValue`);
      });
    });
  }
  const sanitized = `${JSON.stringify(root, null, 2)}\n`;
  if (/urn:li:|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(sanitized)) {
    throw new Error("saved-search fixture still contains an identity marker");
  }
  return { body: sanitized, scrubbed: [...scrubbed].sort() };
}

function scrubSearchResponseBody(body: string): { body: string; scrubbed: string[] } {
  const root = record(JSON.parse(body));
  const paging = record(root?.["paging"]);
  const filters = record(root?.["metadata"])?.["filters"];
  if (paging === null || !Array.isArray(filters)) throw new Error("search response lacks paging or metadata.filters");
  for (const key of ["total", "count", "start"] as const) {
    if (typeof paging[key] !== "number" || !Number.isInteger(paging[key]) || (paging[key] as number) < 0) {
      throw new Error(`search response paging.${key} is not a non-negative integer`);
    }
  }
  // The executed session id is the one field Task 44 reads outside paging, and
  // it is measured only here: `$.metadata.tracking.sessionId` (D451). The value
  // is an ephemeral handle to the operator's own search execution, so the
  // fixture keeps the *path* and replaces the value — enough to pin the shape a
  // parser depends on, without committing a live id. Absence is refused rather
  // than promoted quietly: a fixture that lost the field would let the parser
  // pass while the evidence for it disappeared.
  const trackedSession = record(record(root?.["metadata"])?.["tracking"])?.["sessionId"];
  if (typeof trackedSession !== "string" || trackedSession === "") {
    throw new Error("search response lacks metadata.tracking.sessionId");
  }
  const scrubbed = new Set<string>([
    "$.elements",
    "$.metadata.* except filters and tracking.sessionId",
    "$.metadata.tracking.sessionId",
  ]);
  const canonicalFilters: unknown[] = [];
  filters.forEach((wrapperCandidate, filterIndex) => {
    const metadata = record(record(wrapperCandidate)?.["singleFilterMetadata"]);
    const type = metadata?.["type"];
    if (metadata === null || typeof type !== "string") {
      scrubbed.add(`$.metadata.filters[${filterIndex}] (non-single metadata)`);
      return;
    }
    if (ENTITY_BEARING_RESPONSE_FILTERS.has(type)) {
      scrubbed.add(`$.metadata.filters[${filterIndex}] (${type} entity suggestions)`);
      return;
    }
    const values = metadata["values"];
    const canonicalValues = Array.isArray(values) ? values.map((candidate, valueIndex) => {
      const value = record(candidate);
      const keys = value === null ? [] : Object.keys(value).sort();
      if (value === null || keys.some((key) => !["displayCount", "displayValue", "id", "selectionType"].includes(key))) {
        throw new Error(`${type} response value ${valueIndex} has unexpected keys ${keys.join(",")}`);
      }
      const sanitized: { displayCount?: number; displayValue?: string; selectionType?: string; id?: string } = {
        ...(typeof value["displayCount"] === "number" ? { displayCount: value["displayCount"] } : {}),
        ...(typeof value["displayValue"] === "string" ? { displayValue: value["displayValue"] } : {}),
        ...(typeof value["selectionType"] === "string" ? { selectionType: value["selectionType"] } : {}),
        ...(typeof value["id"] === "string" ? { id: value["id"] } : {}),
      };
      if (OPERATOR_SCOPED_FACETS.has(type)) {
        if ("id" in sanitized) sanitized.id = "SCRUBBED_OPERATOR_FILTER_ID";
        if ("displayValue" in sanitized) sanitized.displayValue = "Scrubbed operator filter";
        scrubbed.add(`$.metadata.filters[${filterIndex}].singleFilterMetadata.values[${valueIndex}].id/displayValue`);
      }
      return sanitized;
    }) : [];
    if ("disabledValues" in metadata) {
      scrubbed.add(`$.metadata.filters[${filterIndex}].singleFilterMetadata.disabledValues`);
    }
    canonicalFilters.push({ singleFilterMetadata: { type, values: canonicalValues } });
  });
  const sanitized = `${JSON.stringify({
    paging: { total: paging["total"], count: paging["count"], start: paging["start"] },
    metadata: { filters: canonicalFilters, tracking: { sessionId: "SCRUBBED_SESSION" } },
  }, null, 2)}\n`;
  if (/urn:li:|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(sanitized)) {
    throw new Error("search response fixture still contains an identity marker");
  }
  return { body: sanitized, scrubbed: [...scrubbed].sort() };
}

async function writeFixture(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    const existing = await readFile(path);
    const candidate = typeof bytes === "string" ? Buffer.from(bytes) : Buffer.from(bytes);
    const same = path.endsWith(".json.gz")
      ? gunzipSync(existing).equals(gunzipSync(candidate))
      : existing.equals(candidate);
    if (same) return;
  } catch {
    // Missing or unreadable destinations are written below.
  }
  await writeFile(path, bytes);
}

const manifest: ManifestRow[] = [];
for (const [runId, archiveId] of META_SOURCES) {
  const source = join(RUNS_ROOT, runId, "raw", `${archiveId}.meta.json`);
  const sourceBytes = await readFile(source);
  const metadata = record(JSON.parse(sourceBytes.toString("utf8")));
  if (metadata === null || typeof metadata["url"] !== "string" || typeof metadata["status"] !== "number") {
    throw new Error(`${runId}/${archiveId} metadata lacks url/status`);
  }
  const sanitized = scrubUrl(metadata["url"]);
  const fixtureBody = `${JSON.stringify({ status: metadata["status"], url: sanitized.url }, null, 2)}\n`;
  const target = join(FIXTURE_ROOT, runId, "raw", `${archiveId}.meta.json`);
  await writeFixture(target, fixtureBody);
  manifest.push({
    runId, archiveId, kind: "request-meta", sourceSha256: sha256(sourceBytes),
    fixture: relative(FIXTURE_ROOT, target), fixtureSha256: sha256(fixtureBody), scrubbed: sanitized.scrubbed,
  });
}

for (const [runId, archiveId] of BODY_SOURCES) {
  const source = join(RUNS_ROOT, runId, "raw", `${archiveId}.json.gz`);
  const sourceBytes = await readFile(source);
  const sanitized = scrubSavedSearchBody(gunzipSync(sourceBytes).toString("utf8"));
  const fixtureBytes = gzipSync(sanitized.body, { level: 9 });
  const target = join(FIXTURE_ROOT, runId, "raw", `${archiveId}.json.gz`);
  await writeFixture(target, fixtureBytes);
  manifest.push({
    runId, archiveId, kind: "saved-search-body", sourceSha256: sha256(sourceBytes),
    fixture: relative(FIXTURE_ROOT, target), fixtureSha256: sha256(fixtureBytes), scrubbed: sanitized.scrubbed,
  });
}

for (const [runId, archiveId, typeaheadType] of TYPEAHEAD_SOURCES) {
  if (OPERATOR_SCOPED_FACETS.has(typeaheadType) || REFUSED_TYPEAHEAD_TYPES.has(typeaheadType)) {
    throw new Error(`${typeaheadType} is not public taxonomy and must not be promoted (D442)`);
  }
  const metaSource = join(RUNS_ROOT, runId, "raw", `${archiveId}.meta.json`);
  const metaBytes = await readFile(metaSource);
  const metadata = record(JSON.parse(metaBytes.toString("utf8")));
  const url = metadata?.["url"];
  if (typeof url !== "string" || metadata?.["status"] !== 200) {
    throw new Error(`${runId}/${archiveId} is not a 200 typeahead capture`);
  }
  if (new URL(url).searchParams.get("type") !== typeaheadType) {
    throw new Error(`${runId}/${archiveId} is not a ${typeaheadType} typeahead capture`);
  }
  // `requestId` is the only per-execution value in a typeahead meta file; the
  // url and status are the whole rest of it.
  const metaFixture = `${JSON.stringify({ status: 200, url }, null, 2)}\n`;
  const metaTarget = join(FIXTURE_ROOT, runId, "raw", `${archiveId}.meta.json`);
  await writeFixture(metaTarget, metaFixture);
  manifest.push({
    runId, archiveId, kind: "request-meta", sourceSha256: sha256(metaBytes),
    fixture: relative(FIXTURE_ROOT, metaTarget), fixtureSha256: sha256(metaFixture),
    scrubbed: ["requestId"],
  });

  const bodySource = join(RUNS_ROOT, runId, "raw", `${archiveId}.json.gz`);
  const bodyBytes = await readFile(bodySource);
  const parsed = record(JSON.parse(gunzipSync(bodyBytes).toString("utf8")));
  const elements = parsed?.["elements"];
  if (!Array.isArray(elements) || elements.length === 0) {
    throw new Error(`${runId}/${archiveId} has no typeahead elements`);
  }
  // A closed enum is `(id, displayValue)` and nothing else. Any extra key means
  // the body carries entity detail, which is the signal to stop rather than scrub.
  const canonical = elements.map((candidate) => {
    const element = record(candidate);
    const keys = element === null ? [] : Object.keys(element).sort();
    if (element === null || keys.join(",") !== "displayValue,id") {
      throw new Error(`${runId}/${archiveId} element has unexpected keys ${keys.join(",")}`);
    }
    return { id: element["id"], displayValue: element["displayValue"] };
  });
  const bodyFixture = `${JSON.stringify({ elements: canonical, paging: parsed?.["paging"] ?? null }, null, 2)}\n`;
  if (/urn:li:|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i.test(bodyFixture)) {
    throw new Error(`${runId}/${archiveId} typeahead fixture still contains an identity marker`);
  }
  const bodyGz = gzipSync(bodyFixture, { level: 9 });
  const bodyTarget = join(FIXTURE_ROOT, runId, "raw", `${archiveId}.json.gz`);
  await writeFixture(bodyTarget, bodyGz);
  manifest.push({
    runId, archiveId, kind: "typeahead-body", sourceSha256: sha256(bodyBytes),
    fixture: relative(FIXTURE_ROOT, bodyTarget), fixtureSha256: sha256(bodyGz), scrubbed: [],
  });
}

for (const [runId, archiveId] of SEARCH_RESPONSE_SOURCES) {
  const source = join(RUNS_ROOT, runId, "raw", `${archiveId}.json.gz`);
  const sourceBytes = await readFile(source);
  const sanitized = scrubSearchResponseBody(gunzipSync(sourceBytes).toString("utf8"));
  const fixtureBytes = gzipSync(sanitized.body, { level: 9 });
  const target = join(FIXTURE_ROOT, runId, "raw", `${archiveId}.json.gz`);
  await writeFixture(target, fixtureBytes);
  manifest.push({
    runId, archiveId, kind: "search-response-body", sourceSha256: sha256(sourceBytes),
    fixture: relative(FIXTURE_ROOT, target), fixtureSha256: sha256(fixtureBytes), scrubbed: sanitized.scrubbed,
  });
}

for (const source of manifest) {
  source.fixtureSha256 = sha256(await readFile(join(FIXTURE_ROOT, source.fixture)));
}

const manifestBody = `${JSON.stringify({
  version: 1,
  policy: [
    "operator-owned saved-search ids and labels",
    "seat data and operator-authored keywords",
    "operator-scoped filter ids and display text",
    "per-execution session values",
    "typeahead bodies are promoted only for public taxonomy types, canonicalized to (id, displayValue)",
    "search responses retain paging and filter metadata only; result rows and entity suggestions are removed",
  ],
  sources: manifest.sort((a, b) => a.fixture.localeCompare(b.fixture)),
}, null, 2)}\n`;
await writeFixture(join(FIXTURE_ROOT, "manifest.json"), manifestBody);
process.stdout.write(`${JSON.stringify({ fixture_root: relative(REPO_ROOT, FIXTURE_ROOT), sources: manifest.length })}\n`);
