import { CapabilityError } from "../run/receipt.js";
import { getStore, storeError, type StoreClient } from "./client.js";
import { TABLES } from "./constants.js";
import type {
  ExperienceInput,
  PersonExperienceRow,
  PersonInput,
  PersonRow,
  PersonUpsertResult,
  StoredPerson,
} from "./types.js";

/**
 * The write path for person data (D3: bulk data in the store, receipts on stdout).
 * Reads here are the toolkit's own lookups — the agent still queries Supabase
 * directly (D4), and nothing in this file is a query wrapper for it.
 */

/** The upsert target on `person_experience`, matching the `nulls not distinct`
 *  unique index the migration creates. Order must match the index. */
const EXPERIENCE_CONFLICT_TARGET = "person_urn,company_urn,company_name,title,started_on";

/**
 * A write failure that also says how many rows had already landed.
 *
 * `upsertPerson` is three requests, not one transaction, so a failure can leave the
 * store partly written. The receipt's `partial.stored` field exists for exactly this,
 * and a receipt claiming counts it did not achieve is worse than a failed run.
 */
export class StoreWriteError extends CapabilityError {
  readonly stored: number;

  constructor(base: CapabilityError, stored: number) {
    super({
      code: base.code,
      exit: base.exit,
      action: base.action,
      retryable: base.retryable,
      message: base.message,
      evidence: base.evidence,
      retryAfterMs: base.retryAfterMs,
    });
    this.name = "StoreWriteError";
    this.stored = stored;
    const cause = (base as { cause?: unknown }).cause;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, enumerable: false, configurable: true });
    }
  }
}

/** Drops keys the capture said nothing about, keeping explicit nulls. */
function compact<T extends object>(o: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

export type StoreOpts = { client?: StoreClient; now?: number };

/**
 * Upserts one person, keyed on urn, bumping `last_seen`, and — when `experience` is
 * given — replacing that person's employment rows.
 *
 * **`experience` omitted vs. empty.** Omitted means this capture said nothing about
 * employment and no experience row is read, written or deleted. `[]` means the
 * capture looked and found none, and clears what is stored.
 *
 * **What is in the store if this throws.** Three requests run in order, each one
 * atomic on its own (PostgREST wraps a request in a transaction, so a 200-row insert
 * never half-lands *within* a request). Between them:
 *
 * 1. experience upsert fails → nothing written; the person's `last_seen` is untouched.
 * 2. delete fails → the new experience rows are stored alongside stale ones this
 *    capture no longer lists; `last_seen` is still untouched.
 * 3. person fails → every experience row is correct, but the person row is unchanged
 *    (or, for a person never stored before, absent — which `findPersonByUrn` returns
 *    as null).
 *
 * Two properties decide that order, and both are load-bearing (D101):
 *
 * - **Only ever extra rows, never missing ones.** Deleting before the new rows land
 *   would destroy employment history the store had and this run cannot replace.
 * - **`last_seen` lands last.** It is the record's claim to be complete as of that
 *   instant, and `isFresh` reads it to decide whether to serve from the store instead
 *   of loading the page. Bumping it first means a failure at step 2 or 3 leaves a
 *   record that is incomplete *and* looks fresh, so the next run serves the damage
 *   and never re-fetches it — for a whole `--max-age` window. Written last, every
 *   failure above leaves the person stale, so the next run re-fetches and repairs.
 *
 * `StoreWriteError.stored` carries the count that actually landed, for the receipt.
 *
 * **Two clocks, deliberately.** `last_seen` is stamped from `opts.now` (the caller's
 * clock, injectable so freshness is testable); `first_seen` is never sent and stays
 * the database default, because a column included in an upsert payload is also
 * updated on conflict — sending `first_seen` would reset it on every re-scrape.
 *
 * **Retrying is safe at every one of those points.** Both writes are upserts on a
 * declared conflict target — the person on `urn`, experience on the natural-key index
 * — so re-sending rows that already landed updates them in place instead of
 * duplicating, and the delete is computed from the ids the retry itself wrote.
 */
export async function upsertPerson(
  input: { person: PersonInput; experience?: ExperienceInput[] },
  opts: StoreOpts = {},
): Promise<PersonUpsertResult> {
  const client = opts.client ?? getStore();
  const stamp = new Date(opts.now ?? Date.now()).toISOString();
  const urn = input.person.urn;
  let stored = 0;
  let removedCount = 0;
  let keptIds: number[] = [];

  if (input.experience !== undefined && input.experience.length > 0) {
    const rows = input.experience.map((e) => ({
      person_urn: urn,
      company_urn: e.company_urn ?? null,
      company_name: e.company_name ?? null,
      title: e.title ?? null,
      started_on: e.started_on ?? null,
      ended_on: e.ended_on ?? null,
      is_current: e.is_current ?? false,
      last_seen: stamp,
    }));
    const written = await client
      .from(TABLES.personExperience)
      .upsert(rows, { onConflict: EXPERIENCE_CONFLICT_TARGET })
      .select("id");
    if (written.error) {
      throw new StoreWriteError(
        storeError({
          op: "upsert experience",
          table: TABLES.personExperience,
          kind: "write",
          status: written.status,
          cause: written.error,
        }),
        stored,
      );
    }
    keptIds = (written.data ?? []).map((r) => (r as { id: number }).id);
    stored += keptIds.length;
  }

  if (input.experience !== undefined) {
    let del = client.from(TABLES.personExperience).delete().eq("person_urn", urn);
    if (keptIds.length > 0) del = del.not("id", "in", `(${keptIds.join(",")})`);
    const removed = await del.select("id");
    if (removed.error) {
      throw new StoreWriteError(
        storeError({
          op: "delete stale experience",
          table: TABLES.personExperience,
          kind: "write",
          status: removed.status,
          cause: removed.error,
        }),
        stored,
      );
    }
    removedCount = (removed.data ?? []).length;
  }

  // Last, and only now: the person row, whose last_seen is the claim "this record
  // is complete as of this instant". Everything it describes is already written.
  const person = await client
    .from(TABLES.persons)
    .upsert({ ...compact(input.person), last_seen: stamp }, { onConflict: "urn" })
    .select("urn");
  if (person.error) {
    throw new StoreWriteError(
      storeError({ op: "upsert person", table: TABLES.persons, kind: "write", status: person.status, cause: person.error }),
      stored,
    );
  }
  stored += 1;

  return {
    urn,
    rows: stored,
    experience: { upserted: keptIds.length, removed: removedCount },
  };
}

async function readExperience(
  client: StoreClient,
  personUrn: string,
): Promise<PersonExperienceRow[]> {
  const res = await client
    .from(TABLES.personExperience)
    .select("*")
    .eq("person_urn", personUrn)
    .order("is_current", { ascending: false })
    .order("started_on", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });
  if (res.error) {
    throw storeError({
      op: "select experience",
      table: TABLES.personExperience,
      kind: "read",
      status: res.status,
      cause: res.error,
    });
  }
  return (res.data ?? []) as PersonExperienceRow[];
}

/** The person with this urn, or null. This is the lookup the freshness check uses. */
export async function findPersonByUrn(
  urn: string,
  opts: StoreOpts & { withExperience?: boolean } = {},
): Promise<StoredPerson | null> {
  const client = opts.client ?? getStore();
  const res = await client.from(TABLES.persons).select("*").eq("urn", urn).maybeSingle();
  if (res.error) {
    throw storeError({ op: "select person by urn", table: TABLES.persons, kind: "read", status: res.status, cause: res.error });
  }
  if (!res.data) return null;
  const person = res.data as PersonRow;
  const experience = opts.withExperience === false ? [] : await readExperience(client, person.urn);
  return { person, experience };
}

/**
 * The person whose vanity URL is this, most recently seen first.
 *
 * `vanity` is deliberately not unique in the schema: LinkedIn reassigns vanity URLs,
 * so two profiles can hold the same string at different times. This returns the most
 * recently seen match and reports how many there were in `vanityMatches` — anything
 * above 1 means the caller is looking at a reused handle and should resolve by urn.
 */
export async function findPersonByVanity(
  vanity: string,
  opts: StoreOpts & { withExperience?: boolean } = {},
): Promise<StoredPerson | null> {
  const client = opts.client ?? getStore();
  const res = await client
    .from(TABLES.persons)
    .select("*", { count: "exact" })
    .eq("vanity", vanity)
    .order("last_seen", { ascending: false })
    .limit(1);
  if (res.error) {
    throw storeError({ op: "select person by vanity", table: TABLES.persons, kind: "read", status: res.status, cause: res.error });
  }
  const rows = (res.data ?? []) as PersonRow[];
  const person = rows[0];
  if (!person) return null;
  const experience = opts.withExperience === false ? [] : await readExperience(client, person.urn);
  return { person, experience, vanityMatches: res.count ?? rows.length };
}
