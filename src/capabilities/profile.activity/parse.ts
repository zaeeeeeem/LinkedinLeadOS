import type { PostProjection } from "../../core/store/posts.js";
import { feedPostAuthorUrn, indexFeedPostGraph, parseJsonObject, projectFeedPost } from "../profile.posts/parse.js";

type Json = Record<string, unknown>;

function object(value: unknown): Json | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
}

function stringAt(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function profileUrnsFromAttributedText(value: unknown): string[] {
  const text = object(value);
  const attrs = Array.isArray(text?.["attributesV2"]) ? text["attributesV2"] : [];
  const urns: string[] = [];
  for (const attr of attrs) {
    const detail = object(object(attr)?.["detailData"]);
    const urn = stringAt(detail?.["*profileFullName"]);
    if (urn?.startsWith("urn:li:fsd_profile:") === true) urns.push(urn);
  }
  return urns;
}

function activityActorUrns(update: Json): string[] {
  return profileUrnsFromAttributedText(object(update["header"])?.["text"]);
}

export type ActivityKind = "comment" | "reaction";
export type ActivityProjection = PostProjection & {
  kind: ActivityKind;
  actor_urn: string;
  target_author_urn: string;
};

export type ParseProfileActivityOptions = {
  subjectUrn: string;
  sessionUrns: readonly string[];
  limit?: number;
  since?: string;
};

export type ParseProfileActivityResult = {
  rows: ActivityProjection[];
  examined: number;
  totalFeedItems: number;
  excludedActors: number;
  excludedSessionActors: number;
  unresolved: number;
  filteredSince: number;
};

export function parseProfileActivity(body: string, options: ParseProfileActivityOptions): ParseProfileActivityResult {
  const root = parseJsonObject(body);
  const data = object(object(root?.["data"])?.["data"]);
  const comments = object(data?.["feedDashProfileUpdatesByMemberComments"]);
  const reactions = object(data?.["feedDashProfileUpdatesByMemberReactions"]);
  const feed = comments ?? reactions;
  const kind: ActivityKind | null = comments !== null ? "comment" : reactions !== null ? "reaction" : null;
  if (kind === null || feed === null) {
    return { rows: [], examined: 0, totalFeedItems: 0, excludedActors: 0, excludedSessionActors: 0, unresolved: 0, filteredSince: 0 };
  }
  const refs = Array.isArray(feed?.["*elements"]) ? feed["*elements"] : [];
  const graph = indexFeedPostGraph(Array.isArray(root?.["included"]) ? root["included"] : []);
  const selected = refs.slice(0, Math.max(0, options.limit ?? refs.length));
  const sessions = new Set(options.sessionUrns);
  const sinceMs = options.since === undefined ? Number.NEGATIVE_INFINITY : new Date(options.since).getTime();
  const rows: ActivityProjection[] = [];
  let excludedActors = 0;
  let excludedSessionActors = 0;
  let unresolved = 0;
  let filteredSince = 0;

  for (const ref of selected) {
    const key = stringAt(ref);
    const update = key === null ? undefined : graph.byEntity.get(key);
    if (update === undefined) { unresolved += 1; continue; }
    const actorUrns = activityActorUrns(update);
    if (actorUrns.length === 0) { unresolved += 1; continue; }
    if (!actorUrns.includes(options.subjectUrn)) { excludedActors += 1; continue; }
    const actor = options.subjectUrn;
    if (sessions.has(actor)) { excludedSessionActors += 1; continue; }
    const targetAuthor = feedPostAuthorUrn(update);
    const post = projectFeedPost(update, graph);
    if (targetAuthor === null || post === null) { unresolved += 1; continue; }
    if (Date.parse(post.posted_at) < sinceMs) { filteredSince += 1; continue; }
    rows.push({ ...post, kind, actor_urn: actor, target_author_urn: targetAuthor });
  }

  return {
    rows,
    examined: selected.length,
    totalFeedItems: refs.length,
    excludedActors,
    excludedSessionActors,
    unresolved,
    filteredSince,
  };
}
