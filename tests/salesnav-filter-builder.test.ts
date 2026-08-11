import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultRunsDir } from "../src/core/run/paths.js";
import {
  FilterBuildError,
  buildFilterUrl,
  decodeBuiltFilterSpec,
  filterSpecSchema,
  harvestVocabulary,
  loadPinnedFilterCatalog,
  mergeVocabularyRegistries,
  parseSalesNavQuery,
  rawUrlParam,
  readVocabularyFile,
  type FilterSpec,
  type QueryObject,
  type QueryValue,
  type VocabularyRegistry,
} from "../src/core/salesnav-query/index.js";

function archivedQuery(runId: string, archiveId: string): string {
  const metadata = JSON.parse(readFileSync(join(defaultRunsDir(), runId, "raw", `${archiveId}.meta.json`), "utf8")) as { url: string };
  const query = rawUrlParam(metadata.url, "query");
  if (query === null) throw new Error("archive has no query parameter");
  return query;
}

function child(parent: QueryObject, key: string): QueryValue | null {
  return parent.entries.find((candidate) => candidate.key === key)?.value ?? null;
}

function value(parent: QueryObject, key: string): string | null {
  const found = child(parent, key);
  return found?.kind === "atom" ? found.value : null;
}

function measuredSpec(query: string, vertical: "LEAD" | "ACCOUNT", vocabulary: VocabularyRegistry): FilterSpec {
  const root = parseSalesNavQuery(query);
  const filters = child(root, "filters");
  if (filters?.kind !== "list") throw new Error("no filters");
  const decoded: FilterSpec["filters"] = filters.items.map((candidate) => {
    if (candidate.kind !== "object") throw new Error("bad filter");
    const type = value(candidate, "type")!;
    const values = child(candidate, "values");
    if (values?.kind === "list") return {
      kind: "values" as const,
      type,
      values: values.items.map((item) => {
        if (item.kind !== "object") throw new Error("bad value");
        const id = value(item, "id")!;
        const text = value(item, "text") ?? vocabulary.rows.find((row) =>
          row.vertical === vertical && row.facet === type && row.id === id,
        )?.text;
        if (text === undefined) throw new Error("missing measured vocabulary text");
        return {
          id, text,
          selectionType: value(item, "selectionType") as "INCLUDED" | "EXCLUDED",
          emitText: value(item, "text") !== null,
        };
      }),
    };
    const range = child(candidate, "rangeValue");
    if (range?.kind !== "object") throw new Error("bad range");
    return {
      kind: "range" as const,
      type,
      ...(value(range, "min") === null ? {} : { min: value(range, "min")! }),
      ...(value(range, "max") === null ? {} : { max: value(range, "max")! }),
      ...(value(candidate, "selectedSubFilter") === null ? {} : { selectedSubFilter: value(candidate, "selectedSubFilter")! }),
    };
  });
  const recent = child(root, "recentSearchParam");
  if (recent?.kind === "object" && value(recent, "doLogHistory") !== "true") throw new Error("unmeasured recentSearchParam");
  return {
    vertical,
    ...(recent?.kind === "object" ? { recentSearch: { doLogHistory: true as const } } : {}),
    filters: decoded,
  };
}

async function measuredVocabulary() {
  return mergeVocabularyRegistries(
    await readVocabularyFile(new URL("../src/core/salesnav-query/vocabulary.registry.json", import.meta.url)),
    await harvestVocabulary({
      runIds: [
        "01KZQCS8XZDDYSDGMT5SB81YBS", "01KZQFCFMVYKAC082JXDRVCAN3",
        "01KZQ5TXC23T3FFBJ72P8CE85J", "01KZP693DEWVP0S90K7C7XQ997",
      ],
    }),
  );
}

describe("Sales Navigator filter builder", () => {
  it("reconstructs the archived CXO and account query strings exactly", async () => {
    const vocabulary = await measuredVocabulary();
    const catalog = loadPinnedFilterCatalog();
    for (const measured of [
      { run: "01KZQFCFMVYKAC082JXDRVCAN3", archive: "0016-c413e8471fda6d7e", vertical: "LEAD" as const },
      { run: "01KZQ5TXC23T3FFBJ72P8CE85J", archive: "0016-67ea927af64cc179", vertical: "ACCOUNT" as const },
    ]) {
      const query = archivedQuery(measured.run, measured.archive);
      const spec = measuredSpec(query, measured.vertical, vocabulary);
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
      const row = {
        rowId: "",
        vertical: "ACCOUNT" as const,
        facet: "REGION",
        id,
        text,
        operatorScoped: false,
        provenance: [{ kind: "request-url" as const, runId: "SYNTHETIC", archiveId: "META", file: "synthetic", locator: "query.filters[0].values[0]" }],
        textOmissionProvenance: [],
      };
      row.rowId = (awaitRowId(row));
      const vocabulary = { version: 1 as const, rows: [row] };
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

  it("refuses unknown ids even when they look plausible, plus invalid catalog uses", async () => {
    const catalog = loadPinnedFilterCatalog();
    const vocabulary = await measuredVocabulary();
    const base = (filter: FilterSpec["filters"][number]): FilterSpec => ({ vertical: "ACCOUNT", filters: [filter] });
    const expectCode = (spec: FilterSpec, code: string) => {
      try { buildFilterUrl(spec, catalog, vocabulary); } catch (cause) {
        expect(cause).toBeInstanceOf(FilterBuildError);
        expect((cause as FilterBuildError).code).toBe(code);
        return;
      }
      throw new Error(`expected ${code}`);
    };
    expectCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: "4", text: "Invented label", selectionType: "INCLUDED", emitText: true }] }), "FILTER_VOCABULARY_MISMATCH");
    expectCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: "999999", text: "Looks right", selectionType: "INCLUDED", emitText: true }] }), "FILTER_VOCABULARY_MISSING");
    expectCode(base({ kind: "values", type: "NOT_A_FILTER", values: [{ id: "1", text: "X", selectionType: "INCLUDED", emitText: true }] }), "FILTER_TYPE_UNKNOWN");
    const headcount = vocabulary.rows.find((row) => row.vertical === "ACCOUNT" && row.facet === "COMPANY_HEADCOUNT")!;
    expectCode(base({ kind: "values", type: "COMPANY_HEADCOUNT", values: [{ id: headcount.id, text: headcount.text, selectionType: "EXCLUDED", emitText: true }] }), "FILTER_EXCLUSION_UNSUPPORTED");
    expectCode(base({ kind: "range", type: "DEPARTMENT_HEADCOUNT_GROWTH" }), "FILTER_RANGE_INVALID");
    expectCode(base({ kind: "range", type: "DEPARTMENT_HEADCOUNT_GROWTH", min: 20, max: 10 }), "FILTER_RANGE_INVALID");
    expectCode(base({ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: 1, selectedSubFilter: "8" }), "FILTER_SUBFILTER_UNKNOWN");
    expectCode(base({ kind: "range", type: "ANNUAL_REVENUE", min: 3, selectedSubFilter: "USD" }), "FILTER_RANGE_VALUE_UNKNOWN");
    const industry = vocabulary.rows.find((row) => row.vertical === "ACCOUNT" && row.facet === "INDUSTRY")!;
    expectCode(base({ kind: "values", type: "INDUSTRY", values: [{ id: industry.id, text: industry.text, selectionType: "INCLUDED", emitText: false }] }), "FILTER_TEXT_OMISSION_UNMEASURED");
    expectCode({ vertical: "LEAD", filters: [{ kind: "raw-text", type: "INDUSTRY", text: "Software", selectionType: "INCLUDED" }] }, "FILTER_RAW_TEXT_UNSUPPORTED");
    expectCode({ vertical: "LEAD", filters: [{ kind: "raw-text", type: "CURRENT_TITLE", text: "CEO", selectionType: "INCLUDED" }] }, "FILTER_RAW_TEXT_GRAMMAR_UNMEASURED");
    expectCode({ vertical: "ACCOUNT", keywords: "software", filters: [base({ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: 1 }).filters[0]!] }, "FILTER_KEYWORDS_GRAMMAR_UNMEASURED");
    expect(filterSpecSchema.safeParse({ vertical: "ACCOUNT", recentSearch: { doLogHistory: false }, filters: [base({ kind: "range", type: "COMPANY_HEADCOUNT_GROWTH", min: 1 }).filters[0]!] }).success).toBe(false);
  });
});

// Kept outside the production row creator so generated tests do not certify it
// by calling the same implementation they are meant to exercise.
import { createHash } from "node:crypto";
function awaitRowId(row: { vertical: string; facet: string; id: string; text: string }): string {
  return createHash("sha256").update(`${row.vertical}\0${row.facet}\0${row.id}\0${row.text}`).digest("hex").slice(0, 24);
}
