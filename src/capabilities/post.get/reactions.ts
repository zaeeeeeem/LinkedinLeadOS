/**
 * Reactions from the labeled Voyager body (D341).
 *
 * D313 granted the post reader a DOM exception because the SDUI permalink
 * carried no labeled JSON for the post — measured, on a cold load, with zero
 * hits on all four social watches (D312). The Ember page (D337, D340) does
 * fetch one: a `voyagerSocialDashReactions` graphql response, 69,879 bytes on
 * run `01KZP19KXT6PJK9PSXC4SNW038`, already archived by the existing
 * `gql-social-reactions` watch.
 *
 * A labeled field beats a rendered one, so when that body is present the
 * reactions come from here and not from the facepile's aria-labels. What it
 * buys, concretely: the actor's **urn** instead of a display name scraped out
 * of `"View <name>'s, reacted with LIKE, graphic"`, a `reactionType` enum
 * instead of that string's middle, and `paging.total` instead of a count read
 * off a rendered label.
 *
 * What does **not** change: reactions stay opt-in, stay bounded by `--limit`,
 * and nothing here follows `paginationToken`. The body carries the 10 rows the
 * page asked for out of 1,052; reading the rest would be the loop D313 forbids.
 */

/** Rows from a labeled response body, so nothing downstream reads them as DOM. */
export const API_SOURCE = "voyager" as const;

export type ApiSourced<T> = { source: typeof API_SOURCE; value: T };

export type ReactionsWarningCode = "REACTIONS_BODY_UNRECOGNIZED" | "REACTIONS_FOREIGN_POST";

export type ReactionsWarning = { code: ReactionsWarningCode; n: number; field: string };

export type ApiReaction = {
  /** The identifier, not a name. This is the whole reason the body wins. */
  actor_urn: string;
  actor_name: string | null;
  actor_url: string | null;
  reaction: string | null;
};

export type ReactionsBodyResult = {
  rows: ApiSourced<ApiReaction>[];
  /** `paging.total` — what LinkedIn says, not what a label rendered. */
  total: number | null;
  warnings: ReactionsWarning[];
};

const REACTION_TYPE = /social\.Reaction$/;
const ACTIVITY_IN_ENTITY_URN = /urn:li:activity:\d+/;

type Unknown = Record<string, unknown>;

function asRecord(v: unknown): Unknown | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Unknown) : null;
}

function textOf(v: unknown): string | null {
  const rec = asRecord(v);
  const text = rec?.["text"];
  return typeof text === "string" && text.trim() !== "" ? text.trim() : null;
}

/**
 * Parse, or refuse. Every row is scoped to the requested post by the activity
 * urn inside its own `entityUrn`, which is an identity test and not a position
 * in the response — a body fetched for a neighbouring post cannot contribute a
 * single row, and the count of what was dropped is reported rather than hidden.
 */
export function parseReactionsBody(
  raw: string,
  options: { expectedUrn: string; limit: number },
): ReactionsBodyResult {
  const warnings: ReactionsWarning[] = [];
  const unrecognized = (why: string): ReactionsBodyResult => ({
    rows: [],
    total: null,
    warnings: [...warnings, { code: "REACTIONS_BODY_UNRECOGNIZED", n: 1, field: why }],
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unrecognized("the captured reactions body is not JSON");
  }

  const root = asRecord(parsed);
  const collection = asRecord(asRecord(asRecord(root?.["data"])?.["data"])?.["socialDashReactionsByReactionType"]);
  const included = root?.["included"];
  if (collection === null || !Array.isArray(included)) {
    return unrecognized("no socialDashReactionsByReactionType collection with an included array");
  }

  const totalRaw = asRecord(collection["paging"])?.["total"];
  const total = typeof totalRaw === "number" && Number.isFinite(totalRaw) ? totalRaw : null;

  const rows: ApiSourced<ApiReaction>[] = [];
  let foreign = 0;
  const wanted = Math.max(0, options.limit);
  for (const entry of included) {
    const row = asRecord(entry);
    if (row === null || typeof row["$type"] !== "string" || !REACTION_TYPE.test(row["$type"])) continue;

    // Scope: the reaction names the post it belongs to inside its own urn.
    const entityUrn = typeof row["entityUrn"] === "string" ? row["entityUrn"] : "";
    const belongsTo = ACTIVITY_IN_ENTITY_URN.exec(entityUrn)?.[0] ?? null;
    if (belongsTo !== options.expectedUrn) {
      foreign += 1;
      continue;
    }
    if (rows.length >= wanted) continue;

    const actorUrn = typeof row["actorUrn"] === "string" ? row["actorUrn"] : null;
    if (actorUrn === null) continue;
    const lockup = asRecord(row["reactorLockup"]);
    const navigationUrl = lockup === null ? null : lockup["navigationUrl"];
    rows.push({
      source: API_SOURCE,
      value: {
        actor_urn: actorUrn,
        actor_name: lockup === null ? null : textOf(lockup["title"]),
        actor_url: typeof navigationUrl === "string" ? navigationUrl.split("?")[0]! : null,
        reaction: typeof row["reactionType"] === "string" ? row["reactionType"] : null,
      },
    });
  }

  if (foreign > 0) {
    warnings.push({
      code: "REACTIONS_FOREIGN_POST",
      n: foreign,
      field: `${foreign} reaction rows name a post other than ${options.expectedUrn} and were dropped rather than attributed`,
    });
  }

  return { rows, total, warnings };
}
