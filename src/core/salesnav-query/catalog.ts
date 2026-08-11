export const SALESNAV_VERTICALS = ["LEAD", "ACCOUNT"] as const;
export type SalesNavVertical = (typeof SALESNAV_VERTICALS)[number];

export type FilterPresentation =
  | "MULTI_SELECT"
  | "MULTI_ENTITY_WITH_MULTI_SELECT"
  | "SINGLE_SELECT"
  | "TOGGLE"
  | "TEXT"
  | "RANGE_DROPDOWN"
  | "RANGE_TEXT"
  | "AGGREGATE";

export type CatalogRow = {
  vertical: SalesNavVertical;
  type: string;
  parentType: string | null;
  title: string;
  presentationType: FilterPresentation;
  valueShape: "values" | "range" | "text" | "toggle" | "aggregate";
  typeaheadSupported: boolean;
  rawTextSupported: boolean;
  exclusionSupported: boolean;
  dynamicFetch: boolean;
  facetTypeaheadType: string | null;
  selectedSubFilter: string | null;
  acceptedValues: Array<{ id: string; displayValue: string }>;
  subFilters: Array<{ id: string; title: string }>;
};

type Json = Record<string, unknown>;

function record(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

function options(value: unknown, labelKey: "displayValue" | "title"): Array<{ id: string; displayValue: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const row = record(candidate);
    const id = string(row?.["id"]);
    const label = string(row?.[labelKey]);
    return id === null || label === null ? [] : [{ id, displayValue: label }];
  });
}

function presentation(value: unknown, aggregate: boolean): FilterPresentation {
  if (aggregate) return "AGGREGATE";
  const p = string(value);
  const known: readonly string[] = [
    "MULTI_SELECT", "MULTI_ENTITY_WITH_MULTI_SELECT", "SINGLE_SELECT", "TOGGLE",
    "TEXT", "RANGE_DROPDOWN", "RANGE_TEXT",
  ];
  if (p === null || !known.includes(p)) throw new Error(`unknown filter presentation ${JSON.stringify(value)}`);
  return p as FilterPresentation;
}

function rowOf(vertical: SalesNavVertical, metadata: Json, parentType: string | null): CatalogRow {
  const type = string(metadata["type"]);
  const config = record(metadata["searchFilterConfig"]);
  if (type === null || config === null) throw new Error("filter metadata is missing type or searchFilterConfig");
  const p = presentation(config["presentationType"], parentType === null && Array.isArray(metadata["values"]));
  const range = record(config["rangeConfig"]);
  const accepted = options(range?.["acceptedValues"], "displayValue");
  const sub = options(config["subFilters"], "title").map(({ id, displayValue: title }) => ({ id, title }));
  const valueShape = p === "RANGE_DROPDOWN" || p === "RANGE_TEXT"
    ? "range"
    : p === "TEXT" ? "text" : p === "TOGGLE" ? "toggle" : p === "AGGREGATE" ? "aggregate" : "values";
  return {
    vertical,
    type,
    parentType,
    title: string(config["title"]) ?? type,
    presentationType: p,
    valueShape,
    typeaheadSupported: bool(config["typeaheadSupported"]),
    rawTextSupported: bool(config["rawTextSupported"]),
    exclusionSupported: bool(config["exclusionSupported"]),
    dynamicFetch: bool(config["dynamicFetch"]),
    facetTypeaheadType: string(config["facetTypeaheadType"]),
    selectedSubFilter: string(metadata["selectedSubFilter"]),
    acceptedValues: accepted,
    subFilters: sub,
  };
}

export function parseFilterCatalog(body: string): CatalogRow[] {
  let root: unknown;
  try { root = JSON.parse(body); } catch { throw new Error("filter catalog body is not JSON"); }
  const elements = record(root)?.["elements"];
  if (!Array.isArray(elements)) throw new Error("filter catalog has no elements array");
  const expanded = elements.filter((candidate) => record(candidate)?.["viewMode"] === "WEB_EXPANDED");
  const rows: CatalogRow[] = [];
  for (const candidate of expanded) {
    const element = record(candidate)!;
    const vertical = element["searchType"];
    if (vertical !== "LEAD" && vertical !== "ACCOUNT") throw new Error("expanded catalog has an unknown vertical");
    const columns = element["filterColumns"];
    if (!Array.isArray(columns)) throw new Error(`${vertical} catalog has no filter columns`);
    for (const columnCandidate of columns) {
      const groups = record(columnCandidate)?.["filterGroups"];
      if (!Array.isArray(groups)) throw new Error(`${vertical} catalog column has no groups`);
      for (const groupCandidate of groups) {
        const filters = record(groupCandidate)?.["filters"];
        if (!Array.isArray(filters)) throw new Error(`${vertical} catalog group has no filters`);
        for (const wrapperCandidate of filters) {
          const wrapper = record(wrapperCandidate);
          const single = record(wrapper?.["singleFilterMetadata"]);
          if (single !== null) {
            rows.push(rowOf(vertical, single, null));
            continue;
          }
          const aggregate = record(wrapper?.["aggregatedFilterMetadata"]);
          if (aggregate === null) throw new Error(`${vertical} catalog filter has no measured metadata envelope`);
          const parent = rowOf(vertical, aggregate, null);
          rows.push(parent);
          const children = aggregate["values"];
          if (!Array.isArray(children)) throw new Error(`${parent.type} aggregate has no child filters`);
          for (const child of children) rows.push(rowOf(vertical, record(child) ?? {}, parent.type));
        }
      }
    }
  }
  const identities = new Set<string>();
  for (const row of rows) {
    const id = `${row.vertical}\0${row.type}`;
    if (identities.has(id)) throw new Error(`duplicate catalog row ${row.vertical}/${row.type}`);
    identities.add(id);
  }
  return rows;
}

export function catalogIndex(rows: readonly CatalogRow[]): Map<string, CatalogRow> {
  return new Map(rows.map((row) => [`${row.vertical}\0${row.type}`, row]));
}
