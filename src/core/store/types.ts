/**
 * Row types for the §7 tables this module writes, matching the Task 13 migration
 * (`supabase/migrations/20260808120000_m1_m3_schema.sql`). Timestamps are the ISO
 * strings PostgREST returns, not `Date`s.
 */

export type PersonRow = {
  urn: string;
  vanity: string | null;
  name: string | null;
  headline: string | null;
  location: string | null;
  current_company_urn: string | null;
  first_seen: string;
  last_seen: string;
};

export type PersonExperienceRow = {
  id: number;
  person_urn: string;
  company_urn: string | null;
  company_name: string | null;
  title: string | null;
  /** `date`, not `timestamptz`: `YYYY-MM-DD`. */
  started_on: string | null;
  ended_on: string | null;
  is_current: boolean;
  first_seen: string;
  last_seen: string;
};

/**
 * What a parser hands the store for one person.
 *
 * `undefined` and `null` mean different things and the difference is load-bearing:
 * an **omitted** field is one this capture said nothing about and the stored value
 * is left alone; an explicit **null** is "we looked and there is nothing" and
 * overwrites. A parser that cannot tell the two apart must omit.
 */
export type PersonInput = {
  urn: string;
  vanity?: string | null;
  name?: string | null;
  headline?: string | null;
  location?: string | null;
  current_company_urn?: string | null;
};

/** One employment row. Every field but the person is optional — past employers are
 *  routinely unlinked and carry no urn at all. */
export type ExperienceInput = {
  company_urn?: string | null;
  company_name?: string | null;
  title?: string | null;
  started_on?: string | null;
  ended_on?: string | null;
  is_current?: boolean;
};

/** A person as it exists in the store, with its employment history. */
export type StoredPerson = {
  person: PersonRow;
  experience: PersonExperienceRow[];
  /** Only set by the vanity lookup, which can match more than one person: vanity
   *  URLs are reassignable and are not unique in the schema. 1 means unambiguous. */
  vanityMatches?: number;
};

export type PersonUpsertResult = {
  urn: string;
  /** Rows written, for the receipt's `stored.rows` (D3). */
  rows: number;
  experience: {
    upserted: number;
    /** Stale rows deleted because this capture no longer lists them. Always 0 when
     *  the caller omitted `experience` — see `upsertPerson`. */
    removed: number;
  };
};

export type JobInput = {
  id: string;
  company_urn?: string | null;
  title?: string | null;
  location?: string | null;
  posted_at?: string | null;
  workplace_type?: string | null;
  description?: string | null;
};

export type JobUpsertResult = { id: string; rows: 1 };
