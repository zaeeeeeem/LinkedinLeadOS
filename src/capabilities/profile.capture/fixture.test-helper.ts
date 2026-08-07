import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { repoRoot } from "../../core/run/root.js";

export type ProfileSnapshotFixture = {
  file: string;
  html: string;
};

/**
 * The shared fixture library, anchored to the repo root rather than to this file's
 * own checkout.
 *
 * A parser task runs in a linked worktree, and `fixtures/` is gitignored — so the
 * module-relative path resolved to that worktree's *empty* directory and the whole
 * fixture suite skipped, which reads identically to "the probe never ran" (D301).
 * `import.meta.url` stays as the fallback for a copy that is not in a repository.
 */
export const DEFAULT_PROFILE_FIXTURES_DIR = fixturesDirFor("profile.get");

/** Resolves one capability's fixture directory in the shared library. */
export function fixturesDirFor(capability: string): string {
  const root = repoRoot();
  const shared = resolve(root, "fixtures", capability);
  if (existsSync(shared)) return shared;
  return fileURLToPath(new URL(`../../../fixtures/${capability}/`, import.meta.url));
}

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
