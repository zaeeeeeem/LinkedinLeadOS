import * as cheerio from "cheerio";
import { normalizeJobUrl } from "../job.capture/url.js";

export const DOM_SOURCE = "dom-snapshot" as const;
const JOB_URN = /urn:li:(?:fsd_jobPosting|fs_normalized_jobPosting|jobPosting):([0-9]{5,20})/g;
const COMPANY_URN = /urn:li:(?:fsd_company|company):([0-9]{1,30})/g;

export type JobParseWarning = { code: "PARSE_FIELD_MISSING" | "PARSE_COMPANY_IDENTITY_REFUSED"; field: string; n: number };
export type ParsedJob = {
  ok: true;
  job: { source: typeof DOM_SOURCE; value: { id: string; description?: string; company_urn?: string } };
  warnings: JobParseWarning[];
} | { ok: false; job: null; warnings: JobParseWarning[] };

function urnText(html: string): string { return html.replaceAll(/%3A/gi, ":"); }
function idsIn(text: string, re: RegExp): string[] { return [...new Set([...text.matchAll(re)].map((m) => m[1]!))]; }
function clean(value: string): string { return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(); }

/** Pure parser for an already archived outerHTML snapshot. */
export function parseJobSnapshot(html: string, input: { url: string; sessionUrns?: readonly string[] }): ParsedJob {
  const target = normalizeJobUrl(input.url);
  const normalized = urnText(html);
  const jobIds = idsIn(normalized, JOB_URN);
  if (jobIds.length !== 1 || jobIds[0] !== target.id) return { ok: false, job: null, warnings: [] };

  const warnings: JobParseWarning[] = [];
  const $ = cheerio.load(html);
  const anchor = $("[data-testid='expandable-text-box']").first();
  const block = anchor.length === 0 ? null : anchor.parent().parent();
  const about = block?.find("h2").filter((_, n) => clean($(n).text()) === "About the job").length === 1;
  let description: string | undefined;
  if (block !== null && about) {
    const paragraphs = block.children("p").slice(1).map((_, n) => clean($(n).text())).get()
      .filter((v) => v !== "" && v !== "… more");
    const joined = clean(paragraphs.join("\n"));
    if (joined !== "") description = joined;
  }
  if (description === undefined) warnings.push({ code: "PARSE_FIELD_MISSING", field: "description", n: 1 });

  const candidates = idsIn(normalized, COMPANY_URN).map((id) => `urn:li:fsd_company:${id}`);
  const session = new Set(input.sessionUrns ?? []);
  const trusted = candidates.filter((urn) => !session.has(urn));
  const company_urn = candidates.length === 1 && trusted.length === 1 ? trusted[0] : undefined;
  if (candidates.length > 0 && company_urn === undefined) {
    warnings.push({ code: "PARSE_COMPANY_IDENTITY_REFUSED", field: "company_urn", n: candidates.length });
  }
  return { ok: true, job: { source: DOM_SOURCE, value: { id: target.id, ...(description === undefined ? {} : { description }), ...(company_urn === undefined ? {} : { company_urn }) } }, warnings };
}
