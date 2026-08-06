import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_PROFILE_SNAPSHOT_FIXTURES,
  loadProfileSnapshotFixtures,
} from "./fixture.test-helper.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureDir(): string {
  const root = mkdtempSync(join(tmpdir(), "linkedin-os-profile-fixtures-"));
  roots.push(root);
  return root;
}

describe("loadProfileSnapshotFixtures", () => {
  it("returns only DOM snapshots, sorted, without interpreting their bytes", () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "b-dom-snapshot.html"), "<b>two</b>");
    writeFileSync(join(dir, "a-dom-snapshot.html"), "<b>one</b>");
    writeFileSync(join(dir, "body.json"), "{}");
    expect(loadProfileSnapshotFixtures(dir)).toEqual([
      { file: "a-dom-snapshot.html", html: "<b>one</b>" },
      { file: "b-dom-snapshot.html", html: "<b>two</b>" },
    ]);
  });

  it("refuses more than the stated fixture bound instead of silently dropping files", () => {
    const dir = fixtureDir();
    for (let i = 0; i <= MAX_PROFILE_SNAPSHOT_FIXTURES; i++) {
      writeFileSync(join(dir, `${String(i).padStart(3, "0")}-dom-snapshot.html`), "<html></html>");
    }
    expect(() => loadProfileSnapshotFixtures(dir)).toThrow(/fixture limit/);
  });
});
