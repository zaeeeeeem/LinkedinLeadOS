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
] as const;

const BODY_SOURCES = [
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0037-6721a5820194c523"],
  ["01KZQCS8XZDDYSDGMT5SB81YBS", "0039-93b72711dc6cac2e"],
] as const;

type Json = Record<string, unknown>;
type ManifestRow = {
  runId: string;
  archiveId: string;
  kind: "request-meta" | "saved-search-body";
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

async function writeFixture(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
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

const manifestBody = `${JSON.stringify({
  version: 1,
  policy: [
    "operator-owned saved-search ids and labels",
    "seat data and operator-authored keywords",
    "operator-scoped filter ids and display text",
    "per-execution session values",
  ],
  sources: manifest.sort((a, b) => a.fixture.localeCompare(b.fixture)),
}, null, 2)}\n`;
await writeFixture(join(FIXTURE_ROOT, "manifest.json"), manifestBody);
process.stdout.write(`${JSON.stringify({ fixture_root: relative(REPO_ROOT, FIXTURE_ROOT), sources: manifest.length })}\n`);
