import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import {
  resolveSubjectScope,
  type HitBasis,
  type SubjectScope,
} from "../../core/fixtures/dommap.js";
import { EXIT, type Warning } from "../../core/run/receipt.js";
import type { ExperienceInput, PersonInput } from "../../core/store/types.js";
import { checkDomIdentityScope } from "./identity.js";

export const DOM_SOURCE = "dom-snapshot" as const;

export type ParseWarningCode =
  | "PARSE_SESSION_IDENTITY_UNAVAILABLE"
  | "PARSE_IDENTITY_UNRESOLVED"
  | "PARSE_IDENTITY_IS_SESSION"
  | "PARSE_FIELD_MISSING"
  | "PARSE_FIELD_UNRECOGNIZED"
  | "PARSE_FIELD_TRUNCATED";

/** A human profile cannot plausibly carry this many simultaneous/historical
 * positions. The bound prevents a malformed snapshot from growing output and
 * warning arrays without limit; every dropped candidate is reported. */
export const MAX_EXPERIENCE_ROWS = 100;

/** Parser-local warning. Task 19 may put its `Warning` projection on an ok
 * receipt or promote it to a parse-drift failure; the mapping is carried here
 * so neither caller can silently reinterpret the failure class. */
export type ProfileParseWarning = Warning & {
  code: ParseWarningCode;
  field: string;
  exit: typeof EXIT.PARSE_DRIFT;
  basis: HitBasis | "identity";
};

export type Sourced<T> = {
  source: typeof DOM_SOURCE;
  value: T;
};

/** Description is retained in the parse result because the snapshot carries
 * it. It is deliberately outside `value`: Task 14's `ExperienceInput` has no
 * description column, and passing this object directly to PostgREST must be
 * impossible by type and by shape. */
export type ParsedExperience = Sourced<ExperienceInput> & {
  description?: string;
};

export type ProfileCorroboration = {
  /** The top card's member-urn spelling. Never an identity fallback. */
  memberUrns: string[];
  /** Display text only. It is not a company urn and is never stored as one. */
  currentCompanyText?: string;
};

export type ParsedProfile = {
  ok: true;
  person: Sourced<PersonInput>;
  /** `undefined` means the card was not observed; `[]` means it was observed
   * and genuinely empty. This mirrors Task 14's omitted-vs-empty contract. */
  experience: ParsedExperience[] | undefined;
  corroboration: ProfileCorroboration;
  warnings: ProfileParseWarning[];
};

export type RefusedProfile = {
  ok: false;
  person: null;
  experience: undefined;
  corroboration: { memberUrns: [] };
  warnings: ProfileParseWarning[];
};

export type ProfileParseResult = ParsedProfile | RefusedProfile;

function warning(
  code: ParseWarningCode,
  field: string,
  basis: ProfileParseWarning["basis"],
  n = 1,
): ProfileParseWarning {
  return { code, field, n, exit: EXIT.PARSE_DRIFT, basis };
}

function refused(code:
  | "PARSE_SESSION_IDENTITY_UNAVAILABLE"
  | "PARSE_IDENTITY_UNRESOLVED"
  | "PARSE_IDENTITY_IS_SESSION"
): RefusedProfile {
  return {
    ok: false,
    person: null,
    experience: undefined,
    corroboration: { memberUrns: [] },
    warnings: [warning(code, "identity", "identity")],
  };
}

function text(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function firstText(
  roots: readonly cheerio.Cheerio<AnyNode>[],
  selectors: readonly string[],
): string | undefined {
  for (const root of roots) {
    for (const selector of selectors) {
      const value = text(root.find(selector).first().text());
      if (value !== "") return value;
    }
  }
  return undefined;
}

function card(scope: SubjectScope, name: string): SubjectScope["cards"][number] | undefined {
  return scope.cards.find((candidate) => candidate.name === name && !candidate.stranger);
}

const DEGREE = /^·?\s*(1st|2nd|3rd)\s*$/i;
const LOCATION = /^[^·|\n]{2,60}(,\s*[^,·|\n]{2,60}){1,3}$/;
const DATE_LIKE = /(?:present|\b(?:19|20)\d{2}\b)/i;

function isCount(value: string): boolean {
  return value.split(",").some((part) => /^\s*\d+\s*$/.test(part)) || /^\s*[\d,]+\s+\S/.test(value);
}

function topcardParagraphs($: cheerio.CheerioAPI, top: cheerio.Cheerio<AnyNode>): string[] {
  return top
    .find("p")
    .map((_, node) => text($(node).text()))
    .get()
    .filter((value) => value !== "" && !DEGREE.test(value));
}

function parseTopcard(
  $: cheerio.CheerioAPI,
  scope: SubjectScope,
  warnings: ProfileParseWarning[],
): {
  name?: string;
  headline?: string;
  location?: string;
  currentCompanyText?: string;
} {
  const ref = card(scope, "Topcard");
  if (ref === undefined) {
    for (const [field, basis] of [
      ["name", "position"], ["headline", "position"], ["location", "text-shape"],
    ] as const) warnings.push(warning("PARSE_FIELD_MISSING", field, basis));
    return {};
  }

  const top = $(ref.selector).first();
  const name = firstText(
    [top],
    ["[componentkey^='ProfileVerificationTriggerRef-'] h2", "h2"],
  );
  const paragraphs = topcardParagraphs($, top);
  const location = paragraphs.find((value) =>
    !value.includes("·") && LOCATION.test(value) && !isCount(value),
  );
  const currentCompanyText = paragraphs.find((value) => value.includes("·") && !DATE_LIKE.test(value));
  // The field-map path is positional, but known layout variants put the value
  // in different wrappers. Value-shape exclusions let those wrappers move
  // without mistaking the company/school line or location for a headline.
  const headline = paragraphs.find((value) =>
    value !== location && value !== currentCompanyText && !isCount(value) && !DATE_LIKE.test(value),
  );

  if (name === undefined) warnings.push(warning("PARSE_FIELD_MISSING", "name", "position"));
  if (headline === undefined) warnings.push(warning("PARSE_FIELD_MISSING", "headline", "position"));
  if (location === undefined) warnings.push(warning("PARSE_FIELD_MISSING", "location", "text-shape"));

  return { name, headline, location, currentCompanyText };
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

function parseProfileDate(value: string): string | null {
  const normalized = text(value).replace(/\.$/, "");
  const monthYear = /^([A-Za-z]{3,9})\s+((?:19|20)\d{2})$/.exec(normalized);
  if (monthYear !== null) {
    const month = MONTHS[monthYear[1]!.slice(0, 3).toLowerCase()];
    return month === undefined ? null : `${monthYear[2]}-${month}-01`;
  }
  const year = /^((?:19|20)\d{2})$/.exec(normalized);
  return year === null ? null : `${year[1]}-01-01`;
}

export type ParsedDateRange = Pick<ExperienceInput, "started_on" | "ended_on" | "is_current">;

/** Pure parser for the absolute dates Task 14 stores. The duration after `·`
 * is display metadata and is intentionally ignored. */
export function parseProfileDateRange(value: string): ParsedDateRange | null {
  const range = text(value)
    .replace(/[–—]/g, "-")
    .split(/\s+·\s+/, 1)[0]!;
  const match = /^(.+?)\s+-\s+(.+?)$/.exec(range);
  if (match === null) return null;
  const startedOn = parseProfileDate(match[1]!);
  if (startedOn === null) return null;
  if (/^present$/i.test(match[2]!)) {
    return { started_on: startedOn, ended_on: null, is_current: true };
  }
  const endedOn = parseProfileDate(match[2]!);
  return endedOn === null
    ? null
    : { started_on: startedOn, ended_on: endedOn, is_current: false };
}

function paragraphs($: cheerio.CheerioAPI, root: cheerio.Cheerio<Element>): string[] {
  return root
    .find("p")
    .map((_, node) => text($(node).text()))
    .get()
    .filter(Boolean);
}

function withoutChildren(root: cheerio.Cheerio<Element>, selector: string): cheerio.Cheerio<Element> {
  const clone = root.clone();
  clone.find(selector).remove();
  return clone;
}

function companyNameFrom(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const name = text(value.split(/\s+·\s+/, 1)[0]!);
  return name === "" ? undefined : name;
}

function companyUrn($: cheerio.CheerioAPI, root: cheerio.Cheerio<Element>): string | undefined {
  for (const href of root.find("a[href*='/company/']").map((_, node) => $(node).attr("href") ?? "").get()) {
    try {
      const segment = new URL(href, "https://www.linkedin.com").pathname.match(/^\/company\/(\d+)\/?$/)?.[1];
      if (segment !== undefined) return `urn:li:fsd_company:${segment}`;
    } catch {
      // A malformed href is just absent corroboration, never a parser failure.
    }
  }
  return undefined;
}

function descriptionOf($: cheerio.CheerioAPI, root: cheerio.Cheerio<Element>): string | undefined {
  for (const node of root.find("p").toArray()) {
    const paragraph = $(node);
    if (paragraph.children("span").length === 0 && !paragraph.is("[data-field='description']")) continue;
    const clone = paragraph.clone();
    clone.find("button").remove();
    const value = text(clone.text()).replace(/(?:…|\.\.\.)?\s*see more\s*$/i, "").trim();
    if (value !== "") return value;
  }
  return undefined;
}

function experienceRow(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<Element>,
  company: string | undefined,
  index: number,
  warnings: ProfileParseWarning[],
): ParsedExperience | null {
  const lines = paragraphs($, root);
  const dateText = lines.find((line) => parseProfileDateRange(line) !== null);
  const date = dateText === undefined ? null : parseProfileDateRange(dateText);
  const description = descriptionOf($, root);
  const title = lines.find((line) =>
    line !== dateText && line !== company && !line.includes(" · ") && description !== line,
  );
  const inferredCompany = company ?? companyNameFrom(lines.find((line) =>
    line !== title && line !== dateText && !LOCATION.test(line),
  ));

  if (title === undefined) warnings.push(warning("PARSE_FIELD_MISSING", `experience[${index}].title`, "position"));
  if (inferredCompany === undefined) {
    warnings.push(warning("PARSE_FIELD_MISSING", `experience[${index}].company_name`, "position"));
  }
  if (date === null) warnings.push(warning("PARSE_FIELD_UNRECOGNIZED", `experience[${index}].date`, "text-shape"));
  if (title === undefined && inferredCompany === undefined && date === null) return null;

  const value: ExperienceInput = {};
  const urn = companyUrn($, root);
  if (urn !== undefined) value.company_urn = urn;
  if (inferredCompany !== undefined) value.company_name = inferredCompany;
  if (title !== undefined) value.title = title;
  if (date !== null) Object.assign(value, date);

  return {
    source: DOM_SOURCE,
    value,
    ...(description === undefined ? {} : { description }),
  };
}

function parseExperience(
  $: cheerio.CheerioAPI,
  scope: SubjectScope,
  warnings: ProfileParseWarning[],
): ParsedExperience[] | undefined {
  const ref = card(scope, "ExperienceTopLevelSection");
  if (ref === undefined) {
    warnings.push(warning("PARSE_FIELD_MISSING", "experience", "componentkey"));
    return undefined;
  }

  const root = $(ref.selector).first();
  const items = root.find("[componentkey^='entity-collection-item'], [data-profile-position]");
  if (items.length === 0) {
    // A card with no item and no content is an observed empty section. A card
    // with content but no recognized item shape is drift, not an empty career.
    if (text(root.text()).replace(/^Experience\s*/i, "") !== "") {
      warnings.push(warning("PARSE_FIELD_UNRECOGNIZED", "experience", "componentkey"));
      return undefined;
    }
    return [];
  }

  let candidates = 0;
  items.each((_, itemNode) => {
    const roles = $(itemNode).children("ul").children("li").length;
    candidates += Math.max(roles, 1);
  });
  if (candidates > MAX_EXPERIENCE_ROWS) {
    warnings.push(warning(
      "PARSE_FIELD_TRUNCATED",
      "experience",
      "componentkey",
      candidates - MAX_EXPERIENCE_ROWS,
    ));
  }

  const out: ParsedExperience[] = [];
  items.each((_, itemNode) => {
    if (out.length >= MAX_EXPERIENCE_ROWS) return false;
    const item = $(itemNode as Element);
    const roles = item.children("ul").children("li").toArray();
    if (roles.length > 0) {
      const header = withoutChildren(item, "ul");
      const company = companyNameFrom(paragraphs($, header)[0]);
      for (const role of roles) {
        if (out.length >= MAX_EXPERIENCE_ROWS) break;
        const parsed = experienceRow($, $(role as Element), company, out.length, warnings);
        if (parsed !== null) out.push(parsed);
      }
      return undefined;
    }

    const lines = paragraphs($, item);
    const dateIndex = lines.findIndex((line) => parseProfileDateRange(line) !== null);
    const company = companyNameFrom(dateIndex > 1 ? lines[1] : undefined);
    const parsed = experienceRow($, item, company, out.length, warnings);
    if (parsed !== null) out.push(parsed);
    return undefined;
  });
  return out;
}

/** Parses one archived `outerHTML` snapshot. No I/O, network, globals, or live
 * DOM access: Cheerio receives the already-archived string and all output is a
 * deterministic projection of it. */
export function parseProfileSnapshot(
  html: string,
  options: { sessionUrns: readonly string[] },
): ProfileParseResult {
  // Without the `/voyager/api/me` comparison set this parser cannot uphold the
  // D119/D126 rule that the operator's own account is never accepted as the
  // subject. Make that missing precondition a parse refusal, not an unchecked
  // default.
  if (options.sessionUrns.length === 0) return refused("PARSE_SESSION_IDENTITY_UNAVAILABLE");
  let $: cheerio.CheerioAPI;
  let scope: SubjectScope;
  try {
    $ = cheerio.load(html);
    scope = resolveSubjectScope($);
  } catch {
    return refused("PARSE_IDENTITY_UNRESOLVED");
  }
  const identity = checkDomIdentityScope(scope, options);
  if (identity.isSession) return refused("PARSE_IDENTITY_IS_SESSION");
  if (!identity.resolved || scope.profileUrn === null) return refused("PARSE_IDENTITY_UNRESOLVED");

  const warnings: ProfileParseWarning[] = [];
  const top = parseTopcard($, scope, warnings);
  const experience = parseExperience($, scope, warnings);
  const person: PersonInput = { urn: scope.profileUrn };
  if (scope.vanity !== null) person.vanity = scope.vanity;
  if (top.name !== undefined) person.name = top.name;
  if (top.headline !== undefined) person.headline = top.headline;
  if (top.location !== undefined) person.location = top.location;
  const currentCompanyUrn = experience?.find((row) => row.value.is_current)?.value.company_urn;
  if (currentCompanyUrn !== undefined) person.current_company_urn = currentCompanyUrn;

  return {
    ok: true,
    person: { source: DOM_SOURCE, value: person },
    experience,
    corroboration: {
      memberUrns: scope.memberUrns,
      ...(top.currentCompanyText === undefined ? {} : { currentCompanyText: top.currentCompanyText }),
    },
    warnings,
  };
}

/** The only supported bridge into Task 14. Keeping it explicit prevents
 * parser-only metadata (`source`, descriptions, corroboration) from becoming
 * unknown PostgREST columns through object spreading. */
export function toPersonStoreInput(parsed: ParsedProfile): {
  person: PersonInput;
  experience?: ExperienceInput[];
} {
  return {
    person: parsed.person.value,
    ...(parsed.experience === undefined
      ? {}
      : { experience: parsed.experience.map((row) => row.value) }),
  };
}
