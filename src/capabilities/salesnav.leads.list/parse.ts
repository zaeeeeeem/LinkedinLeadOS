export const MAX_SALESNAV_ROWS_PER_PAGE = 25;
export const MAX_SALESNAV_POSITIONS_PER_LEAD = 10;
export const MAX_SALESNAV_BADGES_PER_ROW = 20;
export const MAX_SALESNAV_FIELD_CHARS = 20_000;

type Json = Record<string, unknown>;

export type SalesNavParseWarning = {
  code: "PARSE_BODY_INVALID" | "PARSE_PAGING_INVALID" | "PARSE_ROW_REFUSED" | "PARSE_FIELD_MISSING" | "PARSE_INPUT_TRUNCATED" | "PARSE_FIELD_TRUNCATED";
  field: string;
  n: number;
};

export type SalesNavPosition = {
  company_urn?: string;
  company_url?: string;
  company_name: string;
  title: string;
  position_id: number;
  current: boolean;
  started_on?: { year: number; month?: number; day?: number };
  tenure_at_company?: { numYears?: number; numMonths?: number };
  tenure_at_position?: { numYears?: number; numMonths?: number };
  description?: string;
};

/**
 * Identity — `person_urn`, `sales_profile_urn`, `profile_url` — is the only part
 * of a row that is guaranteed, because it is the only part a row is refused for.
 * Every other field is content: absent means LinkedIn did not send it, which is
 * a `PARSE_FIELD_MISSING` warning to act on, not a reason to lose the row's
 * place in the page. Same rule as `company.people`.
 */
export type SalesNavLeadRow = {
  source: "labeled-body";
  person_urn: string;
  sales_profile_urn: string;
  profile_url: string;
  page: number;
  position: number;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  location?: string;
  degree?: number;
  headline?: string;
  current_positions: SalesNavPosition[];
  spotlight_badges: Array<{ id?: string; display_value?: string }>;
  tracking_id?: string;
  list_count?: number;
  saved?: boolean;
  viewed?: boolean;
  premium?: boolean;
  open_link?: boolean;
  memorialized?: boolean;
  pending_invitation?: boolean;
  block_third_party_data_sharing?: boolean;
  profile_picture: { root_url?: string; artifacts: number };
};

export type SalesNavLeadsParseResult = {
  rows: SalesNavLeadRow[];
  paging: { total: number; count: number; start: number; page: number } | null;
  inspected: number;
  refused: number;
  warnings: SalesNavParseWarning[];
};

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function bounded(value: string | null, field: string, warnings: SalesNavParseWarning[]): string | undefined {
  if (value === null) return undefined;
  if (value.length <= MAX_SALESNAV_FIELD_CHARS) return value;
  warnings.push({ code: "PARSE_FIELD_TRUNCATED", field, n: value.length - MAX_SALESNAV_FIELD_CHARS });
  return value.slice(0, MAX_SALESNAV_FIELD_CHARS);
}

/** A content field the FIELD-MAP measured on every row. Its absence is drift. */
function expected<T>(value: T | null | undefined, field: string, warnings: SalesNavParseWarning[]): T | undefined {
  if (value === null || value === undefined) {
    warnings.push({ code: "PARSE_FIELD_MISSING", field, n: 1 });
    return undefined;
  }
  return value;
}

function flag(row: Json, key: string, warnings: SalesNavParseWarning[]): boolean | undefined {
  return expected(typeof row[key] === "boolean" ? row[key] as boolean : null, key, warnings);
}

const MEMBER = /^urn:li:member:\d+$/;
const SALES_PROFILE = /^urn:li:fs_salesProfile:\(([A-Za-z0-9_-]+),([^,]+),([^,)]+)\)$/;
const COMPANY = /^urn:li:fs_salesCompany:(\d+)$/;

function sessionKeys(urns: readonly string[]): Set<string> {
  const keys = new Set(urns);
  for (const urn of urns) {
    const match = /^urn:li:(?:fsd_profile|fs_profile|fs_salesProfile):([A-Za-z0-9_-]+)$/.exec(urn);
    if (match) keys.add(`profile:${match[1]}`);
  }
  return keys;
}

function date(value: unknown): { year: number; month?: number; day?: number } | undefined {
  const row = object(value);
  const year = integer(row?.["year"]);
  if (year === null) return undefined;
  const month = integer(row?.["month"]);
  const day = integer(row?.["day"]);
  return { year, ...(month === null ? {} : { month }), ...(day === null ? {} : { day }) };
}

function tenure(value: unknown): { numYears?: number; numMonths?: number } | undefined {
  const row = object(value);
  if (row === null) return undefined;
  const years = integer(row["numYears"]);
  const months = integer(row["numMonths"]);
  if (years === null && months === null) return undefined;
  return { ...(years === null ? {} : { numYears: years }), ...(months === null ? {} : { numMonths: months }) };
}

function parsePosition(value: unknown, warnings: SalesNavParseWarning[]): SalesNavPosition | null {
  const row = object(value);
  const companyName = bounded(nonempty(row?.["companyName"]), "currentPositions.companyName", warnings);
  const title = bounded(nonempty(row?.["title"]), "currentPositions.title", warnings);
  const positionId = integer(row?.["posId"]);
  if (row === null || companyName === undefined || title === undefined || positionId === null || typeof row["current"] !== "boolean") return null;
  const companyUrn = nonempty(row["companyUrn"]);
  const companyId = companyUrn === null ? null : COMPANY.exec(companyUrn)?.[1] ?? null;
  const description = bounded(nonempty(row["description"]), "currentPositions.description", warnings);
  const startedOn = date(row["startedOn"]);
  const atCompany = tenure(row["tenureAtCompany"]);
  const atPosition = tenure(row["tenureAtPosition"]);
  return {
    company_name: companyName,
    title,
    position_id: positionId,
    current: row["current"] as boolean,
    ...(companyId === null ? {} : { company_urn: companyUrn!, company_url: `https://www.linkedin.com/sales/company/${companyId}` }),
    ...(startedOn === undefined ? {} : { started_on: startedOn }),
    ...(atCompany === undefined ? {} : { tenure_at_company: atCompany }),
    ...(atPosition === undefined ? {} : { tenure_at_position: atPosition }),
    ...(description === undefined ? {} : { description }),
  };
}

function parseBadges(value: unknown, warnings: SalesNavParseWarning[]): Array<{ id?: string; display_value?: string }> {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_SALESNAV_BADGES_PER_ROW) warnings.push({ code: "PARSE_INPUT_TRUNCATED", field: "spotlightBadges", n: value.length - MAX_SALESNAV_BADGES_PER_ROW });
  return value.slice(0, MAX_SALESNAV_BADGES_PER_ROW).flatMap((item) => {
    const row = object(item);
    if (row === null) return [];
    const id = nonempty(row["id"]);
    const display = nonempty(row["displayValue"]);
    return [{ ...(id === null ? {} : { id }), ...(display === null ? {} : { display_value: display }) }];
  });
}

function picture(value: unknown): { root_url?: string; artifacts: number } {
  const row = object(value);
  const root = nonempty(row?.["rootUrl"]);
  return { ...(root === null ? {} : { root_url: root }), artifacts: Array.isArray(row?.["artifacts"]) ? row["artifacts"].length : 0 };
}

export function parseSalesNavLeads(body: string, options: { sessionUrns?: readonly string[] } = {}): SalesNavLeadsParseResult {
  const warnings: SalesNavParseWarning[] = [];
  let root: Json | null;
  try { root = object(JSON.parse(body)); } catch { root = null; }
  if (root === null) return { rows: [], paging: null, inspected: 0, refused: 0, warnings: [{ code: "PARSE_BODY_INVALID", field: "body", n: 1 }] };

  const pagingRow = object(root["paging"]);
  const total = integer(pagingRow?.["total"]);
  const count = integer(pagingRow?.["count"]);
  const start = integer(pagingRow?.["start"]);
  if (total === null || count === null || count <= 0 || start === null || start < 0 || start % count !== 0) {
    return { rows: [], paging: null, inspected: 0, refused: 0, warnings: [{ code: "PARSE_PAGING_INVALID", field: "paging", n: 1 }] };
  }
  const page = start / count + 1;
  const elements = Array.isArray(root["elements"]) ? root["elements"] : [];
  const selected = elements.slice(0, Math.min(count, MAX_SALESNAV_ROWS_PER_PAGE));
  if (selected.length < elements.length) warnings.push({ code: "PARSE_INPUT_TRUNCATED", field: "elements", n: elements.length - selected.length });
  const session = sessionKeys(options.sessionUrns ?? []);
  const rows: SalesNavLeadRow[] = [];
  let refused = 0;

  for (let index = 0; index < selected.length; index++) {
    const row = object(selected[index]);
    const memberUrn = nonempty(row?.["objectUrn"]);
    const entityUrn = nonempty(row?.["entityUrn"]);
    const entity = entityUrn === null ? null : SALES_PROFILE.exec(entityUrn);
    // Identity, and only identity, refuses a row: an unresolvable subject or the
    // operator's own. Content is handled below, where absence warns instead.
    const identified = row !== null && memberUrn !== null && MEMBER.test(memberUrn) && entity !== null &&
      !session.has(memberUrn) && !session.has(entityUrn!) && !session.has(`profile:${entity[1]}`);
    if (!identified) {
      refused += 1;
      warnings.push({ code: "PARSE_ROW_REFUSED", field: "elements", n: 1 });
      continue;
    }
    const fullName = expected(bounded(nonempty(row["fullName"]), "fullName", warnings), "fullName", warnings);
    const firstName = expected(bounded(nonempty(row["firstName"]), "firstName", warnings), "firstName", warnings);
    const lastName = expected(bounded(nonempty(row["lastName"]), "lastName", warnings), "lastName", warnings);
    const location = expected(bounded(nonempty(row["geoRegion"]), "geoRegion", warnings), "geoRegion", warnings);
    const degree = expected(integer(row["degree"]), "degree", warnings);
    const trackingId = expected(nonempty(row["trackingId"]), "trackingId", warnings);
    const listCount = expected(integer(row["listCount"]), "listCount", warnings);
    const saved = flag(row, "saved", warnings);
    const viewed = flag(row, "viewed", warnings);
    const premium = flag(row, "premium", warnings);
    const openLink = flag(row, "openLink", warnings);
    const memorialized = flag(row, "memorialized", warnings);
    const pendingInvitation = flag(row, "pendingInvitation", warnings);
    const blockThirdPartyDataSharing = flag(row, "blockThirdPartyDataSharing", warnings);

    const positionsRaw = Array.isArray(row["currentPositions"]) ? row["currentPositions"] as unknown[] : [];
    if (positionsRaw.length === 0) warnings.push({ code: "PARSE_FIELD_MISSING", field: "currentPositions", n: 1 });
    if (positionsRaw.length > MAX_SALESNAV_POSITIONS_PER_LEAD) warnings.push({ code: "PARSE_INPUT_TRUNCATED", field: "currentPositions", n: positionsRaw.length - MAX_SALESNAV_POSITIONS_PER_LEAD });
    const considered = positionsRaw.slice(0, MAX_SALESNAV_POSITIONS_PER_LEAD);
    const positions = considered.map((item) => parsePosition(item, warnings)).filter((item): item is SalesNavPosition => item !== null);
    // A position that does not resolve is dropped and named; it never takes the
    // whole row with it, and it never shifts another position's meaning.
    if (positions.length < considered.length) warnings.push({ code: "PARSE_FIELD_MISSING", field: "currentPositions.position", n: considered.length - positions.length });

    const headline = bounded(nonempty(row["summary"]), "summary", warnings);
    rows.push({
      source: "labeled-body",
      person_urn: memberUrn,
      sales_profile_urn: entityUrn!,
      profile_url: `https://www.linkedin.com/sales/lead/${entity![1]},${entity![2]},${entity![3]}`,
      page,
      position: index + 1,
      ...(fullName === undefined ? {} : { full_name: fullName }),
      ...(firstName === undefined ? {} : { first_name: firstName }),
      ...(lastName === undefined ? {} : { last_name: lastName }),
      ...(location === undefined ? {} : { location }),
      ...(degree === undefined ? {} : { degree }),
      ...(headline === undefined ? {} : { headline }),
      current_positions: positions,
      spotlight_badges: parseBadges(row["spotlightBadges"], warnings),
      ...(trackingId === undefined ? {} : { tracking_id: trackingId }),
      ...(listCount === undefined ? {} : { list_count: listCount }),
      ...(saved === undefined ? {} : { saved }),
      ...(viewed === undefined ? {} : { viewed }),
      ...(premium === undefined ? {} : { premium }),
      ...(openLink === undefined ? {} : { open_link: openLink }),
      ...(memorialized === undefined ? {} : { memorialized }),
      ...(pendingInvitation === undefined ? {} : { pending_invitation: pendingInvitation }),
      ...(blockThirdPartyDataSharing === undefined ? {} : { block_third_party_data_sharing: blockThirdPartyDataSharing }),
      profile_picture: picture(row["profilePictureDisplayImage"]),
    });
  }
  return { rows, paging: { total, count, start, page }, inspected: selected.length, refused, warnings };
}
