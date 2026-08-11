export const MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE = 25;
export const MAX_SALESNAV_ACCOUNT_BADGES = 20;
export const MAX_SALESNAV_ACCOUNT_FIELD_CHARS = 20_000;

type Json = Record<string, unknown>;
export type SalesNavAccountWarning = { code: "PARSE_BODY_INVALID" | "PARSE_PAGING_INVALID" | "PARSE_ROW_REFUSED" | "PARSE_INPUT_TRUNCATED" | "PARSE_FIELD_TRUNCATED"; field: string; n: number };
export type SalesNavAccountRow = {
  source: "labeled-body";
  company_urn: string;
  company_url: string;
  page: number;
  position: number;
  company_name: string;
  industry: string;
  employee_count_range: string;
  employee_display_count: string | number;
  description: string;
  company_picture: { root_url?: string; artifacts: number };
  spotlight_badges: Array<{ id?: string; display_value?: string }>;
  list_count: number;
  saved: boolean;
  tracking_id: string;
};
export type SalesNavAccountsParseResult = { rows: SalesNavAccountRow[]; paging: { total: number; count: number; start: number; page: number } | null; inspected: number; refused: number; warnings: SalesNavAccountWarning[] };

function object(value: unknown): Json | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null; }
function nonempty(value: unknown): string | null { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
function integer(value: unknown): number | null { return typeof value === "number" && Number.isInteger(value) ? value : null; }
function bounded(value: string | null, field: string, warnings: SalesNavAccountWarning[]): string | null {
  if (value === null || value.length <= MAX_SALESNAV_ACCOUNT_FIELD_CHARS) return value;
  warnings.push({ code: "PARSE_FIELD_TRUNCATED", field, n: value.length - MAX_SALESNAV_ACCOUNT_FIELD_CHARS });
  return value.slice(0, MAX_SALESNAV_ACCOUNT_FIELD_CHARS);
}
const COMPANY = /^urn:li:fs_salesCompany:(\d+)$/;
function badges(value: unknown, warnings: SalesNavAccountWarning[]): Array<{ id?: string; display_value?: string }> {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SALESNAV_ACCOUNT_BADGES) warnings.push({ code: "PARSE_INPUT_TRUNCATED", field: "spotlightBadges", n: value.length - MAX_SALESNAV_ACCOUNT_BADGES });
  return value.slice(0, MAX_SALESNAV_ACCOUNT_BADGES).flatMap((item) => {
    const row = object(item); if (row === null) return [];
    const id = nonempty(row["id"]); const display = nonempty(row["displayValue"]);
    return [{ ...(id === null ? {} : { id }), ...(display === null ? {} : { display_value: display }) }];
  });
}
function picture(value: unknown): { root_url?: string; artifacts: number } {
  const row = object(value); const root = nonempty(row?.["rootUrl"]);
  return { ...(root === null ? {} : { root_url: root }), artifacts: Array.isArray(row?.["artifacts"]) ? row["artifacts"].length : 0 };
}

export function parseSalesNavAccounts(body: string, options: { refusedUrns?: readonly string[] } = {}): SalesNavAccountsParseResult {
  const warnings: SalesNavAccountWarning[] = [];
  let root: Json | null;
  try { root = object(JSON.parse(body)); } catch { root = null; }
  if (root === null) return { rows: [], paging: null, inspected: 0, refused: 0, warnings: [{ code: "PARSE_BODY_INVALID", field: "body", n: 1 }] };
  const pagingRow = object(root["paging"]); const total = integer(pagingRow?.["total"]); const count = integer(pagingRow?.["count"]); const start = integer(pagingRow?.["start"]);
  if (total === null || count === null || count <= 0 || start === null || start < 0 || start % count !== 0) return { rows: [], paging: null, inspected: 0, refused: 0, warnings: [{ code: "PARSE_PAGING_INVALID", field: "paging", n: 1 }] };
  const page = start / count + 1;
  const elements = Array.isArray(root["elements"]) ? root["elements"] : [];
  const selected = elements.slice(0, Math.min(count, MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE));
  if (selected.length < elements.length) warnings.push({ code: "PARSE_INPUT_TRUNCATED", field: "elements", n: elements.length - selected.length });
  const refusedUrns = new Set(options.refusedUrns ?? []); const rows: SalesNavAccountRow[] = []; let refused = 0;
  for (let index = 0; index < selected.length; index++) {
    const row = object(selected[index]); const urn = nonempty(row?.["entityUrn"]); const id = urn === null ? null : COMPANY.exec(urn)?.[1] ?? null;
    const companyName = bounded(nonempty(row?.["companyName"]), "companyName", warnings); const industry = bounded(nonempty(row?.["industry"]), "industry", warnings);
    const range = bounded(nonempty(row?.["employeeCountRange"]), "employeeCountRange", warnings); const displayCount = row?.["employeeDisplayCount"];
    const description = bounded(nonempty(row?.["description"]), "description", warnings); const listCount = integer(row?.["listCount"]); const trackingId = nonempty(row?.["trackingId"]);
    const validCount = (typeof displayCount === "string" && displayCount.trim().length > 0) || (typeof displayCount === "number" && Number.isFinite(displayCount));
    if (row === null || urn === null || id === null || refusedUrns.has(urn) || companyName === null || industry === null || range === null || !validCount || description === null || listCount === null || typeof row["saved"] !== "boolean" || trackingId === null) {
      refused += 1; warnings.push({ code: "PARSE_ROW_REFUSED", field: "elements", n: 1 }); continue;
    }
    rows.push({ source: "labeled-body", company_urn: urn, company_url: `https://www.linkedin.com/sales/company/${id}`, page, position: index + 1,
      company_name: companyName, industry, employee_count_range: range, employee_display_count: displayCount as string | number, description,
      company_picture: picture(row["companyPictureDisplayImage"]), spotlight_badges: badges(row["spotlightBadges"], warnings), list_count: listCount, saved: row["saved"] as boolean, tracking_id: trackingId });
  }
  return { rows, paging: { total, count, start, page }, inspected: selected.length, refused, warnings };
}
