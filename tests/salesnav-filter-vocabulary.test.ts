import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_HARVEST_RUNS,
  MAX_PROVENANCE_PER_ROW,
  MAX_VOCABULARY_ROWS,
  VocabularyError,
  auditVocabularyRow,
  harvestVocabulary,
  mergeVocabularyRegistries,
  splitVocabulary,
  validateVocabularyRegistry,
  writeVocabularyFile,
} from "../src/core/salesnav-query/index.js";

const RUNS = [
  "01KZQCS8XZDDYSDGMT5SB81YBS", "01KZQFCFMVYKAC082JXDRVCAN3",
  "01KZQ5TXC23T3FFBJ72P8CE85J", "01KZP693DEWVP0S90K7C7XQ997",
  "01KZQNM34D61NTBDQNDVSZ45AV",
];

describe("Sales Navigator archive vocabulary", () => {
  it("harvests only archive-backed rows and keeps operator scope out of the public split", async () => {
    const harvested = await harvestVocabulary({ runIds: RUNS });
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

  it("audits a row independently by re-reading its named archive", async () => {
    const harvested = await harvestVocabulary({ runIds: RUNS });
    const row = harvested.rows.find((candidate) => candidate.facet === "REGION")!;
    await expect(auditVocabularyRow(row)).resolves.toEqual({ ok: true, checked: row.provenance.length + row.textOmissionProvenance.length });
    const mutated = { ...row, provenance: row.provenance.map((source) => ({ ...source, locator: `${source.locator}.wrong` })) };
    await expect(auditVocabularyRow(mutated)).resolves.toMatchObject({ ok: false });
  });

  it("makes a dropped provenance list fail validation", async () => {
    const harvested = await harvestVocabulary({ runIds: RUNS });
    const mutation = structuredClone(harvested) as unknown as { version: 1; rows: Array<Record<string, unknown>> };
    mutation.rows[0]!["provenance"] = [];
    expect(() => validateVocabularyRegistry(mutation)).toThrowError(VocabularyError);
    expect(() => validateVocabularyRegistry(mutation)).toThrow(/provenance/);
  });

  it("refuses a public/private identity conflict instead of shadowing", async () => {
    const harvested = await harvestVocabulary({ runIds: RUNS });
    const row = harvested.rows.find((candidate) => !candidate.operatorScoped)!;
    const conflicting = { ...row, text: `${row.text} changed`, rowId: "000000000000000000000000" };
    expect(() => mergeVocabularyRegistries({ version: 1, rows: [row] }, { version: 1, rows: [conflicting] }))
      .toThrow(/conflicting display text/);
  });

  it("writes a complete registry atomically enough to read as one JSON document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "salesnav-vocab-"));
    const path = join(dir, "registry.json");
    const harvested = await harvestVocabulary({ runIds: RUNS });
    await writeVocabularyFile(path, harvested);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(harvested);
    await writeFile(path, "{", "utf8");
    await expect(readFile(path, "utf8")).resolves.toBe("{");
  });

  it("bounds archive fan-out, registry size, and accumulated provenance", async () => {
    await expect(harvestVocabulary({ runIds: Array.from({ length: MAX_HARVEST_RUNS + 1 }, () => "RUN") }))
      .rejects.toMatchObject({ code: "VOCAB_HARVEST_BOUNDED" });
    expect(() => validateVocabularyRegistry({ version: 1, rows: Array.from({ length: MAX_VOCABULARY_ROWS + 1 }, () => ({})) }))
      .toThrowError(expect.objectContaining({ code: "VOCAB_REGISTRY_BOUNDED" }));
    const harvested = await harvestVocabulary({ runIds: RUNS });
    const row = harvested.rows[0]!;
    const many = Array.from({ length: MAX_PROVENANCE_PER_ROW + 1 }, (_, index) => ({
      ...row.provenance[0]!, archiveId: `archive-${index}`,
    }));
    expect(() => validateVocabularyRegistry({ version: 1, rows: [{ ...row, provenance: many }] }))
      .toThrowError(expect.objectContaining({ code: "VOCAB_ROW_INVALID" }));
  });
});
