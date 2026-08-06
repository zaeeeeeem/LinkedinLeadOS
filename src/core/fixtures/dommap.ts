import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

/**
 * Where things actually live in a captured **DOM snapshot**.
 *
 * The JSON field map (`fieldmap.ts`) walks a parsed body and reports paths by
 * key name. A rendered page has no key names, so this is its counterpart: it
 * resolves the subject's scope, then reports concrete CSS paths to the fields a
 * parser needs, each labelled with *how* it was identified — because on this
 * page the two differ enormously in how long they will keep working.
 *
 * Written against the live snapshot taken 2026-08-09 (run 01KZJ5N27B…,
 * `/in/tankots/`, 874,761 chars). Every rule below is one that page actually
 * exhibits; none of it is guessed. See D130.
 *
 * ## What that snapshot showed
 *
 * LinkedIn's profile page is server-driven UI. Class names are content-hashed
 * (`_3bbeb416`) and will churn on every deploy, so nothing here reads one. But
 * each profile card carries a `componentkey` of the form
 *
 *     com.linkedin.sdui.profile.card.ref<PROFILE_ID><CardName>
 *
 * — `Topcard`, `About`, `ExperienceTopLevelSection`, `EducationTopLevelSection`,
 * `Skills`, and twenty more, all namespaced by **one** profile id. That id is
 * the subject's, and it is what makes the DOM tractable where D121's flight tree
 * was not: the subject's cards are named, and a "people also viewed" stranger
 * sits in the `SuggestedForYou` card and the sidebar `aside`, under the same id
 * but a different card name.
 *
 * Inside a card, addressing goes back to being positional. That split — cards
 * semantic, fields within a card positional — is the honest drift picture, and
 * every hit below carries the `basis` it was found by so a parser author sees
 * which fields are cheap to lose.
 */

/** The prefix every subject profile card's `componentkey` starts with. */
export const CARD_REF_PREFIX = "com.linkedin.sdui.profile.card.ref";

/** LinkedIn's opaque profile id, as it appears inside a card ref. */
const PROFILE_ID = /^AC[A-Za-z0-9_-]{10,}$/;

/**
 * Cards that hold *other people*, not the subject. Excluded from every content
 * probe: `SuggestedForYou` is "people also viewed", and it is namespaced by the
 * subject's own id, so id-scoping alone does not exclude it (measured — the
 * live snapshot's `aside` sits inside `main#workspace` and inside this card).
 */
export const STRANGER_CARDS = ["SuggestedForYou"] as const;

/**
 * The card names the live snapshot carried, longest first.
 *
 * Used only to peel a card name off a resolved id. The id is normally the
 * longest common prefix of every card ref, but when a snapshot rendered just
 * **one** card that prefix is the id *plus that card's name* — and the wrong
 * answer there is not "no id", it is a confident `urn:li:fsd_profile:<id>Topcard`
 * that a parser would key a person on. The list does not need to be exhaustive:
 * an unlisted card name only costs the single-card case, which then reports no
 * id rather than a wrong one.
 */
export const KNOWN_CARDS: readonly string[] = [
  "VolunteerExperienceTopLevel", "PublicationTopLevelSection", "SalesInsightsOrHighlights",
  "ExperienceTopLevelSection", "EducationTopLevelSection", "ConnectedAccountsTopLevel",
  "RecommendationsTopLevel", "CertificationTopLevel", "CourseTopLevelSection",
  "TestScoresTopLevel", "SupportedLocales", "SuggestedForYou", "LanguageTopLevel",
  "Organizations", "HonorsTopLevel", "Projects", "Services", "Featured", "Patents",
  "Topcard", "Skills", "Causes", "About",
].slice().sort((a, b) => b.length - a.length);

/** How a hit was located, and therefore how it will fail. */
export type HitBasis =
  /** A `componentkey` naming the card. Survives a restyle. */
  | "componentkey"
  /** Element order within a card. Breaks when the card is re-laid-out. */
  | "position"
  /** The value's own shape. Breaks when the value's format changes. */
  | "text-shape"
  /** An href or attribute value. */
  | "attribute";

export type DomHit = {
  /** A concrete, copy-pasteable CSS path from the document root. */
  path: string;
  /** A truncated rendering of what was found there. */
  sample: string;
  basis: HitBasis;
  /** False when the hit is outside the subject's scope — a stranger's row. */
  inSubjectScope: boolean;
};

export type DomProbeReport = {
  name: string;
  what: string;
  hits: DomHit[];
  /** Set when nothing matched, saying what was looked for. */
  miss?: string;
};

/** One profile card found in the snapshot. */
export type CardRef = {
  /** `Topcard`, `ExperienceTopLevelSection`, … */
  name: string;
  /** The full `componentkey` value. */
  key: string;
  /** A selector that resolves to it. */
  selector: string;
  tag: string;
  textChars: number;
  /** True for a card that holds other people (`SuggestedForYou`). */
  stranger: boolean;
};

export type SubjectScope = {
  /** The profile id every subject card is namespaced by, or `null`. */
  profileId: string | null;
  /** The urn §7 keys on, built from `profileId`. */
  profileUrn: string | null;
  /** Member urns found on the top card's action buttons — the subject's, in
   *  LinkedIn's other identity spelling. */
  memberUrns: string[];
  /** The vanity slug the page's own card refs use. */
  vanity: string | null;
  cards: CardRef[];
  /**
   * Card names that are not ones this build has seen.
   *
   * This is the check on the id boundary. The id is cut at the point every card
   * ref stops agreeing, so if that cut is in the wrong place the names come out
   * shifted — `ATopcard`, `ZAbout` — and the id is wrong by the same characters.
   * A couple of unknown names is LinkedIn shipping a new card; most of them
   * unknown means the boundary moved and the urn must not be trusted.
   */
  unrecognisedCards: string[];
};

export type DomFieldMap = {
  scope: SubjectScope;
  probes: DomProbeReport[];
  /** Total elements walked, so a truncated map is visible. */
  nodesWalked: number;
};

/** Bounds. A profile snapshot is ~875,000 chars; a field map is a development
 *  aid and must never be what runs a machine out of memory. Exceeded by a test. */
export const MAX_HITS_PER_PROBE = 12;
export const MAX_SAMPLE_CHARS = 120;
/** Leaf text nodes inventoried per card. The live Topcard had 20. */
export const MAX_LEAVES_PER_CARD = 40;

function sample(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SAMPLE_CHARS ? `${flat.slice(0, MAX_SAMPLE_CHARS)}…` : flat;
}

/** The longest string every input starts with. */
function longestCommonPrefix(values: readonly string[]): string {
  if (values.length === 0) return "";
  let prefix = values[0]!;
  for (const v of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < v.length && prefix[i] === v[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix === "") break;
  }
  return prefix;
}

/** Strips a trailing card name from a resolved prefix. With several cards the
 *  prefix already ends at the id, because their names diverge at the first
 *  character; with one card it does not, and this is what stops that case from
 *  producing a urn ending in `Topcard`. */
function peelCardName(prefix: string): string {
  for (const name of KNOWN_CARDS) {
    if (prefix.length > name.length && prefix.endsWith(name)) return prefix.slice(0, -name.length);
  }
  return prefix;
}

/**
 * A CSS path from the document root to one element.
 *
 * Prefers a `componentkey` at every step it can, because that is the part of
 * this page that carries meaning; falls back to `id`, then to `nth-of-type`.
 * The result is pasteable into `querySelector` against the same snapshot, which
 * is what makes a field map checkable rather than a claim.
 */
export function cssPath($: cheerio.CheerioAPI, el: Element): string {
  const parts: string[] = [];
  let cur: AnyNode | null = el;

  while (cur !== null && (cur as Element).tagName !== undefined) {
    const node = cur as Element;
    if (node.tagName === "html") break;

    const key = node.attribs?.["componentkey"];
    const id = node.attribs?.["id"];
    let step: string = node.tagName;

    if (key !== undefined && key !== "" && !isOpaqueKey(key)) {
      step += `[componentkey="${cssEscapeQuotes(key)}"]`;
      parts.unshift(step);
      // A componentkey is unique enough to start the path from; anything above
      // it is noise a parser would only have to maintain.
      return parts.join(" > ");
    }
    if (id !== undefined && id !== "" && /^[A-Za-z][\w-]*$/.test(id)) {
      step += `#${id}`;
      parts.unshift(step);
      return parts.join(" > ");
    }

    const parent = node.parent as Element | null;
    if (parent?.children !== undefined) {
      const sameTag = parent.children.filter(
        (c): c is Element => (c as Element).tagName === node.tagName,
      );
      if (sameTag.length > 1) step += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(step);
    cur = parent;
  }
  return parts.join(" > ");
}

/** A UUID or other generated key carries no meaning and must not anchor a path. */
function isOpaqueKey(key: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key);
}

function cssEscapeQuotes(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Resolves whose profile this snapshot is, from the card refs themselves.
 *
 * The id is taken as the longest common prefix of every `AC…` card ref suffix.
 * With twenty-odd cards whose names diverge at the first character, that prefix
 * is exactly the profile id and nothing else — no id length is hardcoded, and a
 * page carrying two subjects shows up as a shorter prefix and a
 * `distinctProfileIds` above one rather than as a confident wrong answer.
 */
export function resolveSubjectScope($: cheerio.CheerioAPI): SubjectScope {
  const refs: Array<{ key: string; suffix: string; el: Element }> = [];
  const vanitySuffixes: string[] = [];

  $(`[componentkey^="${CARD_REF_PREFIX}"]`).each((_, node) => {
    const el = node as Element;
    const key = el.attribs?.["componentkey"] ?? "";
    const suffix = key.slice(CARD_REF_PREFIX.length);
    if (suffix.startsWith("AC")) refs.push({ key, suffix, el });
    else vanitySuffixes.push(suffix);
  });

  const suffixes = refs.map((r) => r.suffix);
  const prefix = peelCardName(longestCommonPrefix(suffixes));
  const profileId = PROFILE_ID.test(prefix) ? prefix : null;

  const seen = new Set<string>();
  const cards: CardRef[] = [];
  for (const ref of refs) {
    if (profileId === null || !ref.suffix.startsWith(profileId)) continue;
    const name = ref.suffix.slice(profileId.length);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    cards.push({
      name,
      key: ref.key,
      selector: `[componentkey="${cssEscapeQuotes(ref.key)}"]`,
      tag: ref.el.tagName,
      textChars: $(ref.el).text().replace(/\s+/g, " ").trim().length,
      stranger: (STRANGER_CARDS as readonly string[]).includes(name),
    });
  }

  // The subject's member urn, in LinkedIn's other identity spelling. It rides on
  // the top card's Connect/Follow buttons — `ConnectButtonstate:invitation:
  // urn:li:member:306907360_pending` on the live snapshot.
  //
  // Scoped to the Topcard, and that scoping is the whole point: every
  // "people also viewed" suggestion in the sidebar has its own Connect and
  // Follow button carrying its own member urn. Unscoped, this returned 17 urns
  // on the live snapshot, 16 of them strangers — D119's trap, reproduced by the
  // very function meant to expose it.
  const memberUrns = new Set<string>();
  const topcardKey = profileId === null ? null : `${CARD_REF_PREFIX}${profileId}Topcard`;
  if (topcardKey !== null) {
    $(`[componentkey="${cssEscapeQuotes(topcardKey)}"]`)
      .find("[componentkey^=ConnectButton], [componentkey^=FollowButton]")
      .each((_, node) => {
        const key = (node as Element).attribs?.["componentkey"] ?? "";
        for (const m of key.match(/urn:li:member:\d+/g) ?? []) memberUrns.add(m);
      });
  }

  // `com.linkedin.sdui.profile.card.ref<vanity>Activity` and
  // `ProfileVerificationTriggerRef-<vanity>` both carry the slug.
  let vanity: string | null = null;
  for (const s of vanitySuffixes) {
    const m = /^([A-Za-z0-9-]{3,100})Activity$/.exec(s);
    if (m) { vanity = m[1]!; break; }
  }
  if (vanity === null) {
    const trigger = $("[componentkey^='ProfileVerificationTriggerRef-']").first().attr("componentkey");
    const m = trigger === undefined ? null : /^ProfileVerificationTriggerRef-(.+)$/.exec(trigger);
    if (m) vanity = m[1]!;
  }

  return {
    profileId,
    profileUrn: profileId === null ? null : `urn:li:fsd_profile:${profileId}`,
    memberUrns: [...memberUrns],
    vanity,
    cards,
    unrecognisedCards: cards.filter((c) => !KNOWN_CARDS.includes(c.name)).map((c) => c.name),
  };
}

/** A degree badge (`· 1st`), which sits between the name and the headline and
 *  is not a field anyone wants. */
const DEGREE = /^·?\s*(1st|2nd|3rd)\s*$/i;

/** "San Francisco, California, United States" — commas, no `·` separator. The
 *  company/school line uses `·`, which is what tells the two apart. */
const LOCATION_SHAPE = /^[^·|\n]{2,60}(,\s*[^,·|\n]{2,60}){1,3}$/;

/**
 * A count, not a place. `105,570 followers` satisfies `LOCATION_SHAPE` cleanly —
 * it has a comma and no `·` — and was reported as the subject's location on the
 * first generated map. A place name has no purely-numeric component.
 */
function isCount(text: string): boolean {
  return text.split(",").some((part) => /^\s*\d+\s*$/.test(part)) || /^\s*[\d,]+\s+\S/.test(text);
}

/** Every leaf element carrying text inside one card, in document order. */
function leavesOf($: cheerio.CheerioAPI, card: Element): Array<{ el: Element; text: string }> {
  const out: Array<{ el: Element; text: string }> = [];
  $(card).find("*").each((_, node) => {
    if (out.length >= MAX_LEAVES_PER_CARD) return false;
    const el = node as Element;
    if ($(el).children().length > 0) return undefined;
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text === "") return undefined;
    out.push({ el, text });
    return undefined;
  });
  return out;
}

function cardNamed(scope: SubjectScope, suffix: string): CardRef | undefined {
  return scope.cards.find((c) => c.name === suffix);
}

/**
 * Locates the fields §7 needs, inside the subject's own cards.
 *
 * Each probe says what it looked for and on what basis it was found, and
 * everything is scoped to the subject's cards with `SuggestedForYou` excluded —
 * so a "people also viewed" stranger can never be reported as a hit.
 */
export function buildDomFieldMap(html: string): DomFieldMap {
  const $ = cheerio.load(html);
  const scope = resolveSubjectScope($);
  const probes: DomProbeReport[] = [];
  let nodesWalked = 0;

  const push = (name: string, what: string, hits: DomHit[], miss: string): void => {
    probes.push(hits.length > 0 ? { name, what, hits: hits.slice(0, MAX_HITS_PER_PROBE) } : { name, what, hits: [], miss });
  };

  // --- identity -----------------------------------------------------------
  push(
    "person_urn",
    "the subject's stable identity — the store's primary key (§7)",
    scope.profileUrn === null
      ? []
      : [{
          path: `[componentkey="${CARD_REF_PREFIX}${scope.profileId}Topcard"]`,
          sample: `${scope.profileUrn} (from the card-ref namespace)`,
          basis: "componentkey",
          inSubjectScope: true,
        }],
    `no ${CARD_REF_PREFIX}<id><Card> componentkey resolved to a single profile id`,
  );
  push(
    "member_urn",
    "the same person in LinkedIn's other identity spelling, from the top card's action buttons",
    scope.memberUrns.map((urn) => ({
      // The Topcard scope is part of the path, not a detail of how it was
      // found: unscoped, this selector matches every sidebar suggestion's own
      // Connect button too.
      path:
        `[componentkey="${CARD_REF_PREFIX}${scope.profileId}Topcard"] ` +
        `[componentkey^="ConnectButton"], ` +
        `[componentkey="${CARD_REF_PREFIX}${scope.profileId}Topcard"] ` +
        `[componentkey^="FollowButton"]`,
      sample: urn,
      basis: "attribute" as const,
      inSubjectScope: true,
    })),
    "no Connect/Follow button carried a urn:li:member:",
  );
  push(
    "vanity",
    "the /in/<vanity> slug",
    scope.vanity === null
      ? []
      : [{ path: '[componentkey$="Activity"]', sample: scope.vanity, basis: "componentkey", inSubjectScope: true }],
    "no card ref carried a vanity slug",
  );

  // --- top card -----------------------------------------------------------
  const topcard = cardNamed(scope, "Topcard");
  const topLeaves = topcard === undefined ? [] : leavesOf($, $(topcard.selector).first()[0] as Element);
  nodesWalked += topLeaves.length;

  const nameLeaf = topLeaves.find((l) => l.el.tagName === "h2");
  push(
    "full_name",
    "the display name",
    nameLeaf === undefined
      ? []
      : [{ path: cssPath($, nameLeaf.el), sample: sample(nameLeaf.text), basis: "position", inSubjectScope: true }],
    "no <h2> inside the Topcard",
  );

  // The headline is the first paragraph after the name that is not a degree
  // badge. Positional, and labelled as such — there is no key naming it.
  const afterName = nameLeaf === undefined ? topLeaves : topLeaves.slice(topLeaves.indexOf(nameLeaf) + 1);
  const paragraphs = afterName.filter((l) => l.el.tagName === "p" && !DEGREE.test(l.text));
  push(
    "headline",
    "the headline under the name",
    paragraphs.length === 0
      ? []
      : [{ path: cssPath($, paragraphs[0]!.el), sample: sample(paragraphs[0]!.text), basis: "position", inSubjectScope: true }],
    "no non-degree <p> after the name in the Topcard",
  );

  const locations = paragraphs.filter(
    (l) => !l.text.includes("·") && LOCATION_SHAPE.test(l.text) && !isCount(l.text),
  );
  push(
    "location",
    "where the person is — a comma-separated place, distinguished from the company·school line by carrying no `·`",
    locations.map((l) => ({
      path: cssPath($, l.el),
      sample: sample(l.text),
      basis: "text-shape" as const,
      inSubjectScope: true,
    })),
    "no Topcard paragraph had the shape of a place name",
  );

  const companyLine = paragraphs.find((l) => l.text.includes("·") && l !== locations[0]);
  push(
    "current_company",
    "the current company · school line under the headline",
    companyLine === undefined
      ? []
      : [{ path: cssPath($, companyLine.el), sample: sample(companyLine.text), basis: "position", inSubjectScope: true }],
    "no `·`-separated paragraph in the Topcard",
  );

  // --- the sectioned cards ------------------------------------------------
  for (const [probe, suffix, what] of [
    ["experience", "ExperienceTopLevelSection", "the container holding positions — walk this for experience rows"],
    ["education", "EducationTopLevelSection", "schools"],
    ["skills", "Skills", "skills"],
    ["about", "About", "the about/summary text"],
  ] as const) {
    const card = cardNamed(scope, suffix);
    nodesWalked += card === undefined ? 0 : 1;
    push(
      probe,
      what,
      card === undefined
        ? []
        : [{ path: card.selector, sample: `${card.tag}, ${card.textChars} chars of text`, basis: "componentkey", inSubjectScope: true }],
      `no ${CARD_REF_PREFIX}<id>${suffix} card in this snapshot`,
    );
  }

  return { scope, probes, nodesWalked };
}

/** The DOM field map, as the markdown section Task 17's parser is written
 *  against. Rendered beside the JSON field map, in the same document. */
export function renderDomFieldMap(o: { file: string; bytes: number; sourceRun: string; map: DomFieldMap }): string {
  const { map } = o;
  const { scope } = map;
  const lines: string[] = [];

  lines.push(`## \`${o.file}\` — rendered DOM snapshot`);
  lines.push("");
  lines.push(`- ${o.bytes} bytes of \`outerHTML\`, captured by run \`${o.sourceRun}\``);
  lines.push("- **This is the content source (D123).** Identity paths below are marked; every");
  lines.push("  content row a parser reads from here must be tagged DOM-sourced.");
  lines.push("");

  lines.push("### Subject scope");
  lines.push("");
  if (scope.profileId === null) {
    lines.push("⚠ **No subject scope could be resolved.** No `componentkey` of the form");
    lines.push(`\`${CARD_REF_PREFIX}<profileId><CardName>\` was found. Do not write a parser`);
    lines.push("against this snapshot — nothing in it distinguishes the subject from a suggestion.");
    lines.push("");
    return lines.join("\n") + "\n";
  }

  lines.push(`- profile id: \`${scope.profileId}\``);
  lines.push(`- urn (§7 key): \`${scope.profileUrn}\``);
  lines.push(`- vanity: ${scope.vanity === null ? "_(not found)_" : `\`${scope.vanity}\``}`);
  lines.push(`- member urns on the action buttons: ${scope.memberUrns.length === 0 ? "_(none)_" : scope.memberUrns.map((u: string) => `\`${u}\``).join(", ")}`);
  lines.push(`- ${scope.cards.length} profile cards, all namespaced by that one id`);
  if (scope.unrecognisedCards.length > 0) {
    const ratio = scope.unrecognisedCards.length / Math.max(1, scope.cards.length);
    lines.push("");
    lines.push(
      `⚠ **${scope.unrecognisedCards.length} of ${scope.cards.length} card names are not ones this ` +
        `build has seen** (${scope.unrecognisedCards.slice(0, 6).join(", ")}).`,
    );
    if (ratio > 0.5) {
      lines.push("");
      lines.push("Most of them are unknown, which means the id boundary above was cut in the wrong");
      lines.push("place — the profile id, and therefore the urn, is wrong by those characters.");
      lines.push("**Do not key anything on it.**");
    }
  }
  lines.push("");
  lines.push("| card | selector | text |");
  lines.push("|---|---|---|");
  for (const card of scope.cards) {
    const mark = card.stranger ? " ⚠ **holds other people — never read as the subject**" : "";
    lines.push(`| \`${card.name}\`${mark} | \`${card.selector}\` | ${card.textChars} |`);
  }
  lines.push("");

  lines.push("### Fields");
  lines.push("");
  lines.push("`basis` says how a hit was found, and therefore how it will break:");
  lines.push("`componentkey` survives a restyle · `position` breaks when the card is re-laid-out ·");
  lines.push("`text-shape` breaks when the value's format changes · `attribute` reads an attribute.");
  lines.push("");

  for (const probe of map.probes) {
    lines.push(`#### ${probe.name}`);
    lines.push("");
    lines.push(probe.what);
    lines.push("");
    if (probe.hits.length === 0) {
      lines.push(`⚠ **Not found.** ${probe.miss ?? ""}`);
      lines.push("");
      continue;
    }
    lines.push("| path | basis | sample |");
    lines.push("|---|---|---|");
    for (const hit of probe.hits) {
      const mark = hit.inSubjectScope ? "" : " ⚠ outside the subject's scope";
      lines.push(`| \`${hit.path}\` | ${hit.basis} | ${mdCell(hit.sample)}${mark} |`);
    }
    lines.push("");
  }

  return lines.join("\n") + "\n";
}

function mdCell(text: string): string {
  return `\`${text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")}\``;
}
