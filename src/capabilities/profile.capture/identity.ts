import * as cheerio from "cheerio";
import { personUrnsIn } from "../../core/fixtures/promote.js";
import {
  STRANGER_CARDS,
  resolveSubjectScope,
  type SubjectScope,
} from "../../core/fixtures/dommap.js";

/**
 * The subject's identity for one capture.
 *
 * **`checkDomIdentity` is the one that matters (D130).** The urn that keying,
 * freshness and dedupe run on comes from the SDUI card-ref namespace in the DOM
 * snapshot — the id every one of the subject's own profile cards agrees on.
 *
 * `checkIdentity` is the Voyager half, kept as a *measurement* and no longer a
 * source. D123 originally put identity on `voyagerIdentityDashProfiles`; D126
 * measured that endpoint taking the operator's own urn as its request input and
 * returning that member, so it is the session resolving itself on every page and
 * could never have answered for a prospect. It still runs because a change in
 * that answer would be worth knowing about — but it is reported as a field, not
 * as a warning, precisely because its answer is the same on every single run and
 * a warning that always fires is one nobody reads.
 */

/** The GraphQL container D121 measured. Matched by key, anywhere in the body,
 *  because LinkedIn's envelope depth is not something to hardcode. */
const IDENTITY_CONTAINER_KEY = "identityDashProfilesByMemberIdentity";

/** Both spellings of the element list. LinkedIn's GraphQL emits `*elements` for
 *  a list of urn references and `elements` for inlined records. */
const ELEMENT_KEYS = ["*elements", "elements"] as const;

/** A person urn, in the forms §7 keys on. */
const PERSON_URN = /^urn:li:(fsd_profile|fs_profile|fs_salesProfile|member):[A-Za-z0-9_-]+$/;

/** Bounds the walk. The identity body measured 1,335 bytes (D116); anything
 *  needing more nodes than this is not the body this is looking for. */
export const IDENTITY_MAX_NODES = 20_000;

export type SubjectUrnHit = {
  urn: string;
  /** A concrete path into the parsed body, for the field map and for a parser
   *  author to check by hand. */
  path: string;
};

/**
 * Finds the subject's urn in an identity body, or returns `null`.
 *
 * Pure and total: a body that is not JSON, not this endpoint, or shaped
 * differently returns `null` rather than throwing. The caller turns `null` into
 * a visible warning — the one thing that must not happen is a run reporting ok
 * with no identity and no mention of it.
 */
export function findSubjectUrn(body: string): SubjectUrnHit | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }

  const stack: Array<{ value: unknown; key: string | null; path: string }> = [
    { value: root, key: null, path: "$" },
  ];
  const seen = new WeakSet<object>();
  let walked = 0;

  while (stack.length > 0 && walked < IDENTITY_MAX_NODES) {
    const node = stack.pop()!;
    walked++;
    const value = node.value;
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);

    if (node.key === IDENTITY_CONTAINER_KEY && !Array.isArray(value)) {
      const hit = firstUrnIn(value as Record<string, unknown>, node.path);
      if (hit !== null) return hit;
    }

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ value: value[i], key: node.key, path: `${node.path}[${i}]` });
      }
    } else {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        stack.push({ value: v, key: k, path: `${node.path}${pathStep(k)}` });
      }
    }
  }
  return null;
}

/** `.foo` when the key is a plain identifier, `["*elements"]` otherwise — so
 *  every path this emits is one that can be pasted into a parser. */
function pathStep(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** The first element of the container's element list, as a urn. Accepts either
 *  a bare urn string or a record carrying `entityUrn`. */
function firstUrnIn(container: Record<string, unknown>, path: string): SubjectUrnHit | null {
  for (const key of ELEMENT_KEYS) {
    const list = container[key];
    if (!Array.isArray(list) || list.length === 0) continue;
    const head = list[0];
    const at = `${path}${pathStep(key)}[0]`;

    if (typeof head === "string" && PERSON_URN.test(head)) return { urn: head, path: at };
    if (head !== null && typeof head === "object") {
      const entityUrn = (head as Record<string, unknown>)["entityUrn"];
      if (typeof entityUrn === "string" && PERSON_URN.test(entityUrn)) {
        return { urn: entityUrn, path: `${at}.entityUrn` };
      }
    }
  }
  return null;
}

/** One captured body, as much of it as this needs. */
export type IdentityCapture = { url: string; body: string; patterns?: readonly string[] };

/** True for the Voyager call that resolves a vanity slug to a profile urn. */
export function isIdentityBody(capture: IdentityCapture): boolean {
  return capture.url.includes("voyagerIdentityDashProfiles");
}

/** True for the session's own account record. Its urns are the operator's, and
 *  a subject urn equal to one of them is D119's trap. */
export function isSessionBody(capture: IdentityCapture): boolean {
  return /\/voyager\/api\/me\b/.test(capture.url);
}

/**
 * The `$type` that labels the session's own account record, in the API body and
 * in the document island alike. It is what makes this a labeled read rather than
 * a guess about which urn on the page is the viewer's.
 */
const SESSION_ISLAND_TYPE = "com.linkedin.voyager.common.Me";

/**
 * The session's own record as LinkedIn server-renders it into the page.
 *
 * `/voyager/api/me` is not fetched on every surface. Measured on 2026-08-10: the
 * profile page fetches it, and `/in/<vanity>/recent-activity/all/` does not — so
 * `profile.posts` and `profile.activity` ran with an empty session set and stored
 * rows with the D119 guard inert, which is the one check standing between a
 * prospect's row and the operator's own identity.
 *
 * The same payload is on those pages anyway, as a Big Pipe island in the initial
 * document, which D117 admits as a captured body. This reads that one island and
 * takes urns only from inside it — never from the document at large, where the
 * *subject's* urns also live and would poison the comparison set into flagging
 * every real subject as the operator (D322).
 */
export function sessionIdentityInDocument(body: string): { urns: string[]; vanities: string[] } {
  // Cheap gate first: this runs over every captured body, and loading a 1MB
  // document into cheerio to find nothing is not worth doing on any of them.
  if (!body.includes(SESSION_ISLAND_TYPE)) return { urns: [], vanities: [] };

  const urns = new Set<string>();
  const vanities = new Set<string>();
  const $ = cheerio.load(body);
  $('code[id^="bpr-guid-"]').each((_, node) => {
    const raw = $(node).text();
    if (!raw.includes(SESSION_ISLAND_TYPE)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // An island that does not parse is not structured data. Skipped rather
      // than salvaged: a regex over half-decoded text is how a stranger's urn
      // ends up in the operator's set.
      return;
    }
    const island = JSON.stringify(parsed);
    // Belt and braces: the island has to *say* it is the Me record, not merely
    // sit near one. A page could carry another island that mentions the type.
    if (!island.includes(`"${SESSION_ISLAND_TYPE}"`)) return;
    for (const urn of personUrnsIn(island)) urns.add(urn);
    for (const m of island.matchAll(/"publicIdentifier"\s*:\s*"([^"]+)"/g)) vanities.add(m[1]!);
  });
  return { urns: [...urns], vanities: [...vanities] };
}

export type IdentityFinding = {
  /** How many `voyagerIdentityDashProfiles` bodies the run captured. */
  bodies: number;
  /** Whether a subject urn was found in one of them. */
  found: boolean;
  /** Where it was found. Never the urn itself — that is captured data, and
   *  receipts go to stdout (§4.1, D3). The body is on disk to read. */
  path: string | null;
  /** The urn kind only, e.g. `urn:li:fsd_profile`. Enough to see it is a person
   *  urn of the right family without printing whose. */
  urnKind: string | null;
  /** True when the urn found is the *session's* own, not the subject's. A run
   *  in this state has keyed the capture to the operator's own account (D119). */
  isSession: boolean;
  /** How many of the session's own person urns the run saw, from `/voyager/api/me`. */
  sessionUrns: number;
};

/** What the DOM snapshot says about who this capture is of. */
export type DomIdentityFinding = {
  /** Whether a profile id resolved. `false` means the capture cannot be keyed
   *  and nothing may be stored from it — never a guess (D130). */
  resolved: boolean;
  /** The urn family only, e.g. `urn:li:fsd_profile`. Never the id itself: that
   *  is the prospect's identity and receipts go to stdout (§4.1, D3). */
  urnKind: string | null;
  /** Whether the page's own card refs also carried the vanity slug. */
  vanityKnown: boolean;
  /** How many of the subject's cards agreed on the id. One card cannot confirm
   *  an id boundary; twenty-three can. */
  cards: number;
  /** Cards holding other people (`SuggestedForYou`), namespaced under the
   *  subject's own id and therefore not excluded by id-scoping alone (D127). */
  strangerCards: number;
  /** Card names this build has not seen. A couple is LinkedIn shipping a new
   *  card; many means the id boundary moved and the urn must not be trusted. */
  unrecognisedCards: string[];
  /** Member urns on the top card's own action buttons — the subject again, in
   *  LinkedIn's other spelling. A cross-check, not a second source. */
  memberUrns: number;
  /** True when the id resolved to the *operator's* own account. Must never
   *  happen; reported rather than trusted, because D119, D121 and D126 were all
   *  this same trap in three different places. */
  isSession: boolean;
};

const NO_DOM_IDENTITY: DomIdentityFinding = {
  resolved: false, urnKind: null, vanityKnown: false, cards: 0, strangerCards: 0,
  unrecognisedCards: [], memberUrns: 0, isSession: false,
};

/**
 * Resolves the subject's identity from the snapshot, the way D130 specifies.
 *
 * Total by construction: unparseable html, an empty snapshot, or a page whose
 * card refs do not agree all return `resolved: false`. The caller warns. The one
 * outcome ruled out is a confident wrong answer — `resolveSubjectScope` takes the
 * id as the namespace the cards *share* and requires cards to confirm it, so a
 * page carrying no cards, two subjects, or a single card with a name this build
 * does not know resolves nothing rather than somebody who does not exist.
 */
export function checkDomIdentity(
  html: string | null,
  o: { sessionUrns?: readonly string[] } = {},
): DomIdentityFinding {
  if (html === null || html === "") return NO_DOM_IDENTITY;

  let scope: ReturnType<typeof resolveSubjectScope>;
  try {
    scope = resolveSubjectScope(cheerio.load(html));
  } catch {
    // The page load is already spent and the snapshot is already on disk; a
    // parse failure here must degrade the receipt, never discard the capture.
    return NO_DOM_IDENTITY;
  }

  return checkDomIdentityScope(scope, o);
}

/** Applies D130's trust rule to an already-resolved scope. The parser uses this
 * entry point so the load-bearing rule has one implementation and the 875KB
 * snapshot is parsed only once; the capture receipt wrapper above preserves its
 * total string-in/string-out interface. */
export function checkDomIdentityScope(
  scope: SubjectScope,
  o: { sessionUrns?: readonly string[] } = {},
): DomIdentityFinding {
  const session = new Set(o.sessionUrns ?? []);
  const strangers = new Set<string>(STRANGER_CARDS);
  const profileUrn = scope.profileUrn;
  const subjectCards = scope.cards.filter((c) => !strangers.has(c.name));
  // An id is only usable when at least one card can describe the subject, and
  // when the inferred card-name boundary leaves a majority of recognizable
  // names. SuggestedForYou alone carries the subject namespace but only other
  // people's content; a majority of shifted/unknown names is D127's signal that
  // the common-prefix cut may be wrong.
  const trustworthy =
    profileUrn !== null &&
    subjectCards.length > 0 &&
    scope.unrecognisedCards.length <= scope.cards.length / 2;

  return {
    resolved: trustworthy,
    urnKind: !trustworthy || profileUrn === null
      ? null
      : profileUrn.slice(0, profileUrn.lastIndexOf(":")),
    vanityKnown: scope.vanity !== null,
    cards: scope.cards.length,
    strangerCards: scope.cards.filter((c) => strangers.has(c.name)).length,
    unrecognisedCards: scope.unrecognisedCards,
    memberUrns: scope.memberUrns.length,
    isSession:
      (profileUrn !== null && session.has(profileUrn)) ||
      scope.memberUrns.some((u) => session.has(u)),
  };
}

/** The session's own person urns, from the `/voyager/api/me` body the page
 *  fetched on its own. The comparison set for every `isSession` check. */
export function sessionUrnsOf(captures: readonly IdentityCapture[]): string[] {
  const found = new Set<string>();
  for (const capture of captures) {
    if (isSessionBody(capture)) for (const urn of personUrnsIn(capture.body)) found.add(urn);
    // And the same record where the page server-rendered it instead of fetching
    // it, which is the only place the activity surface has it (D322).
    else for (const urn of sessionIdentityInDocument(capture.body).urns) found.add(urn);
  }
  return [...found];
}

/**
 * The session's own **public identifiers** (vanity slugs), from the same
 * `/voyager/api/me` body.
 *
 * The urn set above is the comparison set wherever identity is an urn. On a
 * DOM surface it is not: `post.get` (D313) has only profile *links* to work
 * with, and the post page renders the operator's own profile in its left rail.
 * Without this, the operator is indistinguishable from the post's author — the
 * D119 trap in its DOM spelling.
 */
export function sessionVanitiesOf(captures: readonly IdentityCapture[]): string[] {
  const found = new Set<string>();
  for (const capture of captures) {
    if (isSessionBody(capture)) {
      for (const m of capture.body.matchAll(/"publicIdentifier"\s*:\s*"([^"]+)"/g)) found.add(m[1]!);
    } else {
      for (const vanity of sessionIdentityInDocument(capture.body).vanities) found.add(vanity);
    }
  }
  return [...found];
}

/**
 * The identity outcome for one run: did the Voyager body arrive, did it carry a
 * subject urn, and is that urn actually the subject's rather than the
 * operator's?
 *
 * The last question is the point. D119 found a field map offering the
 * operator's own member id as `person_urn`, and D121 found the same trap again
 * in the document's A/B tracking. A parser written against either scores green
 * offline and returns the operator's own account for every prospect. So the
 * session's own urns are read from the `/voyager/api/me` body the page fetched
 * anyway, and a match is reported rather than quietly accepted.
 */
export function checkIdentity(
  captures: readonly IdentityCapture[],
  o: { sessionUrns?: readonly string[] } = {},
): IdentityFinding {
  const sessionUrns = new Set(o.sessionUrns ?? sessionUrnsOf(captures));

  const bodies = captures.filter(isIdentityBody);
  let hit: SubjectUrnHit | null = null;
  for (const body of bodies) {
    hit = findSubjectUrn(body.body);
    if (hit !== null) break;
  }

  return {
    bodies: bodies.length,
    found: hit !== null,
    path: hit?.path ?? null,
    urnKind: hit === null ? null : hit.urn.slice(0, hit.urn.lastIndexOf(":")),
    isSession: hit !== null && sessionUrns.has(hit.urn),
    sessionUrns: sessionUrns.size,
  };
}
