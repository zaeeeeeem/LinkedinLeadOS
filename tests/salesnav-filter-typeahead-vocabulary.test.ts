import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  harvestVocabulary,
  splitVocabulary,
  validateVocabularyRegistry,
  type VocabularyRow,
} from "../src/core/salesnav-query/index.js";
import { TYPEAHEAD_FIXTURE_RUNS } from "./helpers/salesnav-query-fixtures.js";

/** Build a throwaway archive shaped exactly like a real run directory: one
 * `.meta.json` naming the request, one gzipped body beside it. */
async function archiveWith(
  captures: ReadonlyArray<{ archiveId: string; url: string; body: unknown; status?: number }>,
): Promise<{ runsDir: string; runId: string }> {
  const runsDir = await mkdtemp(join(tmpdir(), "salesnav-typeahead-"));
  const runId = "01TYPEAHEADFIXTURE00000000";
  const rawDir = join(runsDir, runId, "raw");
  await mkdir(rawDir, { recursive: true });
  for (const capture of captures) {
    await writeFile(
      join(rawDir, `${capture.archiveId}.meta.json`),
      JSON.stringify({ url: capture.url, status: capture.status ?? 200, method: "GET" }),
    );
    await writeFile(join(rawDir, `${capture.archiveId}.json.gz`), gzipSync(JSON.stringify(capture.body)));
  }
  return { runsDir, runId };
}

function typeaheadUrl(type: string, query?: string): string {
  const suffix = query === undefined ? "" : `&query=${query}`;
  return `https://www.linkedin.com/sales-api/salesApiFacetTypeahead?q=query&start=0&count=100&type=${type}${suffix}`;
}

function elements(...pairs: ReadonlyArray<readonly [string, string]>): { elements: unknown[] } {
  return { elements: pairs.map(([id, displayValue]) => ({ id, displayValue })) };
}

async function harvest(
  captures: ReadonlyArray<{ archiveId: string; url: string; body: unknown; status?: number }>,
): Promise<VocabularyRow[]> {
  const { runsDir, runId } = await archiveWith(captures);
  const registry = await harvestVocabulary({ runsDir, runIds: [runId] });
  return registry.rows;
}

function keys(rows: readonly VocabularyRow[]): string[] {
  return rows.map((row) => `${row.vertical}/${row.facet}/${row.id}`).sort();
}

describe("Sales Navigator typeahead vocabulary", () => {
  it("keys a closed enum on the filters the catalog says use that typeahead type", async () => {
    const rows = await harvest([{
      archiveId: "0056-seniority",
      url: typeaheadUrl("SENIORITY_V2"),
      body: elements(["310", "CXO"], ["320", "Owner / Partner"]),
    }]);

    expect(keys(rows)).toEqual(["LEAD/SENIORITY_LEVEL/310", "LEAD/SENIORITY_LEVEL/320"]);
    expect(rows.find((row) => row.id === "310")?.text).toBe("CXO");
  });

  it.each([
    ["COMPANY_WITH_LIST", "1035", "A Real Company Inc"],
    ["CONNECTION_OF", "urn:li:fsd_profile:ABC", "A Real Person"],
    ["SCHOOL", "1792", "A Real University"],
  ])("refuses %s outright — its suggestions are entities, not taxonomy", async (type, id, displayValue) => {
    const rows = await harvest([{
      archiveId: `0100-${type.toLowerCase()}`,
      url: typeaheadUrl(type),
      body: elements([id, displayValue]),
    }]);

    expect(rows).toEqual([]);
  });

  it("fans one shared list out to every filter that draws on it", async () => {
    const rows = await harvest([{
      archiveId: "0086-tenure",
      url: typeaheadUrl("TENURE"),
      body: elements(["1", "Less than 1 year"]),
    }]);

    expect(keys(rows)).toEqual([
      "LEAD/YEARS_AT_CURRENT_COMPANY/1",
      "LEAD/YEARS_IN_CURRENT_POSITION/1",
      "LEAD/YEARS_OF_EXPERIENCE/1",
    ]);
  });

  it("keeps the two verticals' headcount ids in separate namespaces (D445)", async () => {
    const rows = await harvest([
      { archiveId: "0038-lead-size", url: typeaheadUrl("COMPANY_SIZE"), body: elements(["C", "11-50 lead-side"]) },
      {
        archiveId: "0040-account-size",
        url: typeaheadUrl("COMPANY_SIZE_ACCOUNT_SEARCH"),
        body: elements(["C", "11-50 account-side"]),
      },
    ]);

    expect(keys(rows)).toEqual(["ACCOUNT/COMPANY_HEADCOUNT/C", "LEAD/COMPANY_HEADCOUNT/C"]);
    const lead = rows.find((row) => row.vertical === "LEAD");
    const account = rows.find((row) => row.vertical === "ACCOUNT");
    expect(lead?.text).toBe("11-50 lead-side");
    expect(account?.text).toBe("11-50 account-side");
    expect(lead?.rowId).not.toBe(account?.rowId);
  });

  it("marks an operator's own saved lists operator-scoped so the split keeps them private", async () => {
    const rows = await harvest([{
      archiveId: "0083-lists",
      url: typeaheadUrl("ACCOUNT_LIST"),
      body: { elements: [{ id: "88", displayValue: "My private list", listEntitiesCount: 12 }] },
    }]);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.operatorScoped)).toBe(true);
  });

  it("ignores a typeahead type no catalog filter draws on", async () => {
    const rows = await harvest([{
      archiveId: "0200-unknown",
      url: typeaheadUrl("A_TYPE_THE_CATALOG_NEVER_NAMES"),
      body: elements(["1", "Something"]),
    }]);

    expect(rows).toEqual([]);
  });

  it("skips a non-2xx typeahead response rather than trusting its body", async () => {
    const rows = await harvest([{
      archiveId: "0300-throttled",
      url: typeaheadUrl("SENIORITY_V2"),
      status: 429,
      body: elements(["310", "CXO"]),
    }]);

    expect(rows).toEqual([]);
  });

  it("drops an element missing its display text instead of inventing one", async () => {
    const rows = await harvest([{
      archiveId: "0400-partial",
      url: typeaheadUrl("SENIORITY_V2"),
      body: { elements: [{ id: "310" }, { id: "320", displayValue: "Owner / Partner" }] },
    }]);

    expect(keys(rows)).toEqual(["LEAD/SENIORITY_LEVEL/320"]);
  });

  it("adds no rows on a second harvest of the same archive", async () => {
    const { runsDir, runId } = await archiveWith([{
      archiveId: "0056-seniority",
      url: typeaheadUrl("SENIORITY_V2"),
      body: elements(["310", "CXO"], ["320", "Owner / Partner"]),
    }]);

    const first = await harvestVocabulary({ runsDir, runIds: [runId] });
    const second = await harvestVocabulary({ runsDir, runIds: [runId, runId] });

    expect(second.rows).toHaveLength(first.rows.length);
    expect(second.rows.every((row) => row.provenance.length === 1)).toBe(true);
  });
});

describe("the measured Task 43 typeahead archives", () => {
  async function harvestFixtures(): Promise<VocabularyRow[]> {
    const registry = await harvestVocabulary({
      runsDir: SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
      runIds: TYPEAHEAD_FIXTURE_RUNS,
    });
    return registry.rows;
  }

  it("resolves the closed enums the venture composes with, keyed per vertical", async () => {
    const rows = await harvestFixtures();
    const value = (vertical: string, facet: string, id: string): string | undefined =>
      rows.find((row) => row.vertical === vertical && row.facet === facet && row.id === id)?.text;

    expect(value("LEAD", "SENIORITY_LEVEL", "310")).toBe("CXO");
    expect(value("LEAD", "SENIORITY_LEVEL", "320")).toBe("Owner / Partner");
    expect(value("ACCOUNT", "COMPANY_HEADCOUNT", "D")).toBe("51-200");
    expect(value("ACCOUNT", "FORTUNE", "1")).toBe("Fortune 50");
    expect(value("ACCOUNT", "JOB_OPPORTUNITIES", "JO1")).toBe("Hiring on Linkedin");
    // The two headcount enums overlap on B-I but are not the same set: `A` is
    // Self-employed on Lead search and is not a member on Account search. That
    // partial overlap is why the store is keyed per vertical (D445) — a
    // cross-vertical id often validates instead of failing loudly.
    expect(value("LEAD", "COMPANY_HEADCOUNT", "A")).toBe("Self-employed");
    expect(value("ACCOUNT", "COMPANY_HEADCOUNT", "A")).toBeUndefined();
    // Same shape in the relationship enums: `F` exists on both sides with
    // different capitalization, `S` only on Lead.
    expect(value("LEAD", "RELATIONSHIP", "S")).toBe("2nd degree connections");
    expect(value("ACCOUNT", "RELATIONSHIP", "S")).toBeUndefined();
    expect(value("LEAD", "RELATIONSHIP", "F")).toBe("1st degree connections");
    expect(value("ACCOUNT", "RELATIONSHIP", "F")).toBe("1st Degree Connections");
  });

  it("gives every harvested row provenance back to a named archive", async () => {
    const rows = await harvestFixtures();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.provenance.length).toBeGreaterThan(0);
      for (const source of row.provenance) {
        expect(TYPEAHEAD_FIXTURE_RUNS).toContain(source.runId);
        expect(source.kind).toBe("archive-body");
        expect(source.archiveId).toMatch(/^\d{4}-[0-9a-f]+$/);
      }
    }
  });

  it("promotes nothing operator-scoped out of these two runs", async () => {
    const { publicRows, privateRows } = splitVocabulary(
      validateVocabularyRegistry({ version: 1, rows: await harvestFixtures() }),
    );

    expect(privateRows.rows).toHaveLength(0);
    expect(publicRows.rows.every((row) => !row.operatorScoped)).toBe(true);
  });
});
