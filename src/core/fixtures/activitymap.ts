import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { cssPath, resolveSubjectScope, type SubjectScope } from "./dommap.js";
import { timeShapeOf, type TimeShape } from "./timeshape.js";

/**
 * What a **person-activity or post-permalink DOM snapshot** actually contains.
 *
 * `dommap.ts` is the profile page's map and it is written against that page's
 * card-ref namespace. This is the activity family's counterpart, and it is
 * deliberately a *different kind of instrument*: it assumes nothing about
 * LinkedIn's markup on this surface, because nothing about this surface has
 * been measured yet. Every rule below is shape-based —
 *
 * - an attribute whose value contains a `urn:li:` is a candidate post-card
 *   marker, whatever the attribute happens to be called;
 * - a leaf whose text reads as a time is a candidate `posted_at`;
 * - the nearest ancestor carrying a urn attribute is what binds the two.
 *
 * So the report says what is there rather than confirming what someone
 * expected. That is the whole difference between a probe and a parser (D152),
 * and it is why no part of this file may be lifted into Tasks 27-29 unchanged:
 * they must be written against what this measured, not against this.
 *
 * Pure and offline. The input is html, the output is data.
 */

/** Bounds. An activity page is on the order of a megabyte of DOM and this is a
 *  development aid; each is exceeded by a test rather than assumed roomy. */
export const MAX_URN_ATTRIBUTES = 40;
export const MAX_TIME_LEAVES = 60;
export const MAX_SAMPLE_CHARS = 120;
/** Elements walked before the map declares itself a prefix of the page. */
export const MAX_ELEMENTS = 200_000;
/**
 * Distinct urns retained per family, for the families tally. It is only ever
 * read as a count, but the set that produces it is the one structure here that
 * would otherwise grow with the page — and the page is a megabyte we do not
 * control.
 */
export const MAX_URNS_PER_FAMILY = 2_000;

/** A urn family, without the id. `urn:li:activity:123` gives `urn:li:activity`. */
export function urnFamilyOf(urn: string): string {
  return urn.slice(0, urn.lastIndexOf(":"));
}

const URN_IN_VALUE = /urn:li:[A-Za-z_]+:[A-Za-z0-9_%:.,()-]+/g;

/** One attribute that carries a urn - a candidate card marker. */
export type UrnAttributeHit = {
  /** The attribute's name, e.g. `data-urn`, `componentkey`, `id`. */
  attribute: string;
  /** The urn family only. Never the id: receipts and committed maps must not
   *  carry a prospect's identity (spec 4.1, D3). */
  family: string;
  /** How many elements carried this attribute/family pair. */
  count: number;
  /** How many of those urns were the session's own - the D119 trap, counted. */
  sessionHits: number;
  /** The tag of the first element that carried it. */
  tag: string;
  /** A concrete path to that first element, for checking by hand. */
  path: string;
};

/** One leaf whose text reads as a time. */
export type TimeLeafHit = {
  shape: TimeShape;
  /** A concrete path to the leaf. */
  path: string;
  /** The text itself. A relative time (`3d`) is not personal data, and an
   *  absolute one is a fact about a post rather than about a person; both are
   *  what makes this map checkable by hand. */
  sample: string;
  /** The `attribute=urn-family` of the nearest ancestor carrying a urn, or
   *  `null` when nothing above it does - which would mean the rendered time
   *  cannot be bound to a post at all. */
  boundTo: string | null;
};

export type ActivityDomMap = {
  /**
   * Whether the profile page's card-ref namespace (D127) exists on this
   * surface too. A measurement, not an expectation: if it does, identity here
   * is a problem already solved; if it does not, Tasks 27-29 need a different
   * rule and must be told so.
   */
  scope: SubjectScope;
  /** Candidate post-card markers, most frequent first. */
  urnAttributes: UrnAttributeHit[];
  /** Candidate rendered timestamps. */
  timeLeaves: TimeLeafHit[];
  /** Distinct urn families anywhere in the html, with counts. */
  families: Array<{ family: string; distinct: number }>;
  /** How many distinct session-owned urns appear anywhere in the page. */
  sessionUrnsPresent: number;
  elementsWalked: number;
  truncated: {
    elements: boolean;
    urnAttributes: boolean;
    timeLeaves: boolean;
    /** Families whose distinct set hit `MAX_URNS_PER_FAMILY`; their `distinct`
     *  is a floor, not a count. */
    families: string[];
  };
};

function sample(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SAMPLE_CHARS ? `${flat.slice(0, MAX_SAMPLE_CHARS)}...` : flat;
}

/** The nearest ancestor (or the element itself) carrying a urn-valued
 *  attribute, rendered as `attribute=urn:li:family`. */
function bindingOf(el: Element): string | null {
  let cur: AnyNode | null = el;
  while (cur !== null && (cur as Element).tagName !== undefined) {
    const node = cur as Element;
    for (const [name, value] of Object.entries(node.attribs ?? {})) {
      const found = value.match(URN_IN_VALUE);
      if (found !== null && found.length > 0) return `${name}=${urnFamilyOf(found[0]!)}`;
    }
    cur = node.parent as Element | null;
  }
  return null;
}

/**
 * Builds the activity-surface map for one snapshot.
 *
 * `sessionUrns` is always the output of `sessionUrnsOf` - this function never
 * re-derives who the operator is, it only counts how often they appear. A page
 * where the operator is the only resolvable person is the trap D119, D121 and
 * D126 each found in a different place, and it has to be visible here rather
 * than discovered by a parser three tasks later.
 */
export function buildActivityDomMap(
  html: string,
  o: { sessionUrns?: readonly string[] } = {},
): ActivityDomMap {
  const $ = cheerio.load(html);
  const sessionUrns = new Set((o.sessionUrns ?? []).filter((u) => u !== ""));
  const scope = resolveSubjectScope($);

  const byKey = new Map<string, UrnAttributeHit>();
  const timeLeaves: TimeLeafHit[] = [];
  const families = new Map<string, Set<string>>();
  const sessionSeen = new Set<string>();

  let elementsWalked = 0;
  let elementsTruncated = false;
  let urnAttributesTruncated = false;
  let timeLeavesTruncated = false;
  const familiesTruncated = new Set<string>();

  const noteUrn = (urn: string): string => {
    const family = urnFamilyOf(urn);
    let set = families.get(family);
    if (set === undefined) {
      set = new Set<string>();
      families.set(family, set);
    }
    if (set.size < MAX_URNS_PER_FAMILY) set.add(urn);
    else if (!set.has(urn)) familiesTruncated.add(family);
    if (sessionUrns.has(urn)) sessionSeen.add(urn);
    return family;
  };

  $("*").each((_, node) => {
    if (elementsWalked >= MAX_ELEMENTS) {
      elementsTruncated = true;
      return false;
    }
    elementsWalked++;
    const el = node as Element;

    for (const [name, value] of Object.entries(el.attribs ?? {})) {
      for (const urn of value.match(URN_IN_VALUE) ?? []) {
        const family = noteUrn(urn);
        const key = `${name} ${family}`;
        const existing = byKey.get(key);
        if (existing !== undefined) {
          existing.count++;
          if (sessionUrns.has(urn)) existing.sessionHits++;
          continue;
        }
        if (byKey.size >= MAX_URN_ATTRIBUTES) {
          urnAttributesTruncated = true;
          continue;
        }
        byKey.set(key, {
          attribute: name,
          family,
          count: 1,
          sessionHits: sessionUrns.has(urn) ? 1 : 0,
          tag: el.tagName,
          path: cssPath($, el),
        });
      }
    }

    // Leaves only: an ancestor's text is its children's text concatenated, and
    // reporting both would report one rendered time several times over.
    if ($(el).children().length > 0) return undefined;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text === "") return undefined;
    const shape = timeShapeOf(text);
    if (shape === null) return undefined;
    if (timeLeaves.length >= MAX_TIME_LEAVES) {
      timeLeavesTruncated = true;
      return undefined;
    }
    timeLeaves.push({ shape, path: cssPath($, el), sample: sample(text), boundTo: bindingOf(el) });
    return undefined;
  });

  // Text nodes carry urns too - a script tag holding embedded JSON is the usual
  // case - and a family present only there is still a finding about the page.
  for (const urn of html.match(URN_IN_VALUE) ?? []) noteUrn(urn);

  return {
    scope,
    urnAttributes: [...byKey.values()].sort((a, b) => b.count - a.count),
    timeLeaves,
    families: [...families.entries()]
      .map(([family, set]) => ({ family, distinct: set.size }))
      .sort((a, b) => b.distinct - a.distinct),
    sessionUrnsPresent: sessionSeen.size,
    elementsWalked,
    truncated: {
      elements: elementsTruncated,
      urnAttributes: urnAttributesTruncated,
      timeLeaves: timeLeavesTruncated,
      families: [...familiesTruncated],
    },
  };
}

/** How many of the map's time leaves carry an absolute time. Zero is the
 *  finding that forces the `posted_at` decision, so it is computed once here
 *  rather than re-derived by every reader. */
export function absoluteTimeLeaves(map: ActivityDomMap): number {
  return map.timeLeaves.filter((l) => l.shape !== "relative").length;
}

/** The activity DOM map, as the markdown section Tasks 27-29 are written
 *  against. Rendered beside the JSON field map, in the same document. */
export function renderActivityDomMap(o: {
  file: string;
  bytes: number;
  sourceRun: string;
  map: ActivityDomMap;
}): string {
  const { map } = o;
  const lines: string[] = [];

  lines.push(`## \`${o.file}\` - rendered DOM snapshot (activity surface)`);
  lines.push("");
  lines.push(`- ${o.bytes} bytes of \`outerHTML\`, captured by run \`${o.sourceRun}\``);
  lines.push("- **This is a measurement, not a parser contract.** Nothing below is a field");
  lines.push("  LinkedIn promises; it is what this one snapshot contained.");
  lines.push("");

  lines.push("### Subject scope (profile card-ref namespace, D127)");
  lines.push("");
  if (map.scope.profileId === null) {
    lines.push("**No profile card-ref namespace on this page.** The identity rule that works on");
    lines.push("`/in/<vanity>` does not carry over - author identity here needs its own rule, and");
    lines.push("`[DECISION NEEDED]` applies before any parser is written.");
  } else {
    lines.push(`- resolved, ${map.scope.cards.length} cards - the profile rule may carry over`);
  }
  lines.push("");
  lines.push(`- distinct session-owned urns present on this page: **${map.sessionUrnsPresent}**`);
  lines.push("");

  lines.push("### Urn-carrying attributes - candidate post-card markers");
  lines.push("");
  if (map.urnAttributes.length === 0) {
    lines.push("**None.** No element attribute on this page carries a `urn:li:` value, so a post");
    lines.push("card cannot be bound to a post urn through the DOM at all.");
  } else {
    lines.push("| attribute | urn family | elements | session-owned | tag | first path |");
    lines.push("|---|---|---|---|---|---|");
    for (const hit of map.urnAttributes) {
      const trap = hit.sessionHits > 0 ? `**${hit.sessionHits}**` : "0";
      lines.push(
        `| \`${hit.attribute}\` | \`${hit.family}\` | ${hit.count} | ${trap} | ${hit.tag} | \`${hit.path}\` |`,
      );
    }
    if (map.truncated.urnAttributes) {
      lines.push("");
      lines.push(`_more than ${MAX_URN_ATTRIBUTES} attribute/family pairs; the rest are not listed._`);
    }
  }
  lines.push("");

  lines.push("### Rendered times - candidate `posted_at`");
  lines.push("");
  if (map.timeLeaves.length === 0) {
    lines.push("**None.** No leaf on this page reads as a time.");
  } else {
    const absolute = absoluteTimeLeaves(map);
    lines.push(
      `${map.timeLeaves.length} leaves, of which **${absolute} carry an absolute time**. ` +
        (absolute === 0
          ? "Only relative times are rendered, so `posted_at` cannot be read from the DOM - " +
            "read the JSON sections before deciding how it is populated."
          : "An absolute time is rendered, so `posted_at` need not be derived."),
    );
    lines.push("");
    lines.push("| shape | text | bound to | path |");
    lines.push("|---|---|---|---|");
    for (const leaf of map.timeLeaves) {
      const bound = leaf.boundTo === null ? "_nothing_" : `\`${leaf.boundTo}\``;
      lines.push(`| ${leaf.shape} | \`${leaf.sample}\` | ${bound} | \`${leaf.path}\` |`);
    }
    if (map.truncated.timeLeaves) {
      lines.push("");
      lines.push(`_more than ${MAX_TIME_LEAVES} time-shaped leaves; the rest are not listed._`);
    }
  }
  lines.push("");

  lines.push("### Urn families anywhere in the page");
  lines.push("");
  lines.push("| family | distinct |");
  lines.push("|---|---|");
  for (const f of map.families) {
    const capped = map.truncated.families.includes(f.family) ? " (at least)" : "";
    lines.push(`| \`${f.family}\` | ${f.distinct}${capped} |`);
  }
  lines.push("");
  if (map.truncated.elements) {
    lines.push(`_the walk stopped at ${MAX_ELEMENTS} elements; this map describes a prefix of the page._`);
    lines.push("");
  }

  return lines.join("\n") + "\n";
}
