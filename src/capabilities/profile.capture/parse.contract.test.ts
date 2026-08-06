import { describe, expect, it } from "vitest";
import { CARD_REF_PREFIX } from "../../core/fixtures/dommap.js";
import { EXIT } from "../../core/run/receipt.js";
import type { upsertPerson } from "../../core/store/persons.js";
import { checkDomIdentity } from "./identity.js";
import {
  MAX_EXPERIENCE_ROWS,
  parseProfileSnapshot,
  parseProfileDateRange,
  toPersonStoreInput,
} from "./parse.js";

type Assert<T extends true> = T;
type ParserStoreInputComposes = Assert<
  ReturnType<typeof toPersonStoreInput> extends Parameters<typeof upsertPerson>[0] ? true : false
>;
const parserStoreInputComposes: ParserStoreInputComposes = true;
void parserStoreInputComposes;

const SUBJECT_ID = "ACsubject0123456789abcdefghijk";
const OTHER_ID = "ACother9876543210zyxwvutsrq";
const SUBJECT_URN = `urn:li:fsd_profile:${SUBJECT_ID}`;
const SESSION_URN = "urn:li:fsd_profile:ACsession0123456789abcdefgh";
const parse = (html: string) => parseProfileSnapshot(html, { sessionUrns: [SESSION_URN] });

function card(name: string, body: string, id = SUBJECT_ID): string {
  return `<section componentkey="${CARD_REF_PREFIX}${id}${name}">${body}</section>`;
}

function topcard(o: { headline?: string; location?: string } = {}): string {
  return card("Topcard", `
    <div componentkey="ProfileVerificationTriggerRef-subject-slug"><h2>Subject Name</h2></div>
    <p>· 2nd</p>
    ${o.headline === undefined ? "" : `<p>${o.headline}</p>`}
    <p>Current Company · School</p>
    ${o.location === undefined ? "" : `<div><p>${o.location}</p></div>`}
    <div componentkey="ConnectButtonstate:invitation:urn:li:member:123456_pending">Connect</div>
  `);
}

function standaloneExperience(o: {
  title: string;
  company: string;
  dates: string;
  description?: string;
}): string {
  return `<div componentkey="entity-collection-item-one">
    <a href="/company/example/"><p>${o.title}</p><p>${o.company} · Full-time</p><p>${o.dates}</p></a>
    ${o.description === undefined ? "" : `<div><p><span>${o.description}<button>…see more</button></span></p></div>`}
  </div>`;
}

function groupedExperience(): string {
  return `<div componentkey="entity-collection-item-two">
    <div><a href="/company/group/"><p>Group Company · Full-time</p></a></div>
    <ul>
      <li><a href="/company/group/"><p>Newer Role</p><p>Jan 2023 - Present · 3 yrs</p></a><p><span>Newer description</span></p></li>
      <li><a href="/company/group/"><p>Older Role</p><p>2019 - Dec 2022 · 4 yrs</p></a><p><span>Older description</span></p></li>
    </ul>
  </div>`;
}

function experienceCard(): string {
  return card(
    "ExperienceTopLevelSection",
    standaloneExperience({
      title: "Current Role",
      company: "Example Company",
      dates: "Aug 2021 - Present · 4 yrs 7 mos",
      description: "Current description",
    }) + groupedExperience(),
  );
}

function page(...cards: string[]): string {
  return `<html><body><main>${cards.join("")}<div componentkey="${CARD_REF_PREFIX}subject-slugActivity"></div></main></body></html>`;
}

const COMPLETE = page(
  topcard({ headline: "Subject headline", location: "Lahore, Punjab, Pakistan" }),
  experienceCard(),
  card("About", "<p>About</p>"),
);

describe("parseProfileSnapshot identity and scoping", () => {
  it("uses the DOM identity wrapper and reports only non-sensitive identity facts", () => {
    expect(checkDomIdentity(COMPLETE)).toEqual({
      resolved: true,
      urnKind: "urn:li:fsd_profile",
      vanityKnown: true,
      cards: 3,
      strangerCards: 0,
      unrecognisedCards: [],
      memberUrns: 1,
      isSession: false,
    });
    expect(JSON.stringify(checkDomIdentity(COMPLETE))).not.toContain(SUBJECT_ID);
  });

  it("returns sourced Task 14 rows and an explicit store projection", () => {
    const result = parse(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.person).toEqual({
      source: "dom-snapshot",
      value: {
        urn: SUBJECT_URN,
        vanity: "subject-slug",
        name: "Subject Name",
        headline: "Subject headline",
        location: "Lahore, Punjab, Pakistan",
      },
    });
    expect(result.corroboration.memberUrns).toEqual(["urn:li:member:123456"]);
    expect(result.experience?.map((row) => row.source)).toEqual([
      "dom-snapshot", "dom-snapshot", "dom-snapshot",
    ]);
    expect(toPersonStoreInput(result)).toEqual({
      person: result.person.value,
      experience: result.experience?.map((row) => row.value),
    });
  });

  it("preserves DOM order, expands grouped roles, and keeps descriptions out of store rows", () => {
    const result = parse(COMPLETE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.experience?.map((row) => row.value.title)).toEqual([
      "Current Role", "Newer Role", "Older Role",
    ]);
    expect(result.experience?.map((row) => row.description)).toEqual([
      "Current description", "Newer description", "Older description",
    ]);
    expect(result.experience?.map((row) => row.value.company_name)).toEqual([
      "Example Company", "Group Company", "Group Company",
    ]);
    expect(JSON.stringify(toPersonStoreInput(result))).not.toContain("description");
    expect(JSON.stringify(toPersonStoreInput(result))).not.toContain("source");
  });

  it("extracts nothing when SuggestedForYou is the only card", () => {
    const suggestion = page(card(
      "SuggestedForYou",
      `<div componentkey="ProfileVerificationTriggerRef-stranger"><h2>Stranger</h2></div>
       <p>Stranger headline</p>
       <div componentkey="ConnectButtonstate:invitation:urn:li:member:999999_pending">Connect</div>`,
    ));
    const result = parse(suggestion);
    expect(checkDomIdentity(suggestion).resolved).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.person).toBeNull();
    expect(result.experience).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("999999");
  });

  it("refuses an id boundary when most resolved card names are unknown", () => {
    const unknown = page(
      card("BrandNewAlpha", "<p>one</p>"),
      card("BrandNewBeta", "<p>two</p>"),
      card("Topcard", "<h2>Name</h2>"),
    );
    expect(checkDomIdentity(unknown).resolved).toBe(false);
    expect(parse(unknown).ok).toBe(false);
  });

  it("does not read suggestion member urns while parsing the subject", () => {
    const withSuggestions = page(
      topcard({ headline: "Subject headline", location: "Lahore, Punjab, Pakistan" }),
      experienceCard(),
      card("SuggestedForYou", `
        <div componentkey="ConnectButtonstate:invitation:urn:li:member:888111_pending">Connect</div>
        <div componentkey="ConnectButtonstate:invitation:urn:li:member:888222_pending">Connect</div>`),
    );
    const result = parse(withSuggestions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.corroboration.memberUrns).toEqual(["urn:li:member:123456"]);
    expect(JSON.stringify(result)).not.toContain("888111");
    expect(JSON.stringify(result)).not.toContain("888222");
  });

  it("refuses disagreeing card namespaces instead of choosing either person", () => {
    const result = parse(page(
      topcard({ headline: "Subject headline", location: "Lahore, Punjab, Pakistan" }),
      card("About", "<p>Other</p>", OTHER_ID),
    ));
    expect(result.ok).toBe(false);
    expect(result.person).toBeNull();
    expect(result.warnings[0]).toMatchObject({
      code: "PARSE_IDENTITY_UNRESOLVED",
      field: "identity",
      exit: EXIT.PARSE_DRIFT,
    });
  });

  it("has no vanity or member-urn fallback when card refs disappear", () => {
    const withoutRefs = COMPLETE.replaceAll(`${CARD_REF_PREFIX}${SUBJECT_ID}`, "deleted-card-ref-");
    const result = parse(withoutRefs);
    expect(result.ok).toBe(false);
    expect(result.person).toBeNull();
    expect(JSON.stringify(result)).not.toContain("urn:li:member:123456");
    expect(JSON.stringify(result)).not.toContain("subject-slug");
  });

  it("reports and rejects the operator's own urn", () => {
    const result = parseProfileSnapshot(COMPLETE, { sessionUrns: [SUBJECT_URN] });
    expect(result.ok).toBe(false);
    expect(result.person).toBeNull();
    expect(result.warnings[0]).toMatchObject({
      code: "PARSE_IDENTITY_IS_SESSION",
      field: "identity",
      exit: EXIT.PARSE_DRIFT,
    });
  });

  it("refuses to key a row when the caller cannot provide the session identity", () => {
    const result = parseProfileSnapshot(COMPLETE, { sessionUrns: [] });
    expect(result.ok).toBe(false);
    expect(result.person).toBeNull();
    expect(result.warnings[0]).toMatchObject({
      code: "PARSE_SESSION_IDENTITY_UNAVAILABLE",
      field: "identity",
      exit: EXIT.PARSE_DRIFT,
    });
  });
});

describe("parseProfileSnapshot drift and variants", () => {
  it("degrades a missing positional field and emits exit-5 drift instead of a silent empty value", () => {
    const result = parse(page(
      topcard({ location: "Lahore, Punjab, Pakistan" }),
      experienceCard(),
    ));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.person.value).not.toHaveProperty("headline");
    expect(result.warnings).toContainEqual({
      code: "PARSE_FIELD_MISSING",
      field: "headline",
      n: 1,
      exit: EXIT.PARSE_DRIFT,
      basis: "position",
    });
  });

  it("distinguishes an absent experience card from a present empty one", () => {
    const absent = parse(page(topcard({ headline: "H", location: "Lahore, Punjab, Pakistan" })));
    const empty = parse(page(
      topcard({ headline: "H", location: "Lahore, Punjab, Pakistan" }),
      card("ExperienceTopLevelSection", "<div></div>"),
    ));
    expect(absent.ok && absent.experience).toBeUndefined();
    expect(absent.warnings).toContainEqual(expect.objectContaining({
      field: "experience", basis: "componentkey", exit: EXIT.PARSE_DRIFT,
    }));
    expect(empty.ok && empty.experience).toEqual([]);
    expect(empty.warnings).not.toContainEqual(expect.objectContaining({ field: "experience" }));
  });

  it("tries the fallback name variant when the verification trigger moves", () => {
    const html = COMPLETE.replace(
      '<div componentkey="ProfileVerificationTriggerRef-subject-slug"><h2>Subject Name</h2></div>',
      "<div><h2>Subject Name</h2></div>",
    );
    const result = parse(html);
    expect(result.ok && result.person.value.name).toBe("Subject Name");
    expect(result.warnings).not.toContainEqual(expect.objectContaining({ field: "name" }));
  });

  it("returns a classified refusal for empty and unrecognizable input", () => {
    for (const html of ["", "not html", "<html><body><h2>No cards</h2></body></html>"]) {
      const result = parse(html);
      expect(result.ok).toBe(false);
      expect(result.warnings[0]).toMatchObject({
        code: "PARSE_IDENTITY_UNRESOLVED",
        exit: EXIT.PARSE_DRIFT,
      });
    }
  });

  it("bounds experience output and reports every row it drops", () => {
    const items = Array.from({ length: MAX_EXPERIENCE_ROWS + 3 }, (_, index) =>
      standaloneExperience({
        title: `Role ${index}`,
        company: "Company",
        dates: "2020 - 2021",
      }),
    ).join("");
    const result = parse(page(
      topcard({ headline: "H", location: "Lahore, Punjab, Pakistan" }),
      card("ExperienceTopLevelSection", items),
    ));
    expect(result.ok && result.experience).toHaveLength(MAX_EXPERIENCE_ROWS);
    expect(result.warnings).toContainEqual({
      code: "PARSE_FIELD_TRUNCATED",
      field: "experience",
      n: 3,
      exit: EXIT.PARSE_DRIFT,
      basis: "componentkey",
    });
  });
});

describe("parseProfileDateRange", () => {
  it.each([
    ["Aug 2021 - Present · 4 yrs", { started_on: "2021-08-01", ended_on: null, is_current: true }],
    ["2019 - Dec 2022 · 4 yrs", { started_on: "2019-01-01", ended_on: "2022-12-01", is_current: false }],
    ["Jan 2020 – Feb 2021", { started_on: "2020-01-01", ended_on: "2021-02-01", is_current: false }],
  ])("parses %s", (input, expected) => {
    expect(parseProfileDateRange(input)).toEqual(expected);
  });

  it("returns null for a shape it cannot recognize", () => {
    expect(parseProfileDateRange("for a while")).toBeNull();
  });
});
