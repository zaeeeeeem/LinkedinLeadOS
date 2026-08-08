import type { OwnedPostProjection } from "../../core/store/posts.js";

type Json = Record<string, unknown>;
const ACTIVITY = /^urn:li:activity:(\d+)$/;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function activityUrn(value: unknown): string | null {
  const text = stringAt(value);
  if (text === null) return null;
  const match = /urn:li:activity:\d+/.exec(text);
  return match?.[0] ?? null;
}

export function activityPostedAt(urn: string): Date {
  const match = ACTIVITY.exec(urn);
  if (match === null) throw new Error("invalid LinkedIn activity urn");
  const ms = Number(BigInt(match[1]!) >> 22n);
  const date = new Date(ms);
  if (!Number.isFinite(ms) || Number.isNaN(date.getTime())) throw new Error("invalid LinkedIn activity snowflake");
  return date;
}

function actorUrn(update: Json): string | null {
  const actor = object(update["actor"]);
  const name = object(actor?.["name"]);
  const attrs = Array.isArray(name?.["attributesV2"]) ? name["attributesV2"] : [];
  for (const attr of attrs) {
    const detail = object(object(attr)?.["detailData"]);
    const urn = stringAt(detail?.["*profileFullName"]);
    if (urn?.startsWith("urn:li:fsd_profile:") === true) return urn;
  }
  return null;
}

function postText(update: Json): string | null {
  const commentary = update["commentary"];
  if (typeof commentary === "string") return commentary;
  const commentaryObject = object(commentary);
  const text = commentaryObject?.["text"];
  if (typeof text === "string") return text;
  const textObject = object(text);
  if (typeof textObject?.["text"] === "string") return textObject["text"] as string;
  const content = update["content"];
  if (typeof content === "string") return content;
  const contentObject = object(content);
  return typeof contentObject?.["text"] === "string" ? contentObject["text"] as string : null;
}

function countEntityActivity(entity: Json): string | null {
  const urn = stringAt(entity["entityUrn"]);
  if (urn === null || !urn.startsWith("urn:li:fsd_socialActivityCounts:")) return null;
  return /urn:li:(?:activity|ugcPost|share):\d+/.exec(urn)?.[0] ?? null;
}

function socialCountKey(update: Json, activity: string): string {
  const detail = stringAt(update["*socialDetail"]);
  return detail === null
    ? activity
    : /urn:li:(?:activity|ugcPost|share):\d+/.exec(detail)?.[0] ?? activity;
}

export type ParseProfilePostsOptions = { subjectUrn: string; since?: string; limit?: number };
export type ParseProfilePostsResult = {
  rows: OwnedPostProjection<"person_urn">[];
  examined: number;
  totalFeedItems: number;
  excludedAuthors: number;
  unresolved: number;
  filteredSince: number;
};

export function parseProfilePosts(body: string, options: ParseProfilePostsOptions): ParseProfilePostsResult {
  const root = object(JSON.parse(body));
  const data = object(object(root?.["data"])?.["data"]);
  const feed = object(data?.["feedDashProfileUpdatesByMemberShareFeed"]);
  const refs = Array.isArray(feed?.["*elements"]) ? feed["*elements"] : [];
  const included = Array.isArray(root?.["included"])
    ? root["included"].map(object).filter((x): x is Json => x !== null)
    : [];
  const byEntity = new Map<string, Json>();
  for (const entity of included) {
    const key = stringAt(entity["entityUrn"]);
    if (key !== null) byEntity.set(key, entity);
  }
  const counts = new Map<string, Json>();
  for (const entity of included) {
    const urn = countEntityActivity(entity);
    if (urn !== null && typeof entity["numLikes"] === "number") counts.set(urn, entity);
  }
  const workLimit = options.limit ?? refs.length;
  const selected = refs.slice(0, Math.max(0, workLimit));
  const sinceMs = options.since === undefined ? Number.NEGATIVE_INFINITY : new Date(options.since).getTime();
  const rows: OwnedPostProjection<"person_urn">[] = [];
  let excludedAuthors = 0;
  let unresolved = 0;
  let filteredSince = 0;
  for (const ref of selected) {
    const key = stringAt(ref);
    if (key === null) { unresolved += 1; continue; }
    const update = byEntity.get(key);
    if (update === undefined) { unresolved += 1; continue; }
    const author = actorUrn(update);
    if (author !== options.subjectUrn) { excludedAuthors += 1; continue; }
    // Task 26 labels this identity both on included activity entities' `urn`
    // and on the resolved update's `metadata.backendUrn`; the latter is the
    // direct edge for every feed item, including items without a duplicate
    // standalone activity entity in this response.
    const urn = activityUrn(object(update["metadata"])?.["backendUrn"]) ?? activityUrn(update["entityUrn"]);
    if (urn === null) { unresolved += 1; continue; }
    let posted_at: string;
    try {
      posted_at = activityPostedAt(urn).toISOString();
    } catch {
      unresolved += 1;
      continue;
    }
    if (new Date(posted_at).getTime() < sinceMs) { filteredSince += 1; continue; }
    const social = counts.get(socialCountKey(update, urn));
    rows.push({
      urn,
      person_urn: options.subjectUrn,
      text: postText(update),
      posted_at,
      reactions: typeof social?.["numLikes"] === "number" ? social["numLikes"] as number : null,
      comments: typeof social?.["numComments"] === "number" ? social["numComments"] as number : null,
    });
  }
  return { rows, examined: selected.length, totalFeedItems: refs.length, excludedAuthors, unresolved, filteredSince };
}
