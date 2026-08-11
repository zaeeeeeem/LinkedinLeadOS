export const MAX_SALESNAV_ACCOUNT_ROWS_PER_PAGE = 25;
export const MAX_SALESNAV_ACCOUNT_BADGES = 20;
export const MAX_SALESNAV_ACCOUNT_FIELD_CHARS = 20_000;

type Json = Record<string, unknown>;
export type SalesNavAccountWarning = { code: "PARSE_BODY_INVALID" | "PARSE_PAGING_INVALID" | "PARSE_ROW_REFUSED" | "PARSE_FIELD_MISSING" | "PARSE_INPUT_TRUNCATED" | "PARSE_FIELD_TRUNCATED"; field: string; n: number };
/** Identity is `company_urn`/`company_url` and is the only refusal ground; every
 *  other field is content, and its absence warns rather than dropping the row's
 *  place in the page. Same rule as the leads parser and `company.people`. */
export type SalesNavAccountRow = {
  source: "labeled-body";
  company_urn: string;
  company_url: string;
  page: number;
  position: number;
  company_name?: string;
  industry?: string;
  employee_count_range?: string;
  employee_display_count?: string | number;
  description?: string;
  company_picture: { root_url?: string; artifacts: number };
  spotlight_badges: Array<{ id?: string; display_value?: string }>;
  list_count?: number;
  saved?: boolean;
  tracking_id?: string;
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
/** A content field the FIELD-MAP measured on every row. Its absence is drift. */
function expected<T>(value: T | null | undefined, field: string, warnings: SalesNavAccountWarning[]): T | undefined {
  if (value === null || value === undefined) { warnings.push({ code: "PARSE_FIELD_MISSING", field, n: 1 }); return undefined; }
  return value;
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
    // Identity, and only identity, refuses a row.
    if (row === null || urn === null || id === null || refusedUrns.has(urn)) {
      refused += 1; warnings.push({ code: "PARSE_ROW_REFUSED", field: "elements", n: 1 }); continue;
    }
    const companyName = expected(bounded(nonempty(row["companyName"]), "companyName", warnings), "companyName", warnings);
    const industry = expected(bounded(nonempty(row["industry"]), "industry", warnings), "industry", warnings);
    const range = expected(bounded(nonempty(row["employeeCountRange"]), "employeeCountRange", warnings), "employeeCountRange", warnings);
    const raw = row["employeeDisplayCount"];
    const validCount = (typeof raw === "string" && raw.trim().length > 0) || (typeof raw === "number" && Number.isFinite(raw));
    const displayCount = expected(validCount ? raw as string | number : null, "employeeDisplayCount", warnings);
    const description = expected(bounded(nonempty(row["description"]), "description", warnings), "description", warnings);
    const listCount = expected(integer(row["listCount"]), "listCount", warnings);
    const saved = expected(typeof row["saved"] === "boolean" ? row["saved"] as boolean : null, "saved", warnings);
    const trackingId = expected(nonempty(row["trackingId"]), "trackingId", warnings);
    rows.push({ source: "labeled-body", company_urn: urn, company_url: `https://www.linkedin.com/sales/company/${id}`, page, position: index + 1,
      ...(companyName === undefined ? {} : { company_name: companyName }),
      ...(industry === undefined ? {} : { industry }),
      ...(range === undefined ? {} : { employee_count_range: range }),
      ...(displayCount === undefined ? {} : { employee_display_count: displayCount }),
      ...(description === undefined ? {} : { description }),
      company_picture: picture(row["companyPictureDisplayImage"]), spotlight_badges: badges(row["spotlightBadges"], warnings),
      ...(listCount === undefined ? {} : { list_count: listCount }),
      ...(saved === undefined ? {} : { saved }),
      ...(trackingId === undefined ? {} : { tracking_id: trackingId }) });
  }
  return { rows, paging: { total, count, start, page }, inspected: selected.length, refused, warnings };
}
