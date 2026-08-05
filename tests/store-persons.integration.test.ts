import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Stored } from "../src/core/run/receipt.js";
import { getStore, type StoreClient } from "../src/core/store/client.js";
import { readStoreConfig } from "../src/core/store/config.js";
import { TABLES } from "../src/core/store/constants.js";
import { isFresh } from "../src/core/store/freshness.js";
import { findPersonByUrn, findPersonByVanity, upsertPerson } from "../src/core/store/persons.js";

/**
 * Integration: needs the local Supabase stack (`npm run db:start`). Skips with a
 * message when it is not reachable, so the suite stays green on a laptop with Docker
 * off. Touches only rows whose urn starts with the test prefix below, and deletes
 * them afterwards.
 */

const PREFIX = "urn:li:fsd_profile:ITTEST-";
const config = readStoreConfig();

async function reachable(): Promise<boolean> {
  if (!config) return false;
  try {
    const res = await fetch(`${config.url}/rest/v1/`, {
      headers: { apikey: config.serviceRoleKey },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok || res.status === 400;
  } catch {
    return false;
  }
}

const up = await reachable();
const why = config
  ? `local Supabase is not reachable at ${config.url}`
  : "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set";
if (!up) {
  // Written straight to stderr, not console.warn: this runs at collection time, and
  // vitest only surfaces console output from inside a test. The reason is also in the
  // suite name below, so it shows up in the reporter's skipped list either way.
  process.stderr.write(
    `\n[skip] store integration tests — ${why}. Start it with \`npm run db:start\`.\n`,
  );
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 8, 12, 0, 0);
let client: StoreClient;
let n = 0;
const urn = () => `${PREFIX}${process.pid}-${++n}`;

async function cleanup(): Promise<void> {
  if (!up) return;
  await client.from(TABLES.personExperience).delete().like("person_urn", `${PREFIX}%`);
  await client.from(TABLES.persons).delete().like("urn", `${PREFIX}%`);
}

describe.skipIf(!up)(up ? "store against local Supabase" : `store against local Supabase (skipped — ${why})`, () => {
  beforeEach(async () => {
    client = getStore();
    await cleanup();
  });
  afterAll(cleanup);

  const opts = (now = T0) => ({ client, now });

  it("inserts a person, stamping last_seen from the caller's clock", async () => {
    const u = urn();
    const result = await upsertPerson({ person: { urn: u, name: "A", vanity: "vanity-a" } }, opts());
    expect(result.rows).toBe(1);

    const found = await findPersonByUrn(u, { client });
    expect(found?.person.name).toBe("A");
    expect(Date.parse(found!.person.last_seen)).toBe(T0);
    // first_seen is the database's own default and is never sent — an upsert that
    // carried it would overwrite it on every re-scrape.
    expect(Number.isFinite(Date.parse(found!.person.first_seen))).toBe(true);
  });

  it("bumps last_seen and leaves first_seen where it was", async () => {
    const u = urn();
    await upsertPerson({ person: { urn: u, name: "A" } }, opts());
    const inserted = (await findPersonByUrn(u, { client }))!.person.first_seen;
    await upsertPerson({ person: { urn: u, name: "A renamed" } }, opts(T0 + 3 * HOUR));

    const found = await findPersonByUrn(u, { client });
    expect(found!.person.first_seen).toBe(inserted);
    expect(Date.parse(found!.person.last_seen)).toBe(T0 + 3 * HOUR);
    expect(found!.person.name).toBe("A renamed");
  });

  it("leaves an omitted field alone and clears an explicit null", async () => {
    const u = urn();
    await upsertPerson({ person: { urn: u, name: "A", headline: "CTO", location: "Lahore" } }, opts());
    await upsertPerson({ person: { urn: u, location: null } }, opts(T0 + HOUR));

    const found = await findPersonByUrn(u, { client });
    expect(found!.person.headline).toBe("CTO");
    expect(found!.person.location).toBeNull();
  });

  it("collapses a re-scraped experience row onto itself, nulls and all", async () => {
    const u = urn();
    const experience = [
      { company_urn: "1234", company_name: "Acme", title: "Founder", started_on: "2020-01-01", is_current: true },
      // Every part of the natural key null but the person — the case the
      // `nulls not distinct` index exists for.
      { company_name: null, title: null, started_on: null },
    ];
    const first = await upsertPerson({ person: { urn: u }, experience }, opts());
    const before = (await findPersonByUrn(u, { client }))!.experience.find((e) => e.company_urn === "1234")!;
    const second = await upsertPerson({ person: { urn: u }, experience }, opts(T0 + HOUR));

    expect(first.experience).toEqual({ upserted: 2, removed: 0 });
    expect(second.experience).toEqual({ upserted: 2, removed: 0 });

    const found = await findPersonByUrn(u, { client });
    expect(found!.experience).toHaveLength(2);
    const acme = found!.experience.find((e) => e.company_urn === "1234")!;
    expect(acme.id).toBe(before.id);
    expect(acme.first_seen).toBe(before.first_seen);
    expect(Date.parse(acme.last_seen)).toBe(T0 + HOUR);
  });

  it("replaces experience: keeps what is still listed, deletes what is not", async () => {
    const u = urn();
    await upsertPerson(
      {
        person: { urn: u },
        experience: [
          { company_name: "Acme", title: "Founder" },
          { company_name: "Old Co", title: "Intern" },
        ],
      },
      opts(),
    );
    const kept = (await findPersonByUrn(u, { client }))!.experience.find((e) => e.company_name === "Acme")!;

    const result = await upsertPerson(
      {
        person: { urn: u },
        experience: [
          { company_name: "Acme", title: "Founder" },
          { company_name: "New Co", title: "CTO" },
        ],
      },
      opts(T0 + HOUR),
    );
    expect(result.experience).toEqual({ upserted: 2, removed: 1 });

    const found = await findPersonByUrn(u, { client });
    expect(found!.experience.map((e) => e.company_name).sort()).toEqual(["Acme", "New Co"]);
    // The surviving row is the same row, not a re-insert: its id and first_seen held.
    const stillAcme = found!.experience.find((e) => e.company_name === "Acme")!;
    expect(stillAcme.id).toBe(kept.id);
    expect(stillAcme.first_seen).toBe(kept.first_seen);
  });

  it("clears experience with [] and touches nothing when experience is omitted", async () => {
    const u = urn();
    await upsertPerson({ person: { urn: u }, experience: [{ company_name: "Acme" }] }, opts());

    await upsertPerson({ person: { urn: u } }, opts(T0 + HOUR));
    expect((await findPersonByUrn(u, { client }))!.experience).toHaveLength(1);

    const cleared = await upsertPerson({ person: { urn: u }, experience: [] }, opts(T0 + 2 * HOUR));
    expect(cleared.experience).toEqual({ upserted: 0, removed: 1 });
    expect((await findPersonByUrn(u, { client }))!.experience).toHaveLength(0);
  });

  it("converges when a retry re-sends rows that already landed", async () => {
    const u = urn();
    const input = {
      person: { urn: u, name: "A" },
      experience: [{ company_name: "Acme", title: "Founder" }, { company_name: "Old Co" }],
    };
    // Step 1 landed, then imagine steps 2 and 3 failed; the retry re-sends everything.
    await upsertPerson({ person: input.person }, opts());
    const retry = await upsertPerson(input, opts(T0 + HOUR));
    const again = await upsertPerson(input, opts(T0 + 2 * HOUR));

    expect(retry.experience.upserted).toBe(2);
    expect(again.experience).toEqual({ upserted: 2, removed: 0 });
    const found = await findPersonByUrn(u, { client });
    expect(found!.experience).toHaveLength(2);
    const { count } = await client
      .from(TABLES.persons)
      .select("urn", { count: "exact", head: true })
      .eq("urn", u);
    expect(count).toBe(1);
  });

  it("leaves a never-stored person absent when the experience write is rejected", async () => {
    const u = urn();
    const err = await upsertPerson(
      // A real rejection from the real database: `started_on` is a date column.
      { person: { urn: u, name: "A" }, experience: [{ company_name: "Acme", started_on: "not-a-date" }] },
      opts(),
    ).catch((e) => e);

    expect(err.code).toBe("STORE_WRITE_REJECTED");
    expect(err.retryable).toBe(false);
    expect(err.stored).toBe(0);
    // Nothing exists, so nothing can look fresh. The next run re-fetches.
    expect(await findPersonByUrn(u, { client })).toBeNull();
  });

  it("leaves an already-stored person stale when the experience write is rejected", async () => {
    const u = urn();
    const old = T0 - 10 * 24 * HOUR;
    await upsertPerson({ person: { urn: u, name: "A" } }, opts(old));

    await upsertPerson(
      { person: { urn: u, name: "A" }, experience: [{ company_name: "Acme", started_on: "not-a-date" }] },
      opts(),
    ).catch((e) => e);

    const found = await findPersonByUrn(u, { client });
    // last_seen did not move, so the record still reads stale and gets re-fetched
    // instead of a half-written record being served for a whole --max-age window.
    expect(Date.parse(found!.person.last_seen)).toBe(old);
    expect(isFresh(found!.person.last_seen, 7 * 24 * HOUR, T0)).toBe(false);
  });

  it("looks a person up by urn, with experience ordered current-first", async () => {
    const u = urn();
    await upsertPerson(
      {
        person: { urn: u },
        experience: [
          { company_name: "Old Co", started_on: "2015-01-01" },
          { company_name: "Acme", started_on: "2020-01-01", is_current: true },
        ],
      },
      opts(),
    );
    const found = await findPersonByUrn(u, { client });
    expect(found!.experience.map((e) => e.company_name)).toEqual(["Acme", "Old Co"]);

    expect(await findPersonByUrn(`${PREFIX}nobody`, { client })).toBeNull();
  });

  it("looks a person up by vanity, newest first, and says how many matched", async () => {
    const older = urn();
    const newer = urn();
    await upsertPerson({ person: { urn: older, vanity: "shared-handle", name: "Older" } }, opts());
    await upsertPerson({ person: { urn: newer, vanity: "shared-handle", name: "Newer" } }, opts(T0 + HOUR));

    const found = await findPersonByVanity("shared-handle", { client });
    expect(found!.person.urn).toBe(newer);
    // Vanity is reassignable, so the lookup reports the ambiguity rather than hiding it.
    expect(found!.vanityMatches).toBe(2);

    expect(await findPersonByVanity("no-such-handle", { client })).toBeNull();
  });

  it("skips the experience read when the caller only needs freshness", async () => {
    const u = urn();
    await upsertPerson({ person: { urn: u }, experience: [{ company_name: "Acme" }] }, opts());
    const found = await findPersonByUrn(u, { client, withExperience: false });
    expect(found!.experience).toEqual([]);
    // The freshness decision the capability actually makes, against a real row.
    expect(isFresh(found!.person.last_seen, 7 * 24 * HOUR, T0 + HOUR)).toBe(true);
    expect(isFresh(found!.person.last_seen, 7 * 24 * HOUR, T0 + 8 * 24 * HOUR)).toBe(false);
  });

  it("produces counts the receipt's stored field can carry", async () => {
    const u = urn();
    const result = await upsertPerson(
      { person: { urn: u }, experience: [{ company_name: "Acme" }] },
      opts(),
    );
    // Compile-time: the upsert result is what a receipt's `stored` needs (D3).
    const stored: Stored = { table: TABLES.persons, run_ref: "01RUN", rows: result.rows };
    expect(stored.rows).toBe(2);
  });
});
