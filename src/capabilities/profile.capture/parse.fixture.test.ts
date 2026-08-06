import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import { resolveSubjectScope } from "../../core/fixtures/dommap.js";
import { loadProfileSnapshotFixtures } from "./fixture.test-helper.js";
import { parseProfileSnapshot, toPersonStoreInput } from "./parse.js";

const fixtures = loadProfileSnapshotFixtures();
const why = "fixtures/profile.get has no promoted DOM snapshot; run npm run fixtures:promote";
const parse = (html: string) => parseProfileSnapshot(html, {
  sessionUrns: ["urn:li:fsd_profile:ACnonmatchingFixtureSession012345"],
});
if (fixtures.length === 0) process.stderr.write(`\n[skip] profile parser fixture tests — ${why}.\n`);

describe.skipIf(fixtures.length === 0)(
  fixtures.length > 0 ? "profile parser against promoted DOM snapshot" : `profile parser fixture tests (skipped — ${why})`,
  () => {
    for (const fixture of fixtures) {
      it(`parses identity and content from ${fixture.file}`, () => {
        const result = parse(fixture.html);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.person.source).toBe("dom-snapshot");
        expect(result.person.value.urn).toBe(
          "urn:li:fsd_profile:ACoAABJLCOABl3WHDMGiReUZpWQ432xXbddzpUA",
        );
        expect(result.person.value.name).toBeTruthy();
        expect(result.person.value.headline).toBeTruthy();
        expect(result.person.value.location).toBe("San Francisco, California, United States");
        expect(result.experience).toHaveLength(6);
        expect(result.experience?.every((row) => row.source === "dom-snapshot")).toBe(true);
        expect(result.experience?.every((row) => Boolean(row.value.title))).toBe(true);
        expect(result.experience?.every((row) => Boolean(row.value.company_name))).toBe(true);
        expect(result.experience?.every((row) => Boolean(row.value.started_on))).toBe(true);
        expect(result.experience?.every((row) => row.description !== undefined)).toBe(true);
        // The card is newest-first, including the two nested roles under one
        // employer. Preserving DOM order is part of the parser contract.
        expect(result.experience?.map((row) => row.value.started_on?.slice(0, 4))).toEqual([
          "2021", "2021", "2020", "2020", "2020", "2017",
        ]);

        const store = toPersonStoreInput(result);
        expect(store.experience).toHaveLength(6);
        expect(JSON.stringify(store)).not.toContain("description");
        expect(JSON.stringify(store)).not.toContain("source");
      });

      it(`excludes all suggestion identities in ${fixture.file}`, () => {
        const $ = cheerio.load(fixture.html);
        const scope = resolveSubjectScope($);
        const suggested = scope.cards.find((card) => card.name === "SuggestedForYou");
        expect(suggested).toBeDefined();
        const fragment = $.html($(suggested!.selector).first());
        const subjectUrns = new Set(scope.memberUrns);
        const suggestionUrns = [...new Set(fixture.html.match(/urn:li:member:\d+/g) ?? [])]
          .filter((urn) => !subjectUrns.has(urn));
        expect(suggestionUrns).toHaveLength(16);

        const isolated = parse(fragment);
        expect(isolated.ok).toBe(false);
        expect(isolated.person).toBeNull();

        const parsed = parse(fixture.html);
        expect(parsed.ok).toBe(true);
        const serialized = JSON.stringify(parsed);
        for (const urn of suggestionUrns) expect(serialized).not.toContain(urn);
      });
    }
  },
);
