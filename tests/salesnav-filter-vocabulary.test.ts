import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import vocabCapability from "../src/capabilities/salesnav.filters.vocab/index.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import {
  MAX_HARVEST_RUNS,
  MAX_PROVENANCE_PER_ROW,
  MAX_VOCABULARY_ROWS,
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  VocabularyError,
  auditVocabularyRow,
  harvestVocabulary,
  mergeVocabularyRegistries,
  readVocabularyFile,
  splitVocabulary,
  validateVocabularyRegistry,
  writeVocabularyFile,
  type VocabularyRegistry,
} from "../src/core/salesnav-query/index.js";
import { VOCABULARY_FIXTURE_RUNS } from "./helpers/salesnav-query-fixtures.js";

async function harvestedFixture(): Promise<VocabularyRegistry> {
  return harvestVocabulary({ runsDir: SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, runIds: VOCABULARY_FIXTURE_RUNS });
}

async function capabilityError(args: Record<string, unknown>): Promise<CapabilityError> {
  try {
    await vocabCapability.run({ args: { limit: 50, ...args } } as never);
  } catch (cause) {
    expect(cause).toBeInstanceOf(CapabilityError);
    return cause as CapabilityError;
  }
  throw new Error("expected capability failure");
}

describe("Sales Navigator archive vocabulary", () => {
  it("harvests the committed archive fixture and keeps operator scope out of the public split", async () => {
    const harvested = await harvestedFixture();
    const { publicRows, privateRows } = splitVocabulary(harvested);
    expect(harvested.rows).toHaveLength(10);
    expect(publicRows.rows).toHaveLength(9);
    expect(publicRows.rows.every((row) => !row.operatorScoped)).toBe(true);
    expect(privateRows.rows).toHaveLength(1);
    expect(privateRows.rows[0]?.facet).toBe("PERSONA");
    expect(harvested.rows.every((row) => row.provenance.length > 0)).toBe(true);
    expect(harvested.rows.some((row) => row.textOmissionProvenance.length > 0)).toBe(true);
    expect(new Set(harvested.rows.flatMap((row) => row.provenance.map((source) => source.kind))))
      .toEqual(new Set(["request-url", "archive-body"]));
  });

  it("audits every named source against the committed archive fixture", async () => {
    const harvested = await harvestedFixture();
    const row = harvested.rows.find((candidate) => candidate.facet === "REGION")!;
    await expect(auditVocabularyRow(row, SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT))
      .resolves.toEqual({ ok: true, checked: row.provenance.length + row.textOmissionProvenance.length });
    const mutated = { ...row, provenance: row.provenance.map((source) => ({ ...source, locator: `${source.locator}.wrong` })) };
    await expect(auditVocabularyRow(mutated, SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT)).resolves.toMatchObject({ ok: false });
  });

  it("falls back to committed evidence when the operator run archive is absent", async () => {
    const emptyRuns = await mkdtemp(join(tmpdir(), "salesnav-empty-runs-"));
    const previous = process.env["LINKEDIN_OS_RUNS_DIR"];
    process.env["LINKEDIN_OS_RUNS_DIR"] = emptyRuns;
    try {
      const registry = await readVocabularyFile(new URL("../src/core/salesnav-query/vocabulary.registry.json", import.meta.url));
      await expect(auditVocabularyRow(registry.rows[0]!)).resolves.toMatchObject({ ok: true });
    } finally {
      if (previous === undefined) delete process.env["LINKEDIN_OS_RUNS_DIR"];
      else process.env["LINKEDIN_OS_RUNS_DIR"] = previous;
    }
  });

  it("makes a dropped provenance list fail validation", async () => {
    const harvested = await harvestedFixture();
    const mutation = structuredClone(harvested) as unknown as { version: 1; rows: Array<Record<string, unknown>> };
    mutation.rows[0]!["provenance"] = [];
    expect(() => validateVocabularyRegistry(mutation)).toThrowError(VocabularyError);
    expect(() => validateVocabularyRegistry(mutation)).toThrow(/provenance/);
  });

  it("refuses a public/private identity conflict instead of shadowing", async () => {
    const harvested = await harvestedFixture();
    const row = harvested.rows.find((candidate) => !candidate.operatorScoped)!;
    const conflicting = { ...row, text: `${row.text} changed`, rowId: "000000000000000000000000" };
    expect(() => mergeVocabularyRegistries({ version: 1, rows: [row] }, { version: 1, rows: [conflicting] }))
      .toThrow(/conflicting display text/);
  });

  it("keeps the old registry intact and removes its temp file when atomic rename fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "salesnav-vocab-"));
    const path = join(dir, "registry.json");
    const harvested = await harvestedFixture();
    await writeVocabularyFile(path, harvested);
    const before = await readFile(path, "utf8");
    await expect(writeVocabularyFile(path, harvested, {
      writeFile: fsWriteFile,
      unlink: fsUnlink,
      rename: async (_from, _to) => { throw new Error("injected rename failure"); },
    })).rejects.toThrow("injected rename failure");
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await readdir(dir)).filter((file) => file.includes(".tmp."))).toEqual([]);
  });

  it("skips malformed siblings, exact-endpoint parse failures, and non-2xx captures visibly", async () => {
    const root = await mkdtemp(join(tmpdir(), "salesnav-harvest-"));
    const runId = "FIXTURERUN";
    const raw = join(root, runId, "raw");
    await mkdir(raw, { recursive: true });
    const query = "(filters:List((type:REGION,values:List((id:1,text:One,selectionType:INCLUDED)))))";
    await fsWriteFile(join(raw, "0001-valid.meta.json"), JSON.stringify({
      status: 200, url: `/sales-api/salesApiAccountSearch?q=searchQuery&query=${query}`,
    }));
    await fsWriteFile(join(raw, "0002-invalid.meta.json"), "{");
    await fsWriteFile(join(raw, "0003-bad-query.meta.json"), JSON.stringify({
      status: 200, url: "/sales-api/salesApiAccountSearch?q=searchQuery&query=not-a-query",
    }));
    await fsWriteFile(join(raw, "0004-typeahead.meta.json"), JSON.stringify({
      status: 200, url: "/sales-api/salesApiLeadSearchFilterTypeahead?q=searchQuery&query=not-a-query",
    }));
    await fsWriteFile(join(raw, "0005-rate.meta.json"), JSON.stringify({
      status: 429, url: `/sales-api/salesApiAccountSearch?q=searchQuery&query=${query}`,
    }));
    await fsWriteFile(join(raw, "0006-bad-body.meta.json"), JSON.stringify({
      status: 200, url: "/sales-api/salesApiSavedSearchesV2?q=savedCompanySearches",
    }));
    await fsWriteFile(join(raw, "0006-bad-body.json.gz"), gzipSync("{"));
    const warnings: string[] = [];
    const harvested = await harvestVocabulary({ runsDir: root, runIds: [runId], onWarning: (warning) => warnings.push(warning.code) });
    expect(harvested.rows).toHaveLength(1);
    expect(warnings.sort()).toEqual([
      "VOCAB_BODY_INVALID", "VOCAB_META_INVALID", "VOCAB_QUERY_INVALID", "VOCAB_RESPONSE_STATUS_SKIPPED",
    ]);
  });

  it("classifies bad run arguments as usage and corrupt registries as parse drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "salesnav-vocab-errors-"));
    const invalidRun = await capabilityError({ operation: "harvest", runIds: "bad-run", runsDir: root, publicVocabPath: join(root, "public.json"), privateVocabPath: join(root, "private.json") });
    expect(invalidRun).toMatchObject({ code: "VOCAB_RUN_ID_INVALID", exit: EXIT.GENERIC });
    const unreadable = await capabilityError({ operation: "harvest", runIds: "MISSING", runsDir: root, publicVocabPath: join(root, "public.json"), privateVocabPath: join(root, "private.json") });
    expect(unreadable).toMatchObject({ code: "VOCAB_RUN_UNREADABLE", exit: EXIT.GENERIC });
    const corrupt = join(root, "corrupt.json");
    await fsWriteFile(corrupt, "{");
    const drift = await capabilityError({ operation: "list", vertical: "ACCOUNT", facet: "REGION", publicVocabPath: corrupt, privateVocabPath: join(root, "missing.json") });
    expect(drift).toMatchObject({ code: "VOCAB_REGISTRY_INVALID", exit: EXIT.PARSE_DRIFT });
  });

  it("bounds archive fan-out, registry size, and accumulated provenance", async () => {
    await expect(harvestVocabulary({ runIds: Array.from({ length: MAX_HARVEST_RUNS + 1 }, () => "RUN") }))
      .rejects.toMatchObject({ code: "VOCAB_HARVEST_BOUNDED" });
    expect(() => validateVocabularyRegistry({ version: 1, rows: Array.from({ length: MAX_VOCABULARY_ROWS + 1 }, () => ({})) }))
      .toThrowError(expect.objectContaining({ code: "VOCAB_REGISTRY_BOUNDED" }));
    const harvested = await harvestedFixture();
    const row = harvested.rows[0]!;
    const many = Array.from({ length: MAX_PROVENANCE_PER_ROW + 1 }, (_, index) => ({
      ...row.provenance[0]!, archiveId: `archive-${index}`,
    }));
    expect(() => validateVocabularyRegistry({ version: 1, rows: [{ ...row, provenance: many }] }))
      .toThrowError(expect.objectContaining({ code: "VOCAB_ROW_INVALID" }));
  });
});
