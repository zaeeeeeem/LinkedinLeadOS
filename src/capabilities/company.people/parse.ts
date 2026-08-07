import { EXIT } from "../../core/run/receipt.js";
import type { CompanyPersonInput } from "../../core/store/types.js";
import { parseCompanyCaptures, type CompanyCapture } from "../company.get/parse.js";

export const MAX_COMPANY_PEOPLE_BODIES = 256;
export const MAX_COMPANY_PEOPLE_NODES = 200_000;
export const MAX_COMPANY_PEOPLE_FIELD_CHARS = 20_000;
type Obj = Record<string, unknown>;
export type CompanyPeopleWarning = { code: "PARSE_IDENTITY_UNRESOLVED" | "PARSE_IDENTITY_IS_SESSION" | "PARSE_FIELD_MISSING" | "PARSE_FIELD_TRUNCATED" | "PARSE_INPUT_TRUNCATED" | "PARSE_SCOPE_UNMATCHED"; field: string; n: number; exit: typeof EXIT.PARSE_DRIFT; basis: "identity" | "labeled-field" | "bound" };
export type ParsedCompanyPerson = CompanyPersonInput & { profile_url: string; name?: string; headline?: string };
export type CompanyPeopleParseResult =
  | { ok: true; companyUrn: string; people: ParsedCompanyPerson[]; inspectedResults: number; warnings: CompanyPeopleWarning[] }
  | { ok: false; companyUrn: null; people: []; inspectedResults: number; warnings: CompanyPeopleWarning[] };
const PROFILE = /^urn:li:fsd_profile:([A-Za-z0-9_-]+)$/;
const RESULT = /^urn:li:fsd_entityResultViewModel:\((urn:li:fsd_profile:[A-Za-z0-9_-]+),/;
function object(v: unknown): Obj | null { return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null; }
function text(v: unknown): string | undefined { return typeof v === "string" && v.trim() ? v.trim() : undefined; }
function warning(code: CompanyPeopleWarning["code"], field: string, basis: CompanyPeopleWarning["basis"], n = 1): CompanyPeopleWarning { return { code, field, basis, n, exit: EXIT.PARSE_DRIFT }; }
function objectsOf(root: unknown) { const values: Obj[] = []; const stack = [root]; const seen = new WeakSet<object>(); let nodes = 0;
  while (stack.length && nodes < MAX_COMPANY_PEOPLE_NODES) { const value = stack.pop(); nodes++;
    if (value === null || typeof value !== "object" || seen.has(value)) continue; seen.add(value);
    if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    else { values.push(value as Obj); for (const child of Object.values(value as Obj)) stack.push(child); }
  } return { values, truncated: stack.length > 0 }; }
function selectedCompany(objects: readonly Obj[], id: string): boolean { return objects.some((o) => o["parameterName"] === "currentCompany" && Array.isArray(o["secondaryFilterValues"]) && o["secondaryFilterValues"].some((v) => { const x = object(v); return x?.["selected"] === true && text(x["value"]) === id; })); }
function bounded(value: string | undefined, field: string, warnings: CompanyPeopleWarning[]) { if (value === undefined || value.length <= MAX_COMPANY_PEOPLE_FIELD_CHARS) return value; warnings.push(warning("PARSE_FIELD_TRUNCATED", field, "bound", value.length - MAX_COMPANY_PEOPLE_FIELD_CHARS)); return value.slice(0, MAX_COMPANY_PEOPLE_FIELD_CHARS); }
function profileUrl(value: unknown): string | undefined { const raw = text(value); if (raw === undefined) return undefined; try { const url = new URL(raw); const match = /^\/in\/([^/?#]+)\/?$/i.exec(url.pathname); return match ? `https://www.linkedin.com/in/${match[1]}` : undefined; } catch { return PROFILE.test(raw) ? raw : undefined; } }

export function parseCompanyPeople(captures: readonly CompanyCapture[], options: { targetVanity: string; sessionUrns: readonly string[]; limit: number; title?: string; name?: string }): CompanyPeopleParseResult {
  const warnings: CompanyPeopleWarning[] = []; const selected = captures.slice(0, MAX_COMPANY_PEOPLE_BODIES);
  if (selected.length < captures.length) warnings.push(warning("PARSE_INPUT_TRUNCATED", "captures", "bound", captures.length - selected.length));
  const identity = parseCompanyCaptures(selected, { targetVanity: options.targetVanity, sessionUrns: options.sessionUrns }); warnings.push(...identity.warnings as CompanyPeopleWarning[]);
  if (!identity.ok) return { ok: false, companyUrn: null, people: [], inspectedResults: 0, warnings };
  const companyUrn = identity.company.value.urn; const companyId = companyUrn.split(":").at(-1)!; const session = new Set(options.sessionUrns);
  const people: ParsedCompanyPerson[] = []; let inspectedResults = 0; const seen = new Set<string>(); let scopedBodies = 0;
  for (const capture of selected) { let root: unknown; try { root = JSON.parse(capture.body); } catch { continue; } const walked = objectsOf(root);
    if (walked.truncated) warnings.push(warning("PARSE_INPUT_TRUNCATED", "nodes", "bound")); if (!selectedCompany(walked.values, companyId)) continue; scopedBodies++;
    const refs = new Map(walked.values.flatMap((o) => typeof o["entityUrn"] === "string" ? [[o["entityUrn"] as string, o] as const] : []));
    const itemRefs = walked.values.flatMap((o) => { const item = object(o["item"]); const ref = text(item?.["*entityResult"]); return ref ? [ref] : []; });
    for (const ref of itemRefs) { if (people.length >= options.limit) break; inspectedResults++; const personUrn = RESULT.exec(ref)?.[1];
      if (personUrn === undefined || session.has(personUrn) || seen.has(personUrn)) continue; const row = refs.get(ref); if (!row) { warnings.push(warning("PARSE_FIELD_MISSING", "entity_result", "labeled-field")); continue; }
      const name = bounded(text(object(row["title"])?.["text"]), "name", warnings); const headline = bounded(text(object(row["primarySubtitle"])?.["text"]), "headline", warnings); const url = bounded(profileUrl(row["navigationUrl"]) ?? personUrn, "profile_url", warnings)!;
      if (options.name && !name?.toLocaleLowerCase().includes(options.name.toLocaleLowerCase())) continue; if (options.title && !headline?.toLocaleLowerCase().includes(options.title.toLocaleLowerCase())) continue;
      seen.add(personUrn); people.push({ company_urn: companyUrn, person_urn: personUrn, profile_url: url, ...(name ? { name } : {}), ...(headline ? { headline } : {}) });
    }
  }
  // No captured body carried a `currentCompany` filter selected on the subject, which is
  // the only thing scoping a search result to an employee. Without this, a change to that
  // filter's shape returns exit 0 with zero rows — indistinguishable from a company that
  // simply lists nobody. Say so instead.
  if (scopedBodies === 0) warnings.push(warning("PARSE_SCOPE_UNMATCHED", "current_company_filter", "labeled-field"));
  return { ok: true, companyUrn, people, inspectedResults, warnings };
}
export type { CompanyCapture };
