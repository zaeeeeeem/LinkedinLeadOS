/**
 * The §7 tables this module writes. Named here rather than inline so a table
 * rename shows up as one edit and one failing test, not as a runtime 42P01.
 */
export const TABLES = {
  persons: "persons",
  personExperience: "person_experience",
} as const;

/** Env vars the store client reads. `.env.example` documents both. */
export const ENV = {
  url: "SUPABASE_URL",
  serviceRoleKey: "SUPABASE_SERVICE_ROLE_KEY",
} as const;

/**
 * Spec §7: freshness "is on by default with a 7-day window". The string is the
 * default for the `--max-age` flag; the number is what it parses to, and the two
 * are pinned to each other by test.
 */
export const DEFAULT_MAX_AGE = "7d";

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_MAX_AGE_MS = 7 * DAY_MS;

/** The `--max-age` grammar, in one place: a whole number with an optional unit. */
export const DURATION_UNITS_MS: Record<string, number> = {
  ms: 1,
  s: SECOND_MS,
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
};

/** Shown verbatim whenever a duration is refused, so the fix is in the failure. */
export const DURATION_GRAMMAR =
  "expected a whole number with an optional unit — 7d, 12h, 30m, 45s, 500ms, or bare milliseconds (500); 0 always re-fetches";
