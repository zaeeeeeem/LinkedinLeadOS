import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  loadSalesNavArchiveFixtureManifest,
} from "../../core/salesnav-query/archive-fixture.js";
import { requestQuery } from "./parse.js";

const RUN_ID = "01KZSZF6MXC6HHP9Z4RQBHXP19";
const ARCHIVE_ID = "0016-5e81b94c63cd41b8";

describe("Task 42 promoted built-url evidence", () => {
  it("pins the scrubbed request/response pair to the source archive", () => {
    const manifest = loadSalesNavArchiveFixtureManifest();
    const pair = manifest.sources.filter((source) => source.runId === RUN_ID && source.archiveId === ARCHIVE_ID);
    expect(pair.map((source) => source.kind).sort()).toEqual(["request-meta", "search-response-body"]);

    const meta = JSON.parse(readFileSync(join(
      SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, RUN_ID, "raw", `${ARCHIVE_ID}.meta.json`,
    ), "utf8"));
    const query = requestQuery(meta.url);
    expect(query).toContain("SCRUBBED_OPERATOR_FILTER_ID");

    const body = JSON.parse(gunzipSync(readFileSync(join(
      SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, RUN_ID, "raw", `${ARCHIVE_ID}.json.gz`,
    ))).toString("utf8"));
    expect(body.paging).toEqual({ total: 8_380_089, count: 25, start: 0 });
    expect(body).not.toHaveProperty("elements");
    expect(body.metadata.filters).toHaveLength(16);
    const types = body.metadata.filters.map((wrapper: any) => wrapper.singleFilterMetadata.type);
    expect(types).not.toEqual(expect.arrayContaining(["CURRENT_COMPANY", "PAST_COMPANY", "SCHOOL"]));
    const persona = body.metadata.filters.find((wrapper: any) => wrapper.singleFilterMetadata.type === "PERSONA");
    expect(persona.singleFilterMetadata.values).toEqual([{
      displayValue: "Scrubbed operator filter",
      selectionType: "INCLUDED",
      id: "SCRUBBED_OPERATOR_FILTER_ID",
    }]);
    expect(JSON.stringify(body)).not.toMatch(/urn:li:|@/i);
  });
});
