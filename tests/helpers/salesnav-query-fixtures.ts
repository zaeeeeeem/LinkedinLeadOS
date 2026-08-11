import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT,
  loadSalesNavArchiveFixtureManifest,
  rawUrlParam,
} from "../../src/core/salesnav-query/index.js";

export const VOCABULARY_FIXTURE_RUNS = [
  "01KZQCS8XZDDYSDGMT5SB81YBS",
  "01KZQFCFMVYKAC082JXDRVCAN3",
  "01KZQ5TXC23T3FFBJ72P8CE85J",
  "01KZP693DEWVP0S90K7C7XQ997",
  "01KZQNM34D61NTBDQNDVSZ45AV",
] as const;

export const SEARCH_FIXTURE_RUNS = [
  "01KZQFCFMVYKAC082JXDRVCAN3",
  "01KZQ5TXC23T3FFBJ72P8CE85J",
  "01KZP693DEWVP0S90K7C7XQ997",
  "01KZQNM34D61NTBDQNDVSZ45AV",
] as const;

export function fixtureMeta(runId: string, archiveId: string): { status: number; url: string } {
  loadSalesNavArchiveFixtureManifest();
  return JSON.parse(readFileSync(join(
    SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, runId, "raw", `${archiveId}.meta.json`,
  ), "utf8")) as { status: number; url: string };
}

export function fixtureSearchUrls(): string[] {
  loadSalesNavArchiveFixtureManifest();
  const out: string[] = [];
  for (const runId of SEARCH_FIXTURE_RUNS) {
    const raw = join(SALESNAV_QUERY_ARCHIVE_FIXTURE_ROOT, runId, "raw");
    for (const file of readdirSync(raw).filter((candidate) => candidate.endsWith(".meta.json"))) {
      const metadata = JSON.parse(readFileSync(join(raw, file), "utf8")) as { url?: string };
      let pathname: string;
      try { pathname = new URL(metadata.url ?? "", "https://www.linkedin.com").pathname; } catch { continue; }
      if (/\/sales-api\/salesApi(?:LeadSearch|AccountSearch)$/i.test(pathname)) out.push(metadata.url!);
    }
  }
  return out;
}

export function fixtureQueries(): string[] {
  return fixtureSearchUrls().flatMap((url) => {
    const query = rawUrlParam(url, "query");
    return query === null ? [] : [query];
  });
}
