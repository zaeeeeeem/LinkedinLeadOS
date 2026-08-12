import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export const SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT = fileURLToPath(new URL("./test-fixtures/archive/", import.meta.url));
export const SALESNAV_QUERY_ARCHIVE_MANIFEST = new URL("./test-fixtures/archive/manifest.json", import.meta.url);

export type SalesNavArchiveFixtureSource = {
  runId: string;
  archiveId: string;
  kind: "request-meta" | "saved-search-body" | "typeahead-body" | "search-response-body";
  sourceSha256: string;
  fixture: string;
  fixtureSha256: string;
  scrubbed: string[];
};

export type SalesNavArchiveFixtureManifest = {
  version: 1;
  policy: string[];
  sources: SalesNavArchiveFixtureSource[];
};

/** Load the committed evidence only after verifying every promoted file against
 * the manifest written by the scrub-aware promoter. */
export function loadSalesNavArchiveFixtureManifest(): SalesNavArchiveFixtureManifest {
  const parsed = JSON.parse(readFileSync(SALESNAV_QUERY_ARCHIVE_MANIFEST, "utf8")) as Partial<SalesNavArchiveFixtureManifest>;
  if (parsed.version !== 1 || !Array.isArray(parsed.policy) || !Array.isArray(parsed.sources)) {
    throw new Error("Sales Navigator query fixture manifest is invalid");
  }
  for (const source of parsed.sources) {
    if (typeof source.fixture !== "string" || typeof source.fixtureSha256 !== "string") {
      throw new Error("Sales Navigator query fixture manifest source is incomplete");
    }
    const digest = createHash("sha256")
      .update(readFileSync(join(SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, source.fixture)))
      .digest("hex");
    if (digest !== source.fixtureSha256) {
      throw new Error(`Sales Navigator query fixture sha256 mismatch for ${source.fixture}`);
    }
  }
  return parsed as SalesNavArchiveFixtureManifest;
}
