import { documentPattern, type TieredPattern } from "../profile.capture/patterns.js";
import { SALESNAV_PATTERNS } from "../salesnav.probe/patterns.js";
import { SALESNAV_HOME_URL, SAVED_SEARCHES_DOCUMENT_PATTERN } from "./constants.js";

export const SAVED_SEARCHES_PATTERNS: readonly TieredPattern[] = [
  ...SALESNAV_PATTERNS,
  documentPattern(SALESNAV_HOME_URL, SAVED_SEARCHES_DOCUMENT_PATTERN),
];

/** Endpoint identity plus the measured envelope. The positive bodies contain
 * neither `savedSearch` nor a saved-search urn, so a marker-only predicate
 * reports a 1-row response as empty. D407's lesson applies here too: choose a
 * body by the endpoint that names it, then validate its envelope. */
export function carriesSavedSearchPayload(body: string, rawUrl: string): boolean {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (!/\/sales-api\/salesApiSavedSearchesV2$/i.test(url.pathname)) return false;
  try {
    const root = JSON.parse(body) as Record<string, unknown>;
    return Array.isArray(root["elements"]);
  } catch {
    return false;
  }
}
