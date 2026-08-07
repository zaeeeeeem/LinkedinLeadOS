import { EXIT } from "../../core/run/receipt.js";
import { embeddedJsonOf } from "../../core/fixtures/sweep.js";
import type { CompanyInput } from "../../core/store/types.js";

export const MAX_COMPANY_FIELD_CHARS = 20_000;
export const MAX_COMPANY_PARSE_NODES = 200_000;
export const MAX_COMPANY_CAPTURE_BODIES = 256;

export type CompanyCapture = { url: string; body: string };
export type CompanyParseWarning = {
  code: "PARSE_IDENTITY_UNRESOLVED" | "PARSE_IDENTITY_IS_SESSION" |
    "PARSE_FIELD_MISSING" | "PARSE_FIELD_TRUNCATED" | "PARSE_INPUT_TRUNCATED";
  field: string;
  n: number;
  exit: typeof EXIT.PARSE_DRIFT;
  basis: "identity" | "labeled-field" | "bound";
};
export type ParsedCompany = {
  source: { identity: "voyager-body+embedded-json"; content: "network-body" };
  value: CompanyInput;
};
export type CompanyParseResult =
  | { ok: true; company: ParsedCompany; warnings: CompanyParseWarning[] }
  | { ok: false; company: null; warnings: CompanyParseWarning[] };

type Obj = Record<string, unknown>;
const COMPANY_URN = /^urn:li:(?:fsd_company|fs_normalized_company|company):(\d+)$/;

function warning(code: CompanyParseWarning["code"], field: string, basis: CompanyParseWarning["basis"], n = 1): CompanyParseWarning {
  return { code, field, basis, n, exit: EXIT.PARSE_DRIFT };
}

export function normalizeCompanyUrn(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = COMPANY_URN.exec(value);
  return match === null ? null : `urn:li:fsd_company:${match[1]}`;
}

function objectsOf(root: unknown): { objects: Obj[]; truncated: boolean } {
  const objects: Obj[] = [];
  const stack = [root];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0 && nodes < MAX_COMPANY_PARSE_NODES) {
    const value = stack.pop();
    nodes++;
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) stack.push(value[index]);
    }
    else {
      const object = value as Obj;
      objects.push(object);
      for (const child of Object.values(object)) stack.push(child);
    }
  }
  return { objects, truncated: stack.length > 0 };
}

function jsonOf(capture: CompanyCapture): unknown[] {
  if (/^https:\/\/[^/]*linkedin\.com\/company\//i.test(capture.url)) {
    return embeddedJsonOf(capture.body).map((entry) => entry.value);
  }
  try { return [JSON.parse(capture.body)]; } catch { return []; }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function bounded(value: string | undefined, field: string, warnings: CompanyParseWarning[]): string | undefined {
  if (value === undefined || value.length <= MAX_COMPANY_FIELD_CHARS) return value;
  warnings.push(warning("PARSE_FIELD_TRUNCATED", field, "bound", value.length - MAX_COMPANY_FIELD_CHARS));
  return value.slice(0, MAX_COMPANY_FIELD_CHARS);
}

function addressOf(record: Obj): Obj | null {
  const hq = record["headquarter"];
  if (hq && typeof hq === "object" && !Array.isArray(hq)) {
    const address = (hq as Obj)["address"];
    if (address && typeof address === "object" && !Array.isArray(address)) return address as Obj;
  }
  return null;
}

function companyInput(record: Obj, voyagerRecord: Obj, targetVanity: string, urn: string, refs: Map<string, Obj>, warnings: CompanyParseWarning[]): CompanyInput {
  const range = record["employeeCountRange"] as Obj | undefined;
  const start = typeof range?.["start"] === "number" ? range["start"] : null;
  const end = typeof range?.["end"] === "number" ? range["end"] : null;
  const address = addressOf(record);
  const rawIndustry = record["*industry"];
  const industryRef = text(Array.isArray(rawIndustry) ? rawIndustry[0] : rawIndustry);
  const rawIndustryV2 = record["*industryV2Taxonomy"];
  const industryV2Ref = text(Array.isArray(rawIndustryV2) ? rawIndustryV2[0] : rawIndustryV2);
  const industry = industryV2Ref === undefined
    ? (industryRef === undefined ? undefined : text(refs.get(industryRef)?.["name"]))
    : text(refs.get(industryV2Ref)?.["name"]);
  const value: CompanyInput = { urn };
  const assign = (key: keyof Omit<CompanyInput, "urn">, item: string | undefined) => {
    const safe = bounded(item, key, warnings);
    if (safe !== undefined) value[key] = safe;
  };
  assign("name", text(voyagerRecord["name"]) ?? text(record["name"]));
  const voyagerUrl = text(voyagerRecord["url"]);
  const urlVanity = voyagerUrl?.match(/\/company\/([^/?#]+)/i)?.[1];
  assign("vanity", urlVanity ?? (/^\d+$/.test(targetVanity) ? undefined : targetVanity));
  assign("website", text(record["websiteUrl"]));
  assign("industry", industry);
  if (start !== null) assign("size_range", end === null ? `${start}+ employees` : `${start}-${end} employees`);
  if (address !== null) {
    const city = text(address["city"]);
    const area = text(address["geographicArea"]);
    assign("hq", [city, area].filter(Boolean).join(", ") || undefined);
  }
  assign("about", text(record["description"]));
  if (value.name === undefined) warnings.push(warning("PARSE_FIELD_MISSING", "name", "labeled-field"));
  return value;
}

export function parseCompanyCaptures(
  captures: readonly CompanyCapture[],
  options: { targetVanity: string; sessionUrns: readonly string[] },
): CompanyParseResult {
  const warnings: CompanyParseWarning[] = [];
  const selected = captures.slice(0, MAX_COMPANY_CAPTURE_BODIES);
  if (captures.length > selected.length) warnings.push(warning("PARSE_INPUT_TRUNCATED", "captures", "bound", captures.length - selected.length));
  const voyager: Obj[] = [];
  const embedded: Obj[] = [];
  let walkTruncated = false;
  for (const capture of selected) {
    for (const root of jsonOf(capture)) {
      const walked = objectsOf(root);
      walkTruncated ||= walked.truncated;
      (/^https:\/\/[^/]*linkedin\.com\/company\//i.test(capture.url) ? embedded : voyager).push(...walked.objects);
    }
  }
  if (walkTruncated) warnings.push(warning("PARSE_INPUT_TRUNCATED", "nodes", "bound"));

  const target = options.targetVanity.toLowerCase();
  const candidates = embedded
    .filter((o) => /^\d+$/.test(target)
      ? normalizeCompanyUrn(o["entityUrn"]) === `urn:li:fsd_company:${target}`
      : text(o["universalName"])?.toLowerCase() === target)
    .map((o) => normalizeCompanyUrn(o["entityUrn"]))
    .filter((u): u is string => u !== null);
  const unique = [...new Set(candidates)];
  const corroborated = unique.length === 1 && voyager.some((o) => normalizeCompanyUrn(o["entityUrn"]) === unique[0]);
  if (!corroborated) return { ok: false, company: null, warnings: [...warnings, warning("PARSE_IDENTITY_UNRESOLVED", "urn", "identity")] };
  const urn = unique[0]!;
  const session = new Set(options.sessionUrns.map((u) => normalizeCompanyUrn(u) ?? u));
  if (session.has(urn)) return { ok: false, company: null, warnings: [...warnings, warning("PARSE_IDENTITY_IS_SESSION", "urn", "identity")] };

  const all = [...embedded, ...voyager];
  const refs = new Map<string, Obj>();
  for (const object of all) if (typeof object["entityUrn"] === "string") refs.set(object["entityUrn"] as string, object);
  const subjectRecords = all.filter((o) => normalizeCompanyUrn(o["entityUrn"]) === urn);
  const record = subjectRecords.sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] ?? {};
  const voyagerRecord = voyager.filter((o) => normalizeCompanyUrn(o["entityUrn"]) === urn)
    .sort((a, b) => Object.keys(b).length - Object.keys(a).length)[0] ?? {};
  return {
    ok: true,
    company: { source: { identity: "voyager-body+embedded-json", content: "network-body" }, value: companyInput(record, voyagerRecord, target, urn, refs, warnings) },
    warnings,
  };
}
