import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { parseFilterCatalog } from "./catalog.js";

export const FILTER_CATALOG_PROVENANCE = {
  runId: "01KZQNM34D61NTBDQNDVSZ45AV",
  archiveId: "0014-3ff85d03efb79a26",
  bodySha256: "50e5d2a45dd23b20dc10368ef198431329ba0bf0cdc403b507b8adf14e52cfba",
  scrubbed: [],
} as const;

export const FILTER_CATALOG_FIXTURE = new URL("./test-fixtures/filter-layout.json.gz", import.meta.url);

export function loadPinnedFilterCatalog() {
  const body = gunzipSync(readFileSync(FILTER_CATALOG_FIXTURE));
  const digest = createHash("sha256").update(body).digest("hex");
  if (digest !== FILTER_CATALOG_PROVENANCE.bodySha256) {
    throw new Error(`filter catalog fixture sha256 mismatch: expected ${FILTER_CATALOG_PROVENANCE.bodySha256}, got ${digest}`);
  }
  return parseFilterCatalog(body.toString("utf8"));
}
