#!/usr/bin/env node
/**
 * Operational proof for Task 13. Not a unit test — it needs Docker.
 *
 *   npm run db:verify
 *
 * A migration that applied cleanly once is not proven. This does, in order:
 *
 *   1. `supabase start`
 *   2. `supabase db reset` — drops the database and applies every migration from scratch
 *   3. compares the live catalog against supabase/schema.spec.json (tables, columns, PKs)
 *   4. applies the migration file a SECOND time, straight through psql with
 *      ON_ERROR_STOP=1, over the database that already has it
 *   5. compares the catalog again — a re-apply that changed the schema is a failure
 *   6. smoke transaction: insert into every table, read it back, then ROLLBACK, so the
 *      tables are proven queryable and writable without leaving a row behind
 *
 * Exits 0 on success, 1 on any mismatch, with the first difference named.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = JSON.parse(readFileSync(join(ROOT, "supabase", "schema.spec.json"), "utf8"));
const MIGRATION = join(
  ROOT,
  "supabase",
  "migrations",
  "20260808120000_m1_m3_schema.sql",
);

const projectId = /^project_id\s*=\s*"(.+)"/m.exec(
  readFileSync(join(ROOT, "supabase", "config.toml"), "utf8"),
)?.[1];
if (!projectId) fail("could not read project_id from supabase/config.toml");
const DB_CONTAINER = `supabase_db_${projectId}`;

let step = 0;
function say(msg) {
  console.log(`[${++step}] ${msg}`);
}
function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function supabase(args) {
  return execFileSync("supabase", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

/** ASCII unit separator: psql's field separator, so no data value can contain it. */
const SEP = "\u001f";

/** Runs SQL in the local database and returns rows as arrays of column strings. */
function psql(sql, { input } = {}) {
  const args = [
    "exec",
    "-i",
    DB_CONTAINER,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-At",
    "-F",
    SEP,
    "-q",
  ];
  if (sql !== null) args.push("-c", sql);
  const out = execFileSync("docker", args, {
    encoding: "utf8",
    input: input ?? "",
    stdio: ["pipe", "pipe", "inherit"],
  });
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.split(SEP));
}

/** The live schema, as `table -> { columns: Set, pk: string[] }`. */
function readCatalog() {
  const cols = psql(`
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
     order by c.table_name, c.ordinal_position
  `);
  const pks = psql(`
    select cls.relname, a.attname
      from pg_index i
      join pg_class cls on cls.oid = i.indrelid
      join pg_namespace n on n.oid = cls.relnamespace
      join unnest(i.indkey) with ordinality k(attnum, ord) on true
      join pg_attribute a on a.attrelid = cls.oid and a.attnum = k.attnum
     where i.indisprimary and n.nspname = 'public'
     order by cls.relname, k.ord
  `);
  const catalog = {};
  for (const [table, column] of cols) {
    (catalog[table] ??= { columns: new Set(), pk: [] }).columns.add(column);
  }
  for (const [table, column] of pks) {
    if (catalog[table]) catalog[table].pk.push(column);
  }
  return catalog;
}

/** Every way the live catalog falls short of the spec, as human sentences. */
function diffAgainstSpec(catalog) {
  const problems = [];
  const specTables = Object.keys(SPEC.tables).sort();
  const live = Object.keys(catalog).sort();

  for (const t of specTables) if (!catalog[t]) problems.push(`table ${t} is missing`);
  for (const t of live) {
    if (!SPEC.tables[t]) problems.push(`table ${t} exists but is not in the spec`);
  }
  for (const t of specTables) {
    if (!catalog[t]) continue;
    for (const c of SPEC.tables[t].columns) {
      if (!catalog[t].columns.has(c)) problems.push(`${t}.${c} is missing`);
    }
    const pk = catalog[t].pk.join(",");
    const want = SPEC.tables[t].primary_key.join(",");
    if (pk !== want) problems.push(`${t} primary key is (${pk}), spec says (${want})`);
  }
  return problems;
}

function catalogFingerprint(catalog) {
  return Object.keys(catalog)
    .sort()
    .map((t) => `${t}(${[...catalog[t].columns].sort().join(",")})[${catalog[t].pk.join(",")}]`)
    .join("\n");
}

// ---------------------------------------------------------------------------

say("supabase start");
supabase(["start"]);

say("supabase db reset — dropping and re-applying every migration from scratch");
supabase(["db", "reset", "--local"]);

say("comparing the live catalog against supabase/schema.spec.json");
const first = readCatalog();
const problems = diffAgainstSpec(first);
if (problems.length > 0) fail(`schema does not match the spec:\n  - ${problems.join("\n  - ")}`);
console.log(`    ${Object.keys(first).length} tables, all §7 columns present`);

say("applying the migration a second time over the database that already has it");
try {
  psql(null, { input: readFileSync(MIGRATION, "utf8") });
} catch {
  fail("re-applying the migration errored — it is not idempotent");
}

say("comparing the catalog again — a re-apply must not have changed anything");
const second = readCatalog();
if (catalogFingerprint(first) !== catalogFingerprint(second)) {
  fail("the catalog changed between the first and second apply");
}
console.log("    identical");

say("smoke transaction: writing one row into every table, then rolling back");
const smoke = `
begin;
insert into public.runs (run_id, capability, args, status, page_loads, search_credits, elapsed_ms, exit_code)
  values ('01SMOKE0000000000000000000', 'smoke', '{"n":1}'::jsonb, 'ok', 1, 0, 5, 0);
insert into public.raw_captures (run_id, url_pattern, status, shape_hash, storage_path)
  values ('01SMOKE0000000000000000000', 'voyagerIdentityDashProfiles', 200, 'abc', 'runs/x/raw/0001-abc.json.gz');
insert into public.persons (urn, vanity, name) values ('urn:li:fsd_profile:SMOKE', 'smoke', 'Smoke');
insert into public.person_experience (person_urn, company_urn, title, is_current)
  values ('urn:li:fsd_profile:SMOKE', '1234', 'Founder', true);
insert into public.person_posts (urn, person_urn, text) values ('urn:li:activity:1', 'urn:li:fsd_profile:SMOKE', 'hi');
insert into public.companies (urn, name) values ('1234', 'Smoke Co');
insert into public.company_posts (urn, company_urn, text) values ('urn:li:activity:2', '1234', 'hi');
insert into public.company_people (company_urn, person_urn) values ('1234', 'urn:li:fsd_profile:SMOKE');
insert into public.jobs (id, company_urn, title) values ('99', '1234', 'Engineer');
insert into public.searches (search_id, kind, filter_url) values ('s1', 'sn_leads', 'https://example.invalid/');
insert into public.search_results (search_id, page, position, person_urn, run_ref)
  values ('s1', 1, 1, 'urn:li:fsd_profile:SMOKE', '01SMOKE0000000000000000000');
insert into public.budget_ledger (capability, run_id, page_loads) values ('smoke', '01SMOKE0000000000000000000', 1);
insert into public.parse_drift (capability, field, shape_hash, n) values ('smoke', 'headline', 'abc', 2);
select 'rows', (select count(*) from public.runs) + (select count(*) from public.raw_captures)
  + (select count(*) from public.persons) + (select count(*) from public.person_experience)
  + (select count(*) from public.person_posts) + (select count(*) from public.companies)
  + (select count(*) from public.company_posts) + (select count(*) from public.company_people)
  + (select count(*) from public.jobs) + (select count(*) from public.searches)
  + (select count(*) from public.search_results) + (select count(*) from public.budget_ledger)
  + (select count(*) from public.parse_drift);
rollback;
`;
const rows = psql(null, { input: smoke }).find((r) => r[0] === "rows");
if (!rows || Number(rows[1]) !== 13) fail(`smoke insert read back ${rows?.[1]} rows, expected 13`);
console.log("    13 rows written and read back, then rolled back");

say("confirming the store is empty again");
const left = psql("select count(*) from public.runs")[0][0];
if (left !== "0") fail(`smoke transaction left ${left} rows in runs`);

console.log("\nOK — schema applies from scratch, re-applies unchanged, and every §7 table is queryable.");
