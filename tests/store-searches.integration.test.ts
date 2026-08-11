import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getStore, type StoreClient } from "../src/core/store/client.js";
import { readStoreConfig } from "../src/core/store/config.js";
import { TABLES } from "../src/core/store/constants.js";
import { insertSearch, insertSearchResults } from "../src/core/store/searches.js";

const config = readStoreConfig();
async function reachable(): Promise<boolean> {
  if (!config) return false;
  try { const response = await fetch(`${config.url}/rest/v1/`, { headers: { apikey: config.serviceRoleKey }, signal: AbortSignal.timeout(2000) }); return response.ok || response.status === 400; }
  catch { return false; }
}
const up = await reachable();
const why = config ? `local Supabase is not reachable at ${config.url}` : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set";
if (!up) process.stderr.write(`\n[skip] search store integration tests — ${why}. Start it with \`npm run db:start\`.\n`);

const PREFIX = `ITTEST-SEARCH-${process.pid}-`;
let client: StoreClient;
let n = 0;
async function cleanup() {
  if (!up) return;
  await client.from(TABLES.searchResults).delete().like("search_id", `${PREFIX}%`);
  await client.from(TABLES.searches).delete().like("search_id", `${PREFIX}%`);
}

describe.skipIf(!up)(up ? "search store against local Supabase" : `search store against local Supabase (skipped — ${why})`, () => {
  beforeEach(async () => { client = getStore(); await cleanup(); });
  afterAll(cleanup);
  it("appends across searches, skips a resumed page, and leaves entity tables untouched", async () => {
    const personBefore = await client.from(TABLES.persons).select("urn", { count: "exact", head: true });
    const companyBefore = await client.from(TABLES.companies).select("urn", { count: "exact", head: true });
    const a = `${PREFIX}${++n}-a`; const b = `${PREFIX}${++n}-b`; const person = "urn:li:member:999999999999";
    await insertSearch({ search_id: a, kind: "sn_leads", filter_url: null, filter_json: null }, { client });
    await insertSearch({ search_id: b, kind: "sn_leads", filter_url: null, filter_json: null }, { client });
    await insertSearchResults([{ search_id: a, page: 1, position: 1, person_urn: person }], { client });
    await insertSearchResults([{ search_id: b, page: 1, position: 1, person_urn: person }], { client });
    expect(await insertSearchResults([{ search_id: a, page: 1, position: 1, person_urn: person }], { client })).toEqual({ rows: 0, skipped: 1 });
    const observations = await client.from(TABLES.searchResults).select("search_id").in("search_id", [a, b]);
    expect(observations.data).toHaveLength(2);
    expect((await client.from(TABLES.persons).select("urn", { count: "exact", head: true })).count).toBe(personBefore.count);
    expect((await client.from(TABLES.companies).select("urn", { count: "exact", head: true })).count).toBe(companyBefore.count);
  });
});
