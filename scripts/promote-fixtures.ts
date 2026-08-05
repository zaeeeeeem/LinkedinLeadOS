#!/usr/bin/env -S npx tsx
/**
 * Promotes one run's raw archive into `fixtures/<capability>/` plus the field
 * map Task 16's parser is written against (§6).
 *
 *   npm run fixtures:promote -- --run=<runId>
 *   npm run fixtures:promote -- --latest
 *   npm run fixtures:promote -- --latest --all        # every JSON body, not just profiles
 *
 * Nothing here touches LinkedIn or the browser: it reads files a capture already
 * wrote. Safe to re-run — promotion is idempotent, deduplicated by shape hash,
 * and only ever adds.
 *
 * Only counts and paths reach stdout. Captured bodies stay in `fixtures/`, which
 * is gitignored, because they hold real prospect data.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { isProfileIsh } from "../src/capabilities/profile.capture/patterns.js";
import { promoteFixtures } from "../src/core/fixtures/promote.js";
import { defaultRunsDir } from "../src/core/run/paths.js";

type Options = {
  run: string | null;
  latest: boolean;
  capability: string;
  all: boolean;
  runsDir: string;
  fixturesDir: string | null;
};

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "usage: npm run fixtures:promote -- (--run=<runId> | --latest) " +
      "[--capability=profile.get] [--all] [--runs-dir=<dir>] [--fixtures-dir=<dir>]\n",
  );
  process.exit(1);
}

function parse(argv: string[]): Options {
  const o: Options = {
    run: null,
    latest: false,
    capability: "profile.get",
    all: false,
    runsDir: defaultRunsDir(),
    fixturesDir: null,
  };
  for (const token of argv) {
    const [name, value] = token.startsWith("--")
      ? [token.slice(2).split("=")[0]!, token.includes("=") ? token.slice(token.indexOf("=") + 1) : null]
      : [token, null];
    switch (name) {
      case "run": o.run = value ?? usage("--run needs a run id"); break;
      case "latest": o.latest = true; break;
      case "capability": o.capability = value ?? usage("--capability needs a name"); break;
      case "all": o.all = true; break;
      case "runs-dir": o.runsDir = resolve(value ?? usage("--runs-dir needs a path")); break;
      case "fixtures-dir": o.fixturesDir = resolve(value ?? usage("--fixtures-dir needs a path")); break;
      default: usage(`unknown argument ${token}`);
    }
  }
  if (o.run === null && !o.latest) usage("name the run: --run=<runId>, or --latest");
  return o;
}

/** The most recently created run directory. Run ids are ULIDs, so lexical order
 *  is chronological — but mtime is used anyway, because a resumed run is newer
 *  than its id says. */
function latestRun(runsDir: string): string {
  if (!existsSync(runsDir)) usage(`no runs directory at ${runsDir}`);
  const candidates = readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(runsDir, e.name, "run.json")))
    .map((e) => ({ name: e.name, mtime: statSync(join(runsDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) usage(`no runs found under ${runsDir}`);
  return candidates[0]!.name;
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2));
  const runId = o.run ?? latestRun(o.runsDir);
  const archiveDir = join(o.runsDir, runId, "raw");
  if (!existsSync(archiveDir)) usage(`run ${runId} has no raw/ directory at ${archiveDir}`);

  const fixturesDir = o.fixturesDir ?? resolve(process.cwd(), "fixtures", o.capability);

  const result = await promoteFixtures({
    archiveDir,
    fixturesDir,
    capability: o.capability,
    sourceRun: runId,
    all: o.all,
    isRelevant: isProfileIsh,
  });

  // Counts and paths only. Never a body, never a url with a query string.
  process.stdout.write(
    JSON.stringify(
      {
        run: runId,
        capability: o.capability,
        promoted: result.promoted.map((f) => ({
          file: f.file,
          path: f.path,
          query_id: f.query_id,
          status: f.status,
          bytes: f.bytes,
          profile_ish: f.profile_ish,
        })),
        total_fixtures: result.total,
        skipped: result.skipped,
        unreadable: result.unreadable,
        field_map: result.fieldMapPath,
        index: result.indexPath,
      },
      null,
      2,
    ) + "\n",
  );

  if (result.promoted.length === 0 && result.total === 0) {
    process.stderr.write(
      "nothing was promoted: the run archived no JSON body carrying person data. " +
        "Re-run with --all to promote every JSON body and see what is there.\n",
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
