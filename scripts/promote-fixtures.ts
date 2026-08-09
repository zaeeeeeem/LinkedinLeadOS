#!/usr/bin/env -S npx tsx
/**
 * Promotes one run's raw archive into `fixtures/<capability>/` plus the field
 * map Task 16's parser is written against (§6).
 *
 *   npm run fixtures:promote -- --run=<runId>
 *   npm run fixtures:promote -- --latest
 *   npm run fixtures:promote -- --latest --all        # every JSON body, not just profiles
 *   npm run fixtures:promote -- --run=<id> --capability=job.get   # a job probe's archive
 *
 * Nothing here touches LinkedIn or the browser: it reads files a capture already
 * wrote. Safe to re-run — promotion is idempotent, deduplicated by shape hash,
 * and only ever adds.
 *
 * Only counts and paths reach stdout. Captured bodies stay in `fixtures/`, which
 * is gitignored, because they hold real prospect data.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RawArchive } from "../src/core/archive/raw.js";
import { domMapOf, familyOf, probesOf, relevanceOf, renderDomMapOf, subjectFor } from "../src/core/fixtures/families.js";
import type { Family } from "../src/core/fixtures/families.js";
import { isPrivateEndpoint, personUrnsIn, promoteFixtures } from "../src/core/fixtures/promote.js";
import type { PromoteSubject } from "../src/core/fixtures/promote.js";
import { defaultRunsDir } from "../src/core/run/paths.js";
import { repoRoot } from "../src/core/run/root.js";

type Options = {
  run: string | null;
  latest: boolean;
  capability: string;
  all: boolean;
  runsDir: string;
  fixturesDir: string | null;
  subject: string | null;
};

/**
 * Who the run was of, from the run's own recorded arguments — so promotion
 * cannot disagree with the capture about which subject this archive is of.
 *
 * `--subject=` overrides it for an archive whose `run.json` predates this.
 * The per-family rules live in `core/fixtures/families.ts`, where they are
 * tested; this function is only the file read around them.
 */
function subjectOf(
  runsDir: string,
  runId: string,
  override: string | null,
  family: Family,
): PromoteSubject | null {
  const raw = override ?? readRunUrl(runsDir, runId);
  return raw === null ? null : subjectFor(family, raw);
}

function readRunUrl(runsDir: string, runId: string): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(runsDir, runId, "run.json"), "utf8")) as {
      args?: Record<string, unknown>;
    };
    const url = meta.args?.["url"];
    return typeof url === "string" && url !== "" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The session's own person urns, read out of the `/voyager/api/me` body the
 * page fetched anyway. Not a filter — the field map marks paths that resolve to
 * these, so a parser is never written against the operator's own identity while
 * looking like it found the subject's (D119).
 */
async function sessionUrnsOf(archiveDir: string): Promise<string[]> {
  const archive = new RawArchive(archiveDir);
  const urns = new Set<string>();
  for (const entry of await archive.list()) {
    if (!/\/voyager\/api\/me\b/.test(entry.url)) continue;
    if (isPrivateEndpoint(entry.url)) continue;
    try {
      for (const urn of personUrnsIn(await archive.readText(entry))) urns.add(urn);
    } catch {
      // An unreadable body here costs a marking, not the promotion.
    }
  }
  return [...urns];
}

function usage(message: string): never {
  process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "usage: npm run fixtures:promote -- (--run=<runId> | --latest) " +
      "[--capability=profile.get] [--subject=<vanity>] [--all] [--runs-dir=<dir>] [--fixtures-dir=<dir>]\n",
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
    subject: null,
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
      case "subject": o.subject = value ?? usage("--subject needs a vanity slug or profile url"); break;
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

  // Repo root, not cwd: the fixture library is gitignored and shared, so promoting
  // from a worktree has to land in the one library every other checkout reads (D301).
  const fixturesDir = o.fixturesDir ?? resolve(repoRoot(), "fixtures", o.capability);

  const family = familyOf(o.capability);
  const subject = subjectOf(o.runsDir, runId, o.subject, family);
  const sessionUrns = await sessionUrnsOf(archiveDir);
  const probes = probesOf(family);

  const result = await promoteFixtures({
    archiveDir,
    fixturesDir,
    capability: o.capability,
    sourceRun: runId,
    all: o.all,
    isRelevant: relevanceOf(family),
    ...(subject === null ? {} : { subject }),
    ...(probes === undefined ? {} : { probes }),
    sessionUrns,
    domMapper: {
      build: (html) => domMapOf(family, html),
      render: (input) => renderDomMapOf(family, input),
    },
  });

  // Counts and paths only. Never a body, never a url with a query string.
  process.stdout.write(
    JSON.stringify(
      {
        run: runId,
        capability: o.capability,
        family,
        // Whether, not who: the slug is the prospect's identity, and only counts
        // and paths belong on stdout.
        subject_known: subject !== null,
        session_urns_found: sessionUrns.length,
        promoted: result.promoted.map((f) => ({
          file: f.file,
          path: f.path,
          query_id: f.query_id,
          status: f.status,
          bytes: f.bytes,
          profile_ish: f.profile_ish,
          subject_match: f.subject_match,
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

  if (subject === null) {
    process.stderr.write(
      "no subject could be read from this run, so promotion fell back to " +
        "\"any body carrying person data\" — which promotes other people's data too. " +
        "Name the subject with --subject=<vanity>.\n",
    );
  }

  if (result.promoted.length === 0 && result.total === 0) {
    process.stderr.write(
      `nothing was promoted: of this run's bodies, ${result.skipped.not_subject} carried ` +
        `person data that was not the subject's, ${result.skipped.not_profile} carried none, and ` +
        `${result.skipped.private_endpoint} were private endpoints (never eligible). ` +
        "Re-run with --all to promote every non-private JSON body and see what is there.\n",
    );
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
