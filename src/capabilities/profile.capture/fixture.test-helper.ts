import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export type ProfileSnapshotFixture = {
  file: string;
  html: string;
};

export const DEFAULT_PROFILE_FIXTURES_DIR = fileURLToPath(
  new URL("../../../fixtures/profile.get/", import.meta.url),
);

export const MAX_PROFILE_SNAPSHOT_FIXTURES = 32;

/** Test-only fixture discovery. Captured bytes are returned to the parser and
 * never printed; a missing gitignored fixture set is an explicit empty result
 * so the fixture suite can skip visibly on a fresh clone (§6). */
export function loadProfileSnapshotFixtures(
  directory = DEFAULT_PROFILE_FIXTURES_DIR,
): ProfileSnapshotFixture[] {
  if (!existsSync(directory)) return [];
  const files = readdirSync(directory)
    .filter((file) => file.endsWith("-dom-snapshot.html"))
    .sort();
  if (files.length > MAX_PROFILE_SNAPSHOT_FIXTURES) {
    throw new Error(
      `profile snapshot fixture limit ${MAX_PROFILE_SNAPSHOT_FIXTURES} exceeded by ${files.length}`,
    );
  }
  return files
    .map((file) => ({ file, html: readFileSync(join(directory, file), "utf8") }));
}
