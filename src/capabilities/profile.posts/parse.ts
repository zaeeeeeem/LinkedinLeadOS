import type { OwnedPostProjection, PostProjection } from "../../core/store/posts.js";

type Json = Record<string, unknown>;
const ACTIVITY = /^urn:li:activity:(\d+)$/;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

export function parseJsonObject(body: string): Json | null {
  try { return object(JSON.parse(body)); } catch { return null; }
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

export function feedPostAuthorUrn(update: unknown): string | null {
  const updateObject = object(update);
  if (updateObject === null) return null;
  const actor = object(updateObject["actor"]);
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

export type FeedPostGraph = {
  byEntity: ReadonlyMap<string, Json>;
  counts: ReadonlyMap<string, Json>;
};

export function indexFeedPostGraph(includedValues: readonly unknown[]): FeedPostGraph {
  const included = includedValues.map(object).filter((x): x is Json => x !== null);
  const byEntity = new Map<string, Json>();
  const counts = new Map<string, Json>();
  for (const entity of included) {
    const key = stringAt(entity["entityUrn"]);
    if (key !== null) byEntity.set(key, entity);
    const countKey = countEntityActivity(entity);
    if (countKey !== null && typeof entity["numLikes"] === "number") counts.set(countKey, entity);
  }
  return { byEntity, counts };
}

export function projectFeedPost(updateValue: unknown, graph: FeedPostGraph): PostProjection | null {
  const update = object(updateValue);
  if (update === null) return null;
  const urn = activityUrn(object(update["metadata"])?.["backendUrn"]) ?? activityUrn(update["entityUrn"]);
  if (urn === null) return null;
  let posted_at: string;
  try { posted_at = activityPostedAt(urn).toISOString(); } catch { return null; }
  const social = graph.counts.get(socialCountKey(update, urn));
  return {
    urn,
    text: postText(update),
    posted_at,
    reactions: typeof social?.["numLikes"] === "number" ? social["numLikes"] as number : null,
    comments: typeof social?.["numComments"] === "number" ? social["numComments"] as number : null,
  };
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
  const root = parseJsonObject(body);
  const data = object(object(root?.["data"])?.["data"]);
  const feed = object(data?.["feedDashProfileUpdatesByMemberShareFeed"]);
  const refs = Array.isArray(feed?.["*elements"]) ? feed["*elements"] : [];
  const graph = indexFeedPostGraph(Array.isArray(root?.["included"]) ? root["included"] : []);
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
    const update = graph.byEntity.get(key);
    if (update === undefined) { unresolved += 1; continue; }
    const author = feedPostAuthorUrn(update);
    if (author !== options.subjectUrn) { excludedAuthors += 1; continue; }
    // Task 26 labels this identity both on included activity entities' `urn`
    // and on the resolved update's `metadata.backendUrn`; the latter is the
    // direct edge for every feed item, including items without a duplicate
    // standalone activity entity in this response.
    const post = projectFeedPost(update, graph);
    if (post === null) { unresolved += 1; continue; }
    if (new Date(post.posted_at).getTime() < sinceMs) { filteredSince += 1; continue; }
    rows.push({
      ...post,
      person_urn: options.subjectUrn,
    });
  }
  return { rows, examined: selected.length, totalFeedItems: refs.length, excludedAuthors, unresolved, filteredSince };
}
