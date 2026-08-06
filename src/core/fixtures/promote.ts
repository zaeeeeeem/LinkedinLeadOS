import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RawArchive } from "../archive/raw.js";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { buildFieldMap, renderFieldMap } from "./fieldmap.js";
import type { FieldMap, FieldProbe } from "./fieldmap.js";
import { buildDomFieldMap, renderDomFieldMap } from "./dommap.js";
import { isDomSnapshotEntry } from "../../capabilities/profile.capture/snapshot.js";

/** One promoted body, as `index.json` records it. */
export type FixtureEntry = {
  file: string;
  shape_hash: string;
  /** Endpoint path only — the query string carries captured data (§6, D3). */
  path: string;
  query_id: string | null;
  status: number;
  bytes: number;
  source_run: string;
  promoted_at: string;
  profile_ish: boolean;
  /** True when the body actually names the subject this capture asked for.
   *  `profile_ish` only says "some person appears in here" — which every
   *  notification and every message thread also satisfies (D118). */
  subject_match: boolean;
  /** True for the rendered-DOM snapshot — the content fixture (D123). It is
   *  html, not JSON, and it gets the DOM field map rather than the JSON one. */
  dom_snapshot?: boolean;
};

export type FixtureIndex = {
  capability: string;
  updated_at: string;
  fixtures: FixtureEntry[];
};

export type PromoteResult = {
  fixturesDir: string;
  indexPath: string;
  fieldMapPath: string;
  /** Newly written this run. A re-run over the same archive promotes nothing. */
  promoted: FixtureEntry[];
  /** Everything the field map now describes, new and pre-existing. */
  total: number;
  skipped: {
    /** A body whose structural shape is already represented (§6 dedupes by shape). */
    duplicate_shape: number;
    /** The operator's own private correspondence. Never promoted, `--all` or not. */
    private_endpoint: number;
    /** Carries person data, but not *this* subject's, and `--all` was not given. */
    not_subject: number;
    /** Not carrying person data, and `--all` was not given. */
    not_profile: number;
    /** Not JSON at all — an image, an HTML error page, a redirect body. */
    not_json: number;
    /** The archive could not return it. The code is kept so it is not silent. */
    unreadable: number;
    /** A DOM snapshot that did not name the subject. Counted apart from
     *  `not_subject` because there is at most one per run and losing it means
     *  the run produced no content fixture at all (D123). */
    snapshot_not_subject: number;
  };
  /** Archive read failures, by the code the archive itself classified them with. */
  unreadable: Array<{ file: string; code: string }>;
};

export type PromoteInput = {
  /** A run's `raw/` directory. */
  archiveDir: string;
  fixturesDir: string;
  capability: string;
  /** The run id the archive belongs to, recorded on every promoted fixture. */
  sourceRun: string;
  /** Promote every JSON body, not only the ones carrying the subject's data.
   *  Does **not** reach private endpoints — that exclusion has no override. */
  all?: boolean;
  /** Decides which bodies are worth promoting. Default: carries a person urn. */
  isRelevant?: (body: string) => boolean;
  /** Who this capture was of. Given, it is the filter: a body that does not
   *  name this person is not a fixture for parsing this person (D118). */
  subject?: PromoteSubject;
  /** The session's own identity, from `/voyager/api/me`. Not a filter — the
   *  field map marks any path whose value is one of these, so a parser is never
   *  written against the operator's own urn thinking it is the subject's. */
  sessionUrns?: readonly string[];
  probes?: readonly FieldProbe[];
  now?: () => Date;
};

/** Who a capture was of, in whichever form the run recorded. */
export type PromoteSubject = {
  /** The `/in/<vanity>` slug. */
  vanity?: string;
  /** Any urn already known to be this person's. */
  urns?: readonly string[];
};

/**
 * Endpoints whose bodies are the operator's own private correspondence and
 * activity rather than anything about a prospect: message threads, notification
 * cards, mailbox counts, presence, nav chrome, A/B config, account settings.
 *
 * Excluded before anything else looks at the body, and **`--all` does not reach
 * this** — the whole point is that it cannot be turned off by a flag on a tired
 * evening. `fixtures/` is the one directory that will eventually be shared, and
 * the first live capture promoted 339KB of the operator's inbox into it because
 * message threads mention other people's profile urns and so passed a
 * "carries person data" test cleanly (D118).
 */
export const PRIVATE_ENDPOINT =
  /messaging|messenger|conversation|notification|badging|presence|mailbox|invitation|globalnav|chameleon|mysettings/i;

export function isPrivateEndpoint(url: string): boolean {
  // The path alone is not enough: every GraphQL call shares `/voyager/api/graphql`
  // and is told apart only by `queryId`, so `voyagerFeedDashGlobalNavs` and a
  // profile query are the same path.
  return PRIVATE_ENDPOINT.test(pathOf(url)) || PRIVATE_ENDPOINT.test(queryIdOf(url) ?? "");
}

/** Every person urn a body names, deduped. Used on `/voyager/api/me` to learn
 *  the session's own identity, which must never be mistaken for a subject's. */
export function personUrnsIn(body: string): string[] {
  const found = body.match(/urn:li:(?:fsd_profile|fs_profile|fs_salesProfile|member):[A-Za-z0-9_-]+/g) ?? [];
  return [...new Set(found)];
}

/** True when a body actually names this subject — by vanity slug or by a urn
 *  already known to be theirs. Substring, because the name may appear anywhere
 *  in a GraphQL envelope, and case-insensitive, because vanity slugs are. */
export function namesSubject(body: string, subject: PromoteSubject): boolean {
  const haystack = body.toLowerCase();
  if (subject.vanity && subject.vanity !== "" && haystack.includes(subject.vanity.toLowerCase())) return true;
  return (subject.urns ?? []).some((urn) => urn !== "" && haystack.includes(urn.toLowerCase()));
}

function failed(op: string, cause: unknown): CapabilityError {
  return new CapabilityError({
    code: "FIXTURE_PROMOTE_FAILED",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `promoting fixtures failed while ${op}: ${String(cause)}`,
  });
}

function pathOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return "(unparseable url)";
  }
}

function queryIdOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).searchParams.get("queryId");
  } catch {
    return null;
  }
}

async function readIndex(indexPath: string, capability: string): Promise<FixtureIndex> {
  try {
    const parsed = JSON.parse(await readFile(indexPath, "utf8")) as FixtureIndex;
    if (!Array.isArray(parsed.fixtures)) throw new Error("index.json has no fixtures array");
    return parsed;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return { capability, updated_at: "", fixtures: [] };
    }
    // A corrupt index would otherwise cause silent re-promotion of everything
    // under new duplicate names. Better to stop and let a human delete it.
    throw failed(`reading ${indexPath}`, cause);
  }
}

/**
 * Turns one run's raw archive into `fixtures/<capability>/` plus the field map
 * Task 16's parser is written against (§6).
 *
 * Deduplication is by **shape hash**, not by URL or by bytes: two captures with
 * the same structure teach a parser nothing extra, and the shape hash is exactly
 * the "same structure regardless of data" grouping Task 7 already computes and
 * stores in the filename. First occurrence wins, in archive order, so re-running
 * promotion is idempotent.
 *
 * Nothing here is destructive: promotion only ever adds files, and the raw
 * archive is untouched. A body that fails to read is counted and named rather
 * than skipped silently — a fixture set that is quietly short is how a parser
 * ends up proven against half the shapes it will meet.
 */
export async function promoteFixtures(input: PromoteInput): Promise<PromoteResult> {
  const now = input.now ?? (() => new Date());
  const isRelevant =
    input.isRelevant ??
    ((body: string) => /urn:li:(fsd_profile|fs_profile|fs_salesProfile):|"publicIdentifier"/.test(body));
  const indexPath = join(input.fixturesDir, "index.json");
  const fieldMapPath = join(input.fixturesDir, "FIELD-MAP.md");

  const archive = new RawArchive(input.archiveDir);
  const entries = await archive.list();

  const index = await readIndex(indexPath, input.capability);
  // Two dedupe namespaces, deliberately. A JSON body is deduped by structural
  // shape; a DOM snapshot cannot be — its shape hash is `NON_JSON_SHAPE`, the
  // same value the document response carries, so sharing one set would let
  // whichever landed first suppress the other (the D118 mistake, one layer on).
  const known = new Set(index.fixtures.filter((f) => f.dom_snapshot !== true).map((f) => f.shape_hash));
  const knownSnapshots = new Set(index.fixtures.filter((f) => f.dom_snapshot === true).map((f) => f.file));

  const promoted: FixtureEntry[] = [];
  const unreadable: PromoteResult["unreadable"] = [];
  const skipped = {
    duplicate_shape: 0, private_endpoint: 0, not_subject: 0, not_profile: 0, not_json: 0,
    unreadable: 0, snapshot_not_subject: 0,
  };

  try {
    await mkdir(input.fixturesDir, { recursive: true });
  } catch (cause) {
    throw failed(`creating ${input.fixturesDir}`, cause);
  }

  for (const entry of entries) {
    const isSnapshot = isDomSnapshotEntry(entry);

    // First, and before the body is even read: a private endpoint is not a
    // fixture candidate under any flag. A snapshot has no endpoint — its url is
    // synthetic — so this is not asked of it.
    if (!isSnapshot && isPrivateEndpoint(entry.url)) {
      skipped.private_endpoint++;
      continue;
    }

    let body: string;
    try {
      body = await archive.readText(entry);
    } catch (cause) {
      // Classified one layer down already (D17): kept verbatim, counted, and
      // named on the result rather than re-decided here.
      skipped.unreadable++;
      unreadable.push({
        file: entry.file,
        code: cause instanceof CapabilityError ? cause.code : "UNKNOWN",
      });
      continue;
    }

    // The DOM snapshot is the content fixture (D123) and is html, so it takes a
    // branch of its own: it is never JSON, its shape hash is `NON_JSON_SHAPE`
    // and therefore collides with the document response, and it gets the DOM
    // field map. Everything else about it is unchanged — it must still name the
    // subject (D118), and it is still promoted byte for byte.
    if (isSnapshot) {
      if (input.subject && !namesSubject(body, input.subject) && !input.all) {
        skipped.snapshot_not_subject++;
        continue;
      }
      const file = `${entry.shapeHash}-dom-snapshot.html`;
      if (knownSnapshots.has(file)) {
        skipped.duplicate_shape++;
        continue;
      }
      try {
        await writeFile(join(input.fixturesDir, file), body, "utf8");
      } catch (cause) {
        throw failed(`writing ${file}`, cause);
      }
      knownSnapshots.add(file);
      promoted.push({
        file,
        shape_hash: entry.shapeHash,
        path: "(rendered DOM snapshot)",
        query_id: null,
        status: entry.status,
        bytes: entry.bytes,
        source_run: input.sourceRun,
        promoted_at: now().toISOString(),
        profile_ish: true,
        subject_match: input.subject ? namesSubject(body, input.subject) : true,
        dom_snapshot: true,
      });
      continue;
    }

    try {
      JSON.parse(body);
    } catch {
      skipped.not_json++;
      continue;
    }

    const relevant = isRelevant(body);
    // A subject narrows "carries person data" to "carries *this* person's data".
    // Without one, promotion falls back to the old heuristic — which is why the
    // script always supplies one from the run's own arguments.
    const subjectMatch = input.subject ? namesSubject(body, input.subject) : relevant;

    if (!relevant && !input.all) {
      skipped.not_profile++;
      continue;
    }
    if (relevant && !subjectMatch && !input.all) {
      skipped.not_subject++;
      continue;
    }

    // Dedupe last, not first. Another person's response has the same shape as
    // the subject's — that is what a shape hash means — so checking it before
    // relevance lets a stranger's body claim the slot and the subject's own
    // body then gets skipped as a duplicate.
    if (known.has(entry.shapeHash)) {
      skipped.duplicate_shape++;
      continue;
    }

    const file = `${entry.shapeHash}.json`;
    try {
      // The untouched body, byte for byte. A reformatted fixture would prove a
      // parser against something LinkedIn never sent (D2's reason, one step on).
      await writeFile(join(input.fixturesDir, file), body, "utf8");
    } catch (cause) {
      throw failed(`writing ${file}`, cause);
    }

    known.add(entry.shapeHash);
    promoted.push({
      file,
      shape_hash: entry.shapeHash,
      path: pathOf(entry.url),
      query_id: queryIdOf(entry.url),
      status: entry.status,
      bytes: entry.bytes,
      source_run: input.sourceRun,
      promoted_at: now().toISOString(),
      profile_ish: relevant,
      subject_match: subjectMatch,
    });
  }

  const merged: FixtureIndex = {
    capability: input.capability,
    updated_at: now().toISOString(),
    fixtures: [...index.fixtures, ...promoted],
  };

  try {
    await writeFile(indexPath, JSON.stringify(merged, null, 2) + "\n", "utf8");
  } catch (cause) {
    throw failed(`writing ${indexPath}`, cause);
  }

  // Regenerated over the whole index, not only over what this run added, so a
  // second promotion never drops the first one's sections out of the document.
  const sections = [];
  // Rendered ahead of the JSON sections: the DOM snapshot is the content source
  // (D123), so it is what a parser author opens this document for.
  const domSections: string[] = [];
  for (const f of merged.fixtures) {
    if (f.dom_snapshot === true) {
      try {
        domSections.push(
          renderDomFieldMap({
            file: f.file,
            bytes: f.bytes,
            sourceRun: f.source_run,
            map: buildDomFieldMap(await readFile(join(input.fixturesDir, f.file), "utf8")),
          }),
        );
      } catch (cause) {
        domSections.push(
          `## \`${f.file}\` — rendered DOM snapshot\n\n` +
            `_this snapshot could not be re-read for the field map: ${String(cause)}_\n`,
        );
      }
      continue;
    }
    let map: FieldMap | null = null;
    let note: string | undefined;
    try {
      map = buildFieldMap(JSON.parse(await readFile(join(input.fixturesDir, f.file), "utf8")), input.probes, {
        ...(input.sessionUrns === undefined ? {} : { selfValues: input.sessionUrns }),
      });
    } catch (cause) {
      note = `this fixture could not be re-read for the field map: ${String(cause)}`;
    }
    sections.push({
      file: f.file,
      path: f.path,
      queryId: f.query_id,
      status: f.status,
      bytes: f.bytes,
      shapeHash: f.shape_hash,
      sourceRun: f.source_run,
      subjectMatch: f.subject_match ?? null,
      map,
      ...(note === undefined ? {} : { note }),
    });
  }

  try {
    await writeFile(
      fieldMapPath,
      renderFieldMap({
        capability: input.capability,
        generatedAt: now().toISOString(),
        fixtures: sections,
        domSections,
      }),
      "utf8",
    );
  } catch (cause) {
    throw failed(`writing ${fieldMapPath}`, cause);
  }

  return {
    fixturesDir: input.fixturesDir,
    indexPath,
    fieldMapPath,
    promoted,
    total: merged.fixtures.length,
    skipped,
    unreadable,
  };
}
