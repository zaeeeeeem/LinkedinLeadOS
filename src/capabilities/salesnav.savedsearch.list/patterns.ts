import { documentPattern, type TieredPattern } from "../profile.capture/patterns.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import { SALESNAV_HOME_URL, SAVED_SEARCHES_DOCUMENT_PATTERN } from "./constants.js";

export const SAVED_SEARCHES_PATTERNS: readonly TieredPattern[] = [
  ...SALESNAV_PATTERNS,
  documentPattern(SALESNAV_HOME_URL, SAVED_SEARCHES_DOCUMENT_PATTERN),
];

/** A deliberately broad probe marker. The endpoint identity and exact field
 * paths are measured from the first archived body before the parser exists. */
export function isSavedSearchIsh(body: string): boolean {
  return /savedSearch|fs_salesSavedSearch/i.test(body);
}

