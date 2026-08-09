import { isProfileIsh } from "../../capabilities/profile.capture/patterns.js";
import { normalizeProfileUrl } from "../../capabilities/profile.capture/url.js";
import { JOB_FIELD_PROBES, isJobIsh } from "../../capabilities/job.capture/patterns.js";
import { normalizeJobUrl } from "../../capabilities/job.capture/url.js";
import type { FieldProbe } from "./fieldmap.js";
import type { PromoteSubject } from "./promote.js";
import { buildDomFieldMap, renderDomFieldMap } from "./dommap.js";
import { buildJobDomFieldMap, renderJobDomFieldMap } from "./job-dommap.js";

/**
 * Which page surface a capability's fixtures come from, and the three things
 * that differ per surface when an archive is promoted (§6):
 *
 * 1. how the run's own recorded url is read back into a **subject**,
 * 2. what counts as a **relevant** body,
 * 3. which **field probes** the generated map is built with.
 *
 * Everything else about promotion is shared, including the exclusions that have
 * no override — private endpoints are never promoted on any surface (D118).
 *
 * Derived from the capability name so a new reader inside an existing family
 * needs no entry here. An unrecognized name falls back to the profile
 * behaviour, which is the conservative direction: every filter stays at least
 * as tight as it was, and a mis-typed `--capability` promotes less rather than
 * more.
 */
export type Family = "profile" | "job";

export function familyOf(capability: string): Family {
  return capability.startsWith("job.") ? "job" : "profile";
}

/** What counts as a body worth promoting, per family. */
export function relevanceOf(family: Family): (body: string) => boolean {
  return family === "job" ? isJobIsh : isProfileIsh;
}

/** Which field probes the generated map is built with. `undefined` keeps
 *  `buildFieldMap`'s own default, which is the profile set. */
export function probesOf(family: Family): readonly FieldProbe[] | undefined {
  return family === "job" ? JOB_FIELD_PROBES : undefined;
}

/** DOM snapshots are surface-specific too. Profile card refs have no meaning on
 * a job SDUI document; job scope is the normalized URL plus job-posting urn and
 * its content anchors are data-testid attributes (D305). */
export function domMapOf(family: Family, html: string) {
  return family === "job" ? buildJobDomFieldMap(html) : buildDomFieldMap(html);
}

export function renderDomMapOf(
  family: Family,
  o: { file: string; bytes: number; sourceRun: string; map: unknown },
): string {
  return family === "job"
    ? renderJobDomFieldMap({ ...o, map: o.map as ReturnType<typeof buildJobDomFieldMap> })
    : renderDomFieldMap({ ...o, map: o.map as ReturnType<typeof buildDomFieldMap> });
}

/**
 * Turns a run's own url into the subject its fixtures must name.
 *
 * `null` for anything unrecognizable, and the caller reports that rather than
 * guessing: promoting with no subject falls back to "any relevant body", which
 * is the behaviour that filled the fixture set with the operator's own inbox
 * (D118).
 */
export function subjectFor(family: Family, raw: string): PromoteSubject | null {
  if (family === "job") {
    // A posting has no vanity slug. Both spellings are supplied because bodies
    // use both: the canonical urn, and the bare numeric id inside urls and
    // tracking blobs (D260).
    //
    // `namesSubject` matches a subject urn as a plain substring, so the bare id
    // here also fires on any longer digit run containing it. That is left as-is:
    // promotion errs toward keeping a body, and an extra fixture is cheap. Where
    // the same question decides *scope* rather than inclusion — the company-urn
    // sweep — it is asked with digit boundaries instead (`namesJob`).
    try {
      const target = normalizeJobUrl(raw);
      return { urns: [target.urn, target.id] };
    } catch {
      return null;
    }
  }

  try {
    const target = normalizeProfileUrl(raw);
    // A Sales Navigator lead has no vanity slug; its member id is what every
    // body naming that person carries instead.
    if (target.vanity !== undefined) return { vanity: target.vanity };
    return target.leadId === undefined ? null : { urns: [target.leadId] };
  } catch {
    // Already a bare slug, most likely — `--subject=tankots`.
    return /^[a-z0-9-]{3,100}$/i.test(raw) ? { vanity: raw } : null;
  }
}
