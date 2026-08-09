import { personUrnsIn } from "../../core/fixtures/promote.js";
import { sessionUrnsOf } from "../profile.capture/identity.js";
import type { IdentityCapture } from "../profile.capture/identity.js";
import type { JobTarget } from "./url.js";

/**
 * Who and what this job capture is of.
 *
 * Two identities matter on a posting and they fail differently.
 *
 * **The posting itself** is known before the load — the operator named it, and
 * `normalizeJobUrl` canonicalized it (D260). So the question here is not "what
 * is the id" but the check that matters: *did the page actually serve the
 * posting we asked for?* A capture whose bodies never name the target id is a
 * capture of some other job, and promoting it would file a stranger's posting
 * under the requested id.
 *
 * **The hiring company's urn** is not known in advance and is not guessed. The
 * sweep is scoped to bodies that name the subject posting, because a job page
 * carries "similar jobs" from other companies and an unscoped sweep collects
 * them — the same trap as D118/D121, one surface along. Even scoped, more than
 * one candidate resolves **nothing**: this probe measures, and Task 31 resolves
 * the urn by a path from the FIELD-MAP rather than by a regex sweep.
 *
 * Session identity is checked with `sessionUrnsOf` — the one implementation,
 * never a second one (D119, D126). The operator's own urns appear in tracking
 * on every page, so a person urn found here that is theirs is noise, and one
 * that is *not* theirs is a real person on the posting (a recruiter, a poster)
 * whose presence is worth reporting before anything downstream keys on it.
 */

/** A company urn, in the spellings §7 keys companies on. */
const COMPANY_URN = /urn:li:(?:fsd_company|fs_normalized_company|company):[A-Za-z0-9_-]+/g;

/** Every company urn a body names, deduped. */
export function companyUrnsIn(body: string): string[] {
  return [...new Set(body.match(COMPANY_URN) ?? [])];
}

export type JobIdentityFinding = {
  /** Captured bodies that name the target posting, by id or by urn. Zero means
   *  the page did not serve the job that was asked for. */
  subjectBodies: number;
  /** True when the archived DOM snapshot names the target posting. */
  subjectInSnapshot: boolean;
  /** Distinct company urns found across subject-naming bodies. */
  companyCandidates: number;
  /** True only when exactly one candidate was found. Never a guess: a page with
   *  two candidate employers resolves none. */
  companyResolved: boolean;
  /** The urn family only, e.g. `urn:li:fsd_company`. Never the id — that is
   *  captured data and receipts go to stdout (§4.1, D3). */
  companyUrnKind: string | null;
  /** Distinct person urns seen in subject-naming bodies. */
  personUrns: number;
  /** How many of those are the logged-in operator's own. Expected to be
   *  non-zero — LinkedIn puts the session's identity in tracking on every page
   *  (D119) — which is exactly why it is reported rather than filtered silently. */
  personUrnsThatAreSession: number;
  /** Person urns that are *not* the session's: real people on the posting. */
  personUrnsThatAreOthers: number;
  /** Size of the session identity set this was checked against. Zero means the
   *  check could not actually run and its answers prove nothing. */
  sessionUrns: number;
};

/** True when a body names this posting — by canonical urn or by bare id. The
 *  bare id is a 5–20 digit run, specific enough that a false positive would
 *  need another number of the same length in the same body. */
export function namesJob(body: string, target: JobTarget): boolean {
  const haystack = body.toLowerCase();
  return haystack.includes(target.urn.toLowerCase()) || haystack.includes(target.id);
}

/**
 * Resolves what this capture knows about its subject. Pure and total: no I/O,
 * and a run that captured nothing returns zeros rather than throwing.
 */
export function checkJobIdentity(o: {
  captures: readonly IdentityCapture[];
  target: JobTarget;
  snapshotHtml: string | null;
  /** Precomputed session urns. Omitted, they are derived with `sessionUrnsOf`
   *  from the same captures — never re-implemented here (D119). */
  sessionUrns?: readonly string[];
}): JobIdentityFinding {
  const session = new Set(o.sessionUrns ?? sessionUrnsOf(o.captures));
  const subjectBodies = o.captures.filter((c) => namesJob(c.body, o.target));

  const companies = new Set<string>();
  const persons = new Set<string>();
  for (const capture of subjectBodies) {
    for (const urn of companyUrnsIn(capture.body)) companies.add(urn);
    for (const urn of personUrnsIn(capture.body)) persons.add(urn);
  }

  const only = companies.size === 1 ? [...companies][0]! : null;
  const mine = [...persons].filter((u) => session.has(u)).length;

  return {
    subjectBodies: subjectBodies.length,
    subjectInSnapshot: o.snapshotHtml !== null && namesJob(o.snapshotHtml, o.target),
    companyCandidates: companies.size,
    companyResolved: only !== null,
    companyUrnKind: only === null ? null : only.slice(0, only.lastIndexOf(":")),
    personUrns: persons.size,
    personUrnsThatAreSession: mine,
    personUrnsThatAreOthers: persons.size - mine,
    sessionUrns: session.size,
  };
}
