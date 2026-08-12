import { atom, list, object, parseSalesNavQuery, serializeSalesNavQuery, type QueryEntry, type QueryObject, type QueryValue } from "./grammar.js";
import { catalogIndex, type CatalogRow } from "./catalog.js";
import { CANONICAL_RANGE_ATOM, filterSpecSchema, type FilterSpec } from "./spec.js";
import type { VocabularyRegistry, VocabularyRow } from "./vocabulary.js";

export class FilterBuildError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FilterBuildError";
  }
}

export type FilterBuildResult = {
  url: string;
  query: string;
  filtersCount: number;
  vocabularyRows: VocabularyRow[];
  warnings: Array<{ code: string; field: string; n: number }>;
};

function refuse(code: string, message: string): never {
  throw new FilterBuildError(code, message);
}

function finiteNumber(value: string | undefined, name: string): string | null {
  if (value === undefined) return null;
  const raw = String(value);
  if (!CANONICAL_RANGE_ATOM.test(raw) || !Number.isFinite(Number(raw)) || /^-0(?:\.0+)?$/.test(raw)) {
    refuse("FILTER_RANGE_INVALID", `${name} must be a canonical finite decimal without whitespace, prefixes, exponent notation, or negative zero`);
  }
  return raw;
}

function validateSubFilter(row: CatalogRow, selected: string | undefined): void {
  if (selected !== undefined && !row.subFilters.some((candidate) => candidate.id === selected)) {
    refuse("FILTER_SUBFILTER_UNKNOWN", `${selected} is not a measured ${row.type} sub-filter`);
  }
}

function vocabularyFor(registry: VocabularyRegistry, vertical: string, facet: string, id: string, text: string): VocabularyRow {
  const rows = registry.rows.filter((row) => row.vertical === vertical && row.facet === facet && row.id === id);
  if (rows.length === 0) {
    refuse("FILTER_VOCABULARY_MISSING", `${vertical}/${facet} has no measured vocabulary row for term ${JSON.stringify(text)} (id ${JSON.stringify(id)})`);
  }
  // Either measured spelling resolves the row: the typeahead label in `text`,
  // or — where LinkedIn's search request disagrees with its own typeahead — the
  // request spelling in `requestText` (D476). Both are measured; neither is
  // substituted for the other, so the caller still gets exactly the text it
  // asked for and any third spelling is still a refusal.
  const row = rows.find((candidate) => candidate.text === text || candidate.requestText === text);
  if (row === undefined) {
    refuse("FILTER_VOCABULARY_MISMATCH", `${vertical}/${facet} id ${JSON.stringify(id)} was measured with different text; refusing to retitle it`);
  }
  if (row.provenance.length === 0) refuse("FILTER_VOCABULARY_PROVENANCE_MISSING", `${row.rowId} has no archive provenance`);
  return row;
}

function entityValue(value: { id: string; text: string; selectionType: "INCLUDED" | "EXCLUDED"; emitText: boolean }) {
  return object([
    { key: "id", value: atom(value.id) },
    ...(value.emitText ? [{ key: "text", value: atom(value.text) } satisfies QueryEntry] : []),
    { key: "selectionType", value: atom(value.selectionType) },
  ]);
}

export function buildFilterUrl(spec: FilterSpec, catalog: readonly CatalogRow[], vocabulary: VocabularyRegistry): FilterBuildResult {
  if (spec.keywords !== undefined) {
    refuse("FILTER_KEYWORDS_GRAMMAR_UNMEASURED", "keywords exist in a saved-search body but in no captured search-query URL; harvest one before building them");
  }
  const index = catalogIndex(catalog);
  const filters = [];
  const consumed = new Map<string, VocabularyRow>();
  const seenTypes = new Set<string>();
  for (const filter of spec.filters) {
    if (seenTypes.has(filter.type)) refuse("FILTER_TYPE_DUPLICATE", `${filter.type} appears more than once`);
    seenTypes.add(filter.type);
    const row = index.get(`${spec.vertical}\0${filter.type}`);
    if (row === undefined) refuse("FILTER_TYPE_UNKNOWN", `${filter.type} is not in the measured ${spec.vertical} catalog`);
    if (row.valueShape === "aggregate") refuse("FILTER_AGGREGATE_NOT_EMITTABLE", `${filter.type} is a catalog grouping, not a request filter type`);

    if (filter.kind === "raw-text") {
      if (!row.rawTextSupported) refuse("FILTER_RAW_TEXT_UNSUPPORTED", `${filter.type} is measured with rawTextSupported:false`);
      refuse("FILTER_RAW_TEXT_GRAMMAR_UNMEASURED", `${filter.type} supports raw text in the catalog, but no captured request proves its value envelope`);
    }
    if (filter.kind === "values") {
      if (row.valueShape !== "values" && row.valueShape !== "toggle") {
        refuse("FILTER_VALUE_SHAPE_INVALID", `${filter.type} is measured as ${row.valueShape}, not a values filter`);
      }
      for (const value of filter.values) {
        if (value.selectionType === "EXCLUDED" && !row.exclusionSupported) {
          refuse("FILTER_EXCLUSION_UNSUPPORTED", `${filter.type} is measured with exclusionSupported:false`);
        }
        const vocab = vocabularyFor(vocabulary, spec.vertical, filter.type, value.id, value.text);
        if (!value.emitText && vocab.textOmissionProvenance.length === 0) {
          refuse("FILTER_TEXT_OMISSION_UNMEASURED", `${spec.vertical}/${filter.type} id ${JSON.stringify(value.id)} has no captured request proving that text may be omitted`);
        }
        consumed.set(vocab.rowId, vocab);
      }
      validateSubFilter(row, filter.selectedSubFilter);
      filters.push(object([
        { key: "type", value: atom(filter.type) },
        { key: "values", value: list(filter.values.map(entityValue)) },
        ...(filter.selectedSubFilter === undefined ? [] : [{ key: "selectedSubFilter", value: atom(filter.selectedSubFilter) }]),
      ]));
      continue;
    }
    if (row.valueShape !== "range") refuse("FILTER_VALUE_SHAPE_INVALID", `${filter.type} is measured as ${row.valueShape}, not a range`);
    const min = finiteNumber(filter.min, "range min");
    const max = finiteNumber(filter.max, "range max");
    if (min === null && max === null) refuse("FILTER_RANGE_INVALID", `${filter.type} needs min, max, or both`);
    if (min !== null && max !== null && Number(min) > Number(max)) refuse("FILTER_RANGE_INVALID", `${filter.type} min exceeds max`);
    validateSubFilter(row, filter.selectedSubFilter);
    for (const [label, candidate] of [["min", min], ["max", max]] as const) {
      if (candidate === null) continue;
      const numeric = Number(candidate);
      if ((row.rangeInputType === "INTEGER" || row.rangeInputType === "NATURAL") && !Number.isInteger(numeric)) {
        refuse("FILTER_RANGE_VALUE_INVALID", `${filter.type} ${label} must satisfy measured ${row.rangeInputType} inputType`);
      }
      if (row.rangeMinValue !== null && numeric < row.rangeMinValue) {
        refuse("FILTER_RANGE_VALUE_INVALID", `${filter.type} ${label} is below measured minValue ${row.rangeMinValue}`);
      }
    }
    if (row.acceptedValues.length > 0) {
      const accepted = new Set(row.acceptedValues.map((candidate) => candidate.id));
      if ((min !== null && !accepted.has(min)) || (max !== null && !accepted.has(max))) {
        refuse("FILTER_RANGE_VALUE_UNKNOWN", `${filter.type} range contains a value outside its measured acceptedValues`);
      }
    }
    const rangeEntries: QueryEntry[] = [
      ...(min === null ? [] : [{ key: "min", value: atom(min) }]),
      ...(max === null ? [] : [{ key: "max", value: atom(max) }]),
    ];
    filters.push(object([
      { key: "type", value: atom(filter.type) },
      { key: "rangeValue", value: object(rangeEntries) },
      ...(filter.selectedSubFilter === undefined ? [] : [{ key: "selectedSubFilter", value: atom(filter.selectedSubFilter) }]),
    ]));
  }

  const entries: QueryEntry[] = [];
  if (spec.recentSearch !== undefined) {
    entries.push({
      key: "recentSearchParam",
      value: object([
        { key: "doLogHistory", value: atom(String(spec.recentSearch.doLogHistory)) },
      ]),
    });
  }
  entries.push({ key: "filters", value: list(filters) });
  const ast: QueryObject = object(entries);
  const query = serializeSalesNavQuery(ast);
  const route = spec.vertical === "LEAD" ? "people" : "company";
  return {
    url: `https://www.linkedin.com/sales/search/${route}?query=${query}`,
    query,
    filtersCount: spec.filters.length,
    vocabularyRows: [...consumed.values()],
    warnings: [],
  };
}

function child(parent: QueryObject, key: string): QueryValue | null {
  return parent.entries.find((candidate) => candidate.key === key)?.value ?? null;
}

function requiredAtom(parent: QueryObject, key: string): string {
  const value = child(parent, key);
  if (value?.kind !== "atom") refuse("FILTER_QUERY_DECODE_INVALID", `${key} is missing or is not an atom`);
  return value.value;
}

function assertKeys(parent: QueryObject, label: string, allowed: readonly string[], required: readonly string[] = []): void {
  const counts = new Map<string, number>();
  for (const { key } of parent.entries) counts.set(key, (counts.get(key) ?? 0) + 1);
  const unknown = [...counts.keys()].filter((key) => !allowed.includes(key));
  const duplicate = [...counts].find(([, count]) => count > 1)?.[0];
  const missing = required.find((key) => !counts.has(key));
  if (unknown.length > 0) refuse("FILTER_QUERY_DECODE_INVALID", `${label} contains unknown field ${unknown[0]}`);
  if (duplicate !== undefined) refuse("FILTER_QUERY_DECODE_INVALID", `${label} repeats field ${duplicate}`);
  if (missing !== undefined) refuse("FILTER_QUERY_DECODE_INVALID", `${label} is missing field ${missing}`);
}

/** Strict inverse for URLs this builder emits. It rejects extensions instead
 * of silently discarding them, so `build → decode → spec` is a real equality
 * check and not a projection that could hide an emitted field. */
export function decodeBuiltFilterSpec(query: string, vertical: "LEAD" | "ACCOUNT", vocabulary?: VocabularyRegistry): FilterSpec {
  let root: QueryObject;
  try { root = parseSalesNavQuery(query); } catch (cause) {
    refuse("FILTER_QUERY_DECODE_INVALID", cause instanceof Error ? cause.message : "query grammar is invalid");
  }
  assertKeys(root, "query", ["recentSearchParam", "filters"], ["filters"]);
  const filters = child(root, "filters");
  if (filters?.kind !== "list" || filters.items.length === 0) refuse("FILTER_QUERY_DECODE_INVALID", "filters must be a non-empty List");
  const decoded: FilterSpec["filters"] = filters.items.map((candidate) => {
    if (candidate.kind !== "object") refuse("FILTER_QUERY_DECODE_INVALID", "filter list item is not an object");
    assertKeys(candidate, "filter", ["type", "values", "rangeValue", "selectedSubFilter"], ["type"]);
    const type = requiredAtom(candidate, "type");
    const values = child(candidate, "values");
    const range = child(candidate, "rangeValue");
    if ((values === null) === (range === null)) {
      refuse("FILTER_QUERY_DECODE_INVALID", `${type} must contain exactly one of values or rangeValue`);
    }
    const selected = child(candidate, "selectedSubFilter");
    if (selected !== null && selected.kind !== "atom") refuse("FILTER_QUERY_DECODE_INVALID", `${type} selectedSubFilter is not an atom`);
    if (values?.kind === "list") {
      if (values.items.length === 0) refuse("FILTER_QUERY_DECODE_INVALID", `${type} values must be non-empty`);
      return {
        kind: "values" as const,
        type,
        values: values.items.map((valueCandidate) => {
          if (valueCandidate.kind !== "object") refuse("FILTER_QUERY_DECODE_INVALID", `${type} value is not an object`);
          assertKeys(valueCandidate, `${type} value`, ["id", "text", "selectionType"], ["id", "selectionType"]);
          const selectionType = requiredAtom(valueCandidate, "selectionType");
          if (selectionType !== "INCLUDED" && selectionType !== "EXCLUDED") refuse("FILTER_QUERY_DECODE_INVALID", `${type} has an unknown selection type`);
          const id = requiredAtom(valueCandidate, "id");
          const textValue = child(valueCandidate, "text");
          if (textValue !== null && textValue.kind !== "atom") refuse("FILTER_QUERY_DECODE_INVALID", `${type} value text is not an atom`);
          const measured = textValue === null
            ? vocabulary?.rows.find((row) => row.vertical === vertical && row.facet === type && row.id === id && row.textOmissionProvenance.length > 0)
            : undefined;
          if (textValue === null && measured === undefined) {
            refuse("FILTER_QUERY_DECODE_INVALID", `${vertical}/${type} id ${JSON.stringify(id)} omits text without supplied omission provenance`);
          }
          return { id, text: textValue?.kind === "atom" ? textValue.value : measured!.text, selectionType, emitText: textValue !== null };
        }),
        ...(selected?.kind === "atom" ? { selectedSubFilter: selected.value } : {}),
      };
    }
    if (range?.kind === "object") {
      assertKeys(range, `${type} rangeValue`, ["min", "max"]);
      const min = child(range, "min");
      const max = child(range, "max");
      if (min === null && max === null) refuse("FILTER_QUERY_DECODE_INVALID", `${type} rangeValue must contain min or max`);
      if (min !== null && min.kind !== "atom") refuse("FILTER_QUERY_DECODE_INVALID", `${type} range min is not an atom`);
      if (max !== null && max.kind !== "atom") refuse("FILTER_QUERY_DECODE_INVALID", `${type} range max is not an atom`);
      return {
        kind: "range" as const,
        type,
        ...(min?.kind === "atom" ? { min: min.value } : {}),
        ...(max?.kind === "atom" ? { max: max.value } : {}),
        ...(selected?.kind === "atom" ? { selectedSubFilter: selected.value } : {}),
      };
    }
    refuse("FILTER_QUERY_DECODE_INVALID", `${type} has neither measured values nor rangeValue shape`);
  });
  const recent = child(root, "recentSearchParam");
  if (recent !== null && recent.kind !== "object") refuse("FILTER_QUERY_DECODE_INVALID", "recentSearchParam is not an object");
  if (recent?.kind === "object") assertKeys(recent, "recentSearchParam", ["doLogHistory"], ["doLogHistory"]);
  const history = recent?.kind === "object" ? requiredAtom(recent, "doLogHistory") : null;
  if (history !== null && history !== "true") refuse("FILTER_QUERY_DECODE_INVALID", "only the measured doLogHistory:true spelling is accepted");
  const candidate = {
    vertical,
    ...(history === null ? {} : { recentSearch: { doLogHistory: true as const } }),
    filters: decoded,
  };
  const validated = filterSpecSchema.safeParse(candidate);
  if (!validated.success) {
    refuse("FILTER_QUERY_DECODE_INVALID", `decoded query is not a FilterSpec: ${validated.error.issues.map((issue) => issue.path.join(".") || "root").join(", ")}`);
  }
  return validated.data;
}
