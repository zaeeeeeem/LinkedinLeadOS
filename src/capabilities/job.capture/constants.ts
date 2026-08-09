import { SUBJECT_CONTAINER_MIN_TEXT } from "../profile.capture/constants.js";
import type { SnapshotContainer } from "../profile.capture/snapshot.js";

/**
 * Job-surface tunables. Everything that is a *pacing* number — scroll passes,
 * pauses, dwell, layout and capture timeouts — is deliberately **not** here: it
 * is shared with `profile.capture`, because pacing is a property of the one
 * account rather than of a page, and a second set of numbers would be a second
 * behavioural fingerprint to keep in step.
 */

/** How long the expander measurement's single `Runtime.evaluate` may take. It
 *  walks every element and calls `getComputedStyle` on each, which is slower
 *  than the snapshot's one serialization. */
export const EXPANDER_TIMEOUT_MS = 20_000;

/**
 * Whether a job page's main container rendered.
 *
 * Text only — deliberately *not* `<section>` count, which is what the profile
 * check adds. The profile page was measured to carry 23 sections (D115); the job
 * detail page has never been measured, and requiring a tag this build has not
 * seen there would raise "did not render" on a perfectly rendered page. The
 * section count is still reported, so the live run answers the question rather
 * than this constant assuming it.
 */
export function isJobPageRendered(container: SnapshotContainer): boolean {
  return container.selector !== null && container.textChars >= SUBJECT_CONTAINER_MIN_TEXT;
}
