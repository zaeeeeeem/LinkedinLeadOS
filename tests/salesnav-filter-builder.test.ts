import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FilterBuildError,
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  buildFilterUrl,
  decodeBuiltFilterSpec,
  filterSpecSchema,
  harvestVocabulary,
  loadPinnedFilterCatalog,
  mergeVocabularyRegistries,
  rawUrlParam,
  readVocabularyFile,
  validateVocabularyRegistry,
  type FilterSpec,
  type VocabularyRegistry,
  type VocabularyRow,
} from "../src/core/salesnav-query/index.js";
import { fixtureMeta, VOCABULARY_FIXTURE_RUNS } from "./helpers/salesnav-query-fixtures.js";

function rowId(row: { vertical: string; facet: string; id: string; text: string }): string {
  return createHash("sha256").update(`${row.vertical}\0${row.facet}\0${row.id}\0${row.text}`).digest("hex").slice(0, 24);
}

function syntheticRow(vertical: "LEAD" | "ACCOUNT", facet: string, id: string, text: string): VocabularyRow {
  const row = {
    rowId: "",
    vertical,
    facet,
    id,
    text,
    operatorScoped: false,
    provenance: [{
      kind: "request-url" as const,
      runId: "SYNTHETIC",
      archiveId: "META",
      file: "synthetic",
      locator: "query.filters[0].values[0]",
    }],
    textOmissionProvenance: [],
    requestTextProvenance: [],
  };
  row.rowId = rowId(row);
  return row;
}

async function measuredVocabulary(): Promise<VocabularyRegistry> {
  return mergeVocabularyRegistries(
    await readVocabularyFile(new URL("../src/core/salesnav-query/vocabulary.registry.json", import.meta.url)),
    await harvestVocabulary({ runsDir: SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, runIds: VOCABULARY_FIXTURE_RUNS }),
  );
}

function expectBuildCode(spec: FilterSpec, vocabulary: VocabularyRegistry, code: string): void {
  try { buildFilterUrl(spec, loadPinnedFilterCatalog(), vocabulary); } catch (cause) {
    expect(cause).toBeInstanceOf(FilterBuildError);
    expect((cause as FilterBuildError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

function expectDecodeInvalid(query: string, vocabulary?: VocabularyRegistry): void {
  try { decodeBuiltFilterSpec(query, "ACCOUNT", vocabulary); } catch (cause) {
    expect(cause).toBeInstanceOf(FilterBuildError);
    expect((cause as FilterBuildError).code).toBe("FILTER_QUERY_DECODE_INVALID");
    return;
  }
  throw new Error("expected FILTER_QUERY_DECODE_INVALID");
}

describe("Sales Navigator filter builder", () => {
  it("reconstructs the promoted, scrubbed CXO and account query strings exactly", async () => {
    const vocabulary = await measuredVocabulary();
    const catalog = loadPinnedFilterCatalog();
    for (const measured of [
      { run: "01KZQFCFMVYKAC082JXDRVCAN3", archive: "0016-c413e8471fda6d7e", vertical: "LEAD" as const },
      { run: "01KZQ5TXC23T3FFBJ72P8CE85J", archive: "0016-67ea927af64cc179", vertical: "ACCOUNT" as const },
    ]) {
      const query = rawUrlParam(fixtureMeta(measured.run, measured.archive).url, "query");
      if (query === null) throw new Error("fixture has no query parameter");
      const spec = decodeBuiltFilterSpec(query, measured.vertical, vocabulary);
      const built = buildFilterUrl(spec, catalog, vocabulary);
      expect(built.query).toBe(query);
      expect(decodeBuiltFilterSpec(built.query, measured.vertical, vocabulary)).toEqual(spec);
    }
  });

  it("round-trips generated, vocabulary-backed specs through the strict decoder", () => {
    const catalog = loadPinnedFilterCatalog();
    for (let i = 0; i < 40; i++) {
      const id = `synthetic+${i}==`;
      const text = `Synthetic, cohort: (${i}) café`;
      const vocabulary = { version: 1 as const, rows: [syntheticRow("ACCOUNT", "REGION", id, text)] };
      const spec: FilterSpec = {
        vertical: "ACCOUNT",
        filters: [
          { kind: "values", type: "REGION", values: [{ id, text, selectionType: i % 2 ? "EXCLUDED" : "INCLUDED", emitText: true }] },
          { kind: "range", type: "DEPARTMENT_HEADCOUNT_GROWTH", min: String(i), max: String(i + 10), selectedSubFilter: "8" },
        ],
      };
      const built = buildFilterUrl(spec, catalog, vocabulary);
      expect(decodeBuiltFilterSpec(built.query, "ACCOUNT")).toEqual(spec);
    }
  });

  it("normalizes numeric input at schema ingress and refuses non-canonical range atoms", async () => {
    const vocabulary = await measuredVocabulary();
    const parsed = filterSpecSchema.parse({
      vertical: "ACCOUNT",
      filters: [{ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: 5, max: 10 }],
    });
    expect(parsed.filters[0]).toMatchObject({ min: "5", max: "10" });
    const built = buildFilterUrl(parsed, loadPinnedFilterCatalog(), vocabulary);
    expect(decodeBuiltFilterSpec(built.query, "ACCOUNT")).toEqual(parsed);

    const base = (min: string): FilterSpec => ({ vertical: "ACCOUNT", filters: [{ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min }] });
    expectBuildCode(base(" 5 "), vocabulary, "FILTER_RANGE_INVALID");
    expectBuildCode(base("0x10"), vocabulary, "FILTER_RANGE_INVALID");
    expectBuildCode(base("1e21"), vocabulary, "FILTER_RANGE_INVALID");
    expect(filterSpecSchema.safeParse({ vertical: "ACCOUNT", filters: [{ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: 1e21 }] }).success).toBe(false);
  });

  it("rejects every unknown, duplicate, ambiguous, or schema-invalid decoder field", async () => {
    const vocabulary = await measuredVocabulary();
    for (const query of [
      "(filters:List((type:REGION,values:List((id:1,text:X,selectionType:INCLUDED)),bogus:9)))",
      "(filters:List((type:REGION,type:INDUSTRY,values:List((id:1,text:X,selectionType:INCLUDED)))))",
      "(filters:List((type:REGION,values:List((id:1,text:X,selectionType:INCLUDED,bogus:9)))))",
      "(filters:List((type:REGION,values:List((id:1,text:X,selectionType:INCLUDED)),rangeValue:(min:1))))",
      "(filters:List((type:REGION,values:List())))",
      "(filters:List((type:COMPANY_HEADCOUNT_GROWTH,rangeValue:())))",
      "(filters:List((type:COMPANY_HEADCOUNT_GROWTH,rangeValue:(min:1,bogus:2))))",
      "(filters:List((type:REGION,values:List((id:1,text:X,selectionType:INCLUDED)))),bogus:1)",
    ]) expectDecodeInvalid(query, vocabulary);
  });

  it("enforces measured range inputType/minValue and entity sub-filters", async () => {
    const vocabulary = await measuredVocabulary();
    expectBuildCode({ vertical: "ACCOUNT", filters: [{ kind: "range", type: "DEPARTMENT_HEADCOUNT", min: "-3", selectedSubFilter: "8" }] }, vocabulary, "FILTER_RANGE_VALUE_INVALID");
    expectBuildCode({ vertical: "ACCOUNT", filters: [{ kind: "range", type: "DEPARTMENT_HEADCOUNT", min: "1.5", selectedSubFilter: "8" }] }, vocabulary, "FILTER_RANGE_VALUE_INVALID");

    const postal = syntheticRow("LEAD", "POSTAL_CODE", "90210", "90210");
    const postalVocabulary = { version: 1 as const, rows: [postal] };
    const postalCatalog = loadPinnedFilterCatalog();
    const radius = postalCatalog.find((row) => row.vertical === "LEAD" && row.type === "POSTAL_CODE")!.subFilters[0]!.id;
    const spec: FilterSpec = {
      vertical: "LEAD",
      filters: [{ kind: "values", type: "POSTAL_CODE", values: [{ id: postal.id, text: postal.text, selectionType: "INCLUDED", emitText: true }], selectedSubFilter: radius }],
    };
    const built = buildFilterUrl(spec, postalCatalog, postalVocabulary);
    expect(decodeBuiltFilterSpec(built.query, "LEAD")).toEqual(spec);
  });

  it("refuses unknown ids even when plausible, plus every invalid catalog use", async () => {
    const vocabulary = await measuredVocabulary();
    const base = (filter: FilterSpec["filters"][number]): FilterSpec => ({ vertical: "ACCOUNT", filters: [filter] });
    expectBuildCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: "4", text: "Invented label", selectionType: "INCLUDED", emitText: true }] }), vocabulary, "FILTER_VOCABULARY_MISMATCH");
    expectBuildCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: "999999", text: "Looks right", selectionType: "INCLUDED", emitText: true }] }), vocabulary, "FILTER_VOCABULARY_MISSING");
    expectBuildCode(base({ kind: "values", type: "NOT_A_FILTER", values: [{ id: "1", text: "X", selectionType: "INCLUDED", emitText: true }] }), vocabulary, "FILTER_TYPE_UNKNOWN");
    const headcount = vocabulary.rows.find((row) => row.vertical === "ACCOUNT" && row.facet === "COMPANY_HEADCOUNT")!;
    expectBuildCode(base({ kind: "values", type: "COMPANY_HEADCOUNT", values: [{ id: headcount.id, text: headcount.text, selectionType: "EXCLUDED", emitText: true }] }), vocabulary, "FILTER_EXCLUSION_UNSUPPORTED");
    expectBuildCode(base({ kind: "range", type: "DEPARTMENT_HEADCOUNT_GROWTH" }), vocabulary, "FILTER_RANGE_INVALID");
    expectBuildCode(base({ kind: "range", type: "DEPARTMENT_HEADCOUNT_GROWTH", min: "20", max: "10" }), vocabulary, "FILTER_RANGE_INVALID");
    expectBuildCode(base({ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: "1", selectedSubFilter: "8" }), vocabulary, "FILTER_SUBFILTER_UNKNOWN");
    expectBuildCode(base({ kind: "range", type: "ANNUAL_REVENUE", min: "3", selectedSubFilter: "USD" }), vocabulary, "FILTER_RANGE_VALUE_UNKNOWN");
    const industry = vocabulary.rows.find((row) => row.vertical === "ACCOUNT" && row.facet === "INDUSTRY")!;
    expectBuildCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: industry.id, text: industry.text, selectionType: "INCLUDED", emitText: false }] }), vocabulary, "FILTER_TEXT_OMISSION_UNMEASURED");
    expectBuildCode({ vertical: "LEAD", filters: [{ kind: "raw-text", type: "INDUSTRY", text: "Software", selectionType: "INCLUDED" }] }, vocabulary, "FILTER_RAW_TEXT_UNSUPPORTED");
    expectBuildCode({ vertical: "LEAD", filters: [{ kind: "raw-text", type: "CURRENT_TITLE", text: "CEO", selectionType: "INCLUDED" }] }, vocabulary, "FILTER_RAW_TEXT_GRAMMAR_UNMEASURED");
    expectBuildCode({ vertical: "ACCOUNT", keywords: "software", filters: [{ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: "1" }] }, vocabulary, "FILTER_KEYWORDS_GRAMMAR_UNMEASURED");
    expect(filterSpecSchema.safeParse({ vertical: "ACCOUNT", recentSearch: { doLogHistory: false }, filters: [{ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: "1" }] }).success).toBe(false);
  });

  it("accepts a value's measured request spelling when it differs from its typeahead label (D476)", async () => {
    const vocabulary = await measuredVocabulary();
    const california = vocabulary.rows.find(
      (row) => row.vertical === "LEAD" && row.facet === "REGION" && row.id === "102095887",
    )!;
    // The typeahead calls it one thing and the search request calls it another;
    // both are measured, and the row carries both.
    expect(california.text).toBe("California, United States");
    expect(california.requestText).toBe("California");
    expect(california.requestTextProvenance.every((source) => source.kind === "request-url")).toBe(true);

    const spec = (text: string): FilterSpec => ({
      vertical: "LEAD",
      filters: [{ kind: "values", type: "REGION", values: [{ id: "102095887", text, selectionType: "INCLUDED", emitText: true }] }],
    });
    const catalog = loadPinnedFilterCatalog();
    // Either spelling builds, and each emits exactly what it was given -- the
    // builder never silently substitutes one for the other.
    expect(buildFilterUrl(spec("California"), catalog, vocabulary).query).toContain("text:California,");
    expect(buildFilterUrl(spec("California, United States"), catalog, vocabulary).query).toContain("text:California%2C%20United%20States,");
    // A third spelling is still a refusal; requestText is a measured alternate,
    // not an invitation to retitle.
    expectBuildCode(spec("Calif."), vocabulary, "FILTER_VOCABULARY_MISMATCH");
  });

  it("refuses a request spelling that has no request-url provenance", async () => {
    const vocabulary = await measuredVocabulary();
    const row = vocabulary.rows.find((candidate) => candidate.vertical === "LEAD" && candidate.facet === "REGION" && candidate.id === "102095887")!;
    expect(() => validateVocabularyRegistry({ version: 1, rows: [{ ...row, requestText: "California", requestTextProvenance: [] }] }))
      .toThrowError(expect.objectContaining({ code: "VOCAB_ROW_INVALID" }));
    expect(() => validateVocabularyRegistry({
      version: 1,
      rows: [{ ...row, requestText: "California", requestTextProvenance: [{ ...row.provenance[0]!, kind: "archive-body" }] }],
    })).toThrowError(expect.objectContaining({ code: "VOCAB_PROVENANCE_INVALID" }));
  });
});
