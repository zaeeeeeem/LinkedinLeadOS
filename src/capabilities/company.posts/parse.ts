import { EXIT } from "../../core/run/receipt.js";
import type { CompanyPostInput } from "../../core/store/types.js";
import { normalizeCompanyUrn, parseCompanyCaptures, type CompanyCapture } from "../company.get/parse.js";

export const MAX_COMPANY_POST_BODIES = 256;
export const MAX_COMPANY_POST_NODES = 200_000;
export const MAX_COMPANY_POST_TEXT_CHARS = 20_000;

type Obj = Record<string, unknown>;
export type CompanyPostsWarning = {
  code: "PARSE_IDENTITY_UNRESOLVED" | "PARSE_IDENTITY_IS_SESSION" | "PARSE_FIELD_MISSING" |
    "PARSE_FIELD_TRUNCATED" | "PARSE_INPUT_TRUNCATED" | "PARSE_REFERENCE_UNRESOLVED";
  field: string; n: number; exit: typeof EXIT.PARSE_DRIFT;
  basis: "identity" | "labeled-field" | "bound" | "reference";
};
export type CompanyPostsParseResult =
  | { ok: true; companyUrn: string; posts: CompanyPostInput[]; inspectedUpdates: number; warnings: CompanyPostsWarning[] }
  | { ok: false; companyUrn: null; posts: []; inspectedUpdates: number; warnings: CompanyPostsWarning[] };

function warn(code: CompanyPostsWarning["code"], field: string, basis: CompanyPostsWarning["basis"], n = 1): CompanyPostsWarning {
  return { code, field, basis, n, exit: EXIT.PARSE_DRIFT };
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
function object(value: unknown): Obj | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : null;
}
function objectsOf(root: unknown): { values: Obj[]; truncated: boolean } {
  const values: Obj[] = [];
  const stack = [root];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0 && nodes < MAX_COMPANY_POST_NODES) {
    const value = stack.pop(); nodes++;
    if (value === null || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) for (let i = value.length - 1; i >= 0; i--) stack.push(value[i]);
    else {
      values.push(value as Obj);
      for (const child of Object.values(value as Obj)) stack.push(child);
    }
  }
  return { values, truncated: stack.length > 0 };
}
function actorCompanyUrn(update: Obj): string | null {
  const actor = object(update["actor"]); const name = object(actor?.["name"]);
  const attrs = Array.isArray(name?.["attributesV2"]) ? name["attributesV2"] : [];
  for (const attr of attrs) {
    const detail = object(object(attr)?.["detailData"]);
    if (detail !== null && Object.hasOwn(detail, "*companyName")) return normalizeCompanyUrn(detail["*companyName"]);
  }
  return null;
}
export function postedAtFromActivityUrn(urn: string): string | null {
  const match = /^urn:li:activity:(\d+)$/.exec(urn);
  if (match === null) return null;
  try { return new Date(Number(BigInt(match[1]!) >> 22n)).toISOString(); } catch { return null; }
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function parseCompanyPosts(
  captures: readonly CompanyCapture[],
  options: { targetVanity: string; sessionUrns: readonly string[]; limit: number; since?: number },
): CompanyPostsParseResult {
  const warnings: CompanyPostsWarning[] = [];
  const selected = captures.slice(0, MAX_COMPANY_POST_BODIES);
  if (selected.length < captures.length) warnings.push(warn("PARSE_INPUT_TRUNCATED", "captures", "bound", captures.length - selected.length));
  const identity = parseCompanyCaptures(selected, { targetVanity: options.targetVanity, sessionUrns: options.sessionUrns });
  for (const item of identity.warnings) warnings.push(item as CompanyPostsWarning);
  if (!identity.ok) return { ok: false, companyUrn: null, posts: [], inspectedUpdates: 0, warnings };
  const companyUrn = identity.company.value.urn;

  const all: Obj[] = [];
  for (const capture of selected) {
    let root: unknown;
    try { root = JSON.parse(capture.body); } catch { continue; }
    const walked = objectsOf(root); all.push(...walked.values);
    if (walked.truncated) warnings.push(warn("PARSE_INPUT_TRUNCATED", "nodes", "bound"));
  }
  const refs = new Map<string, Obj>();
  for (const value of all) if (typeof value["entityUrn"] === "string") refs.set(value["entityUrn"] as string, value);
  const updates = all.filter((value) => object(value["metadata"]) !== null && text(object(value["metadata"])?.["backendUrn"])?.startsWith("urn:li:activity:"));
  const posts: CompanyPostInput[] = [];
  // One activity reaches us more than once: scrolling the posts tab pages the feed,
  // and consecutive pages overlap. Duplicates would make `--limit` count the same
  // post twice and would make the batch upsert fail outright — Postgres refuses an
  // ON CONFLICT that touches one row a second time. First occurrence wins.
  const seenUrns = new Set<string>();
  let inspectedUpdates = 0;
  for (const update of updates) {
    if (posts.length >= options.limit) break;
    inspectedUpdates++;
    if (actorCompanyUrn(update) !== companyUrn) continue;
    const urn = text(object(update["metadata"])?.["backendUrn"]);
    if (urn === undefined || seenUrns.has(urn)) continue;
    seenUrns.add(urn);
    const postedAt = postedAtFromActivityUrn(urn);
    if (postedAt === null) { warnings.push(warn("PARSE_FIELD_MISSING", "posted_at", "labeled-field")); continue; }
    const postedMs = Date.parse(postedAt);
    if (options.since !== undefined && postedMs < options.since) continue;
    const commentary = object(update["commentary"]); const textModel = object(commentary?.["text"]);
    let body = text(textModel?.["text"]);
    if (body !== undefined && body.length > MAX_COMPANY_POST_TEXT_CHARS) {
      warnings.push(warn("PARSE_FIELD_TRUNCATED", "text", "bound", body.length - MAX_COMPANY_POST_TEXT_CHARS));
      body = body.slice(0, MAX_COMPANY_POST_TEXT_CHARS);
    }
    const socialRef = text(update["*socialDetail"]); const social = socialRef === undefined ? undefined : refs.get(socialRef);
    const countsRef = text(social?.["*totalSocialActivityCounts"]); const counts = countsRef === undefined ? undefined : refs.get(countsRef);
    if (social === undefined || counts === undefined) warnings.push(warn("PARSE_REFERENCE_UNRESOLVED", "social_counts", "reference"));
    posts.push({ urn, company_urn: companyUrn, ...(body === undefined ? {} : { text: body }), posted_at: postedAt,
      ...(count(counts?.["numLikes"]) === undefined ? {} : { reactions: count(counts?.["numLikes"]) }),
      ...(count(counts?.["numComments"]) === undefined ? {} : { comments: count(counts?.["numComments"]) }) });
  }
  return { ok: true, companyUrn, posts, inspectedUpdates, warnings };
}

export type { CompanyCapture };
