import { RawArchive } from "../archive/raw.js";
import { sessionUrnsOf, sessionVanitiesOf } from "../../capabilities/profile.capture/identity.js";
import { isPrivateEndpoint } from "./promote.js";

/**
 * Collect session identity one archived body at a time for fixture mapping.
 * Shared promotion never reads D118-private bodies. A private family may name
 * its own eligible endpoint/document predicate, which is the same explicit
 * boundary used for private promotion rather than a deny-list override.
 */
export async function collectFixtureSessionIdentity(
  archiveDir: string,
  options: { eligiblePrivateEndpoint?: (url: string) => boolean } = {},
): Promise<{ urns: string[]; vanities: string[] }> {
  const archive = new RawArchive(archiveDir);
  const urns = new Set<string>();
  const vanities = new Set<string>();
  for (const entry of await archive.list()) {
    if (isPrivateEndpoint(entry.url) && !options.eligiblePrivateEndpoint?.(entry.url)) continue;
    try {
      const one = [{ url: entry.url, body: await archive.readText(entry) }];
      for (const urn of sessionUrnsOf(one)) urns.add(urn);
      for (const vanity of sessionVanitiesOf(one)) vanities.add(vanity);
    } catch {
      // An unreadable body costs identity marking, not the promotion. The
      // archive/promoter reports unreadable entries on its own result.
    }
  }
  return { urns: [...urns], vanities: [...vanities] };
}
