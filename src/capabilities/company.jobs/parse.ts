import { embeddedJsonOf } from "../../core/fixtures/sweep.js";
import { EXIT } from "../../core/run/receipt.js";
import type { JobInput } from "../../core/store/types.js";
import { normalizeCompanyUrn, parseCompanyCaptures, type CompanyCapture } from "../company.get/parse.js";

export const MAX_COMPANY_JOB_BODIES = 128;
export const MAX_COMPANY_JOB_NODES = 150_000;
export const MAX_COMPANY_JOB_FIELD_CHARS = 20_000;
type Obj = Record<string, unknown>;
export type CompanyJobsWarning = {
  code: "PARSE_IDENTITY_UNRESOLVED" | "PARSE_IDENTITY_IS_SESSION" | "PARSE_FIELD_MISSING" |
    "PARSE_FIELD_TRUNCATED" | "PARSE_INPUT_TRUNCATED" | "PARSE_SCOPE_UNMATCHED";
  field: string; n: number; exit: typeof EXIT.PARSE_DRIFT;
  basis: "identity" | "labeled-field" | "bound";
};
export type CompanyJobsParseResult =
  | { ok: true; companyUrn: string; jobs: JobInput[]; inspectedPostings: number; warnings: CompanyJobsWarning[] }
  | { ok: false; companyUrn: null; jobs: []; inspectedPostings: number; warnings: CompanyJobsWarning[] };

const JOB_URN = /^urn:li:(?:fsd_jobPosting|jobPosting):(\d+)$/;
export function canonicalJobId(value: unknown): string | null {
  return typeof value === "string" ? JOB_URN.exec(value)?.[1] ?? null : null;
}
function object(value: unknown): Obj | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null; }
function text(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function warn(code: CompanyJobsWarning["code"], field: string, basis: CompanyJobsWarning["basis"], n = 1): CompanyJobsWarning {
  return { code, field, basis, n, exit: EXIT.PARSE_DRIFT };
}
function bounded(value: string | undefined, field: string, warnings: CompanyJobsWarning[]) {
  if (value === undefined || value.length <= MAX_COMPANY_JOB_FIELD_CHARS) return value;
  warnings.push(warn("PARSE_FIELD_TRUNCATED", field, "bound", value.length - MAX_COMPANY_JOB_FIELD_CHARS));
  return value.slice(0, MAX_COMPANY_JOB_FIELD_CHARS);
}
function roots(capture: CompanyCapture): unknown[] {
  if (/^https:\/\/[^/]*linkedin\.com\/company\//i.test(capture.url)) return embeddedJsonOf(capture.body).map((item) => item.value);
  try { return [JSON.parse(capture.body)]; } catch { return []; }
}
function objectsOf(root: unknown): { values: Obj[]; truncated: boolean } {
  const values: Obj[] = []; const stack: Array<{ value: unknown; inSchema: boolean }> = [{ value: root, inSchema: false }];
  const seen = new WeakSet<object>(); let nodes = 0;
  while (stack.length && nodes < MAX_COMPANY_JOB_NODES) {
    const item = stack.pop()!; nodes++; const value = item.value;
    if (item.inSchema || value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) stack.push({ value: value[i], inSchema: false });
    else {
      const row = value as Obj; values.push(row);
      for (const [key, child] of Object.entries(row)) stack.push({ value: child, inSchema: key === "microSchema" });
    }
  }
  return { values, truncated: stack.length > 0 };
}
function postedAt(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

export function parseCompanyJobs(captures: readonly CompanyCapture[], options: { targetVanity: string; sessionUrns: readonly string[]; limit: number }): CompanyJobsParseResult {
  const warnings: CompanyJobsWarning[] = []; const selected = captures.slice(0, MAX_COMPANY_JOB_BODIES);
  if (selected.length < captures.length) warnings.push(warn("PARSE_INPUT_TRUNCATED", "captures", "bound", captures.length - selected.length));
  const identity = parseCompanyCaptures(selected, { targetVanity: options.targetVanity, sessionUrns: options.sessionUrns });
  warnings.push(...identity.warnings as CompanyJobsWarning[]);
  if (!identity.ok) return { ok: false, companyUrn: null, jobs: [], inspectedPostings: 0, warnings };
  const companyUrn = identity.company.value.urn; const all: Obj[] = [];
  for (const capture of selected) for (const root of roots(capture)) {
    const walked = objectsOf(root); all.push(...walked.values);
    if (walked.truncated) warnings.push(warn("PARSE_INPUT_TRUNCATED", "nodes", "bound"));
  }
  const refs = new Map(all.flatMap((row) => typeof row["entityUrn"] === "string" ? [[row["entityUrn"] as string, row] as const] : []));
  const jobUrnRows = all.filter((row) => canonicalJobId(row["entityUrn"]) !== null);
  const candidates = jobUrnRows.filter((row) => Object.hasOwn(row, "listedAt"));
  const jobs: JobInput[] = []; const seen = new Set<string>(); let inspectedPostings = 0; let scoped = 0;
  for (const row of candidates) {
    if (jobs.length >= options.limit) break;
    inspectedPostings++;
    const company = normalizeCompanyUrn(object(object(row["companyDetails"])?.["jobCompany"])?.["*company"]);
    if (company !== companyUrn) continue;
    scoped++;
    if (row["jobState"] !== "LISTED") continue;
    const id = canonicalJobId(row["entityUrn"]);
    if (id === null || seen.has(id)) continue;
    const value: JobInput = { id, company_urn: companyUrn };
    const title = bounded(text(row["title"]), "title", warnings);
    if (title === undefined) warnings.push(warn("PARSE_FIELD_MISSING", "title", "labeled-field")); else value.title = title;
    const locationRef = text(row["*location"]); const location = bounded(text(locationRef === undefined ? undefined : refs.get(locationRef)?.["fullLocalizedName"]), "location", warnings);
    if (location === undefined) warnings.push(warn("PARSE_FIELD_MISSING", "location", "labeled-field")); else value.location = location;
    const date = postedAt(row["listedAt"]);
    if (date === undefined) warnings.push(warn("PARSE_FIELD_MISSING", "posted_at", "labeled-field")); else value.posted_at = date;
    const description = bounded(text(object(row["description"])?.["text"]), "description", warnings);
    if (description !== undefined) value.description = description;
    seen.add(id); jobs.push(value);
  }
  // Zero rows has two causes and they must not share a receipt. No job urn anywhere means
  // the company lists no openings. Job urns present but no record carrying `listedAt` means
  // the posting shape moved under us — drift, and exit 0 with silence would hide it (D200a).
  if (jobUrnRows.length > 0 && candidates.length === 0) warnings.push(warn("PARSE_SCOPE_UNMATCHED", "job_posting_shape", "labeled-field"));
  if (candidates.length > 0 && scoped === 0) warnings.push(warn("PARSE_SCOPE_UNMATCHED", "job_company", "labeled-field"));
  return { ok: true, companyUrn, jobs, inspectedPostings, warnings };
}
export type { CompanyCapture };
