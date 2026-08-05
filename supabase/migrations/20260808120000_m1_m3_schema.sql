-- M1–M3 schema — spec §7.
--
-- Identity is LinkedIn's own URN, never a synthesized key. Entity tables are keyed on
-- the urn and upserted with last_seen bumped; search_results is append-only, so the same
-- lead found by two searches is two rows and one entity.
--
-- Everything here is guarded with `if not exists` and nothing drops or rewrites data, so
-- applying this file a second time over a database that already has it is a no-op. That
-- is asserted statically by tests/schema-migration.test.ts and executed for real by
-- `npm run db:verify`, which applies it to a fresh database and then applies it again.
--
-- Foreign keys exist only where they cannot lie: `runs` and `searches` are rows we create
-- ourselves, so a child can safely require its parent. No LinkedIn URN column carries a
-- foreign key — we routinely learn a person's current company, or a company's employee,
-- before we have ever scraped that entity, and a constraint there would reject true data.
--
-- Ids are text everywhere, including the numeric-looking company and job ids: they arrive
-- as strings in Voyager JSON, and text cannot silently reformat or overflow one.

-- ---------------------------------------------------------------------------
-- Run bookkeeping
-- ---------------------------------------------------------------------------

create table if not exists public.runs (
  run_id text primary key,
  capability text not null,
  args jsonb not null default '{}'::jsonb,
  status text not null default 'running' check (status in ('running', 'ok', 'error')),
  page_loads integer not null default 0,
  search_credits integer not null default 0,
  elapsed_ms integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  exit_code smallint
);

comment on table public.runs is
  'One row per capability invocation. run_id is the ULID minted by RunContext; the cost columns mirror the Cost type on the receipt (src/core/run/receipt.ts).';

create index if not exists runs_capability_started_at_idx on public.runs (capability, started_at desc);
create index if not exists runs_status_idx on public.runs (status);

create table if not exists public.raw_captures (
  id bigint generated always as identity primary key,
  run_id text not null references public.runs (run_id) on delete cascade,
  url_pattern text not null,
  status integer,
  shape_hash text,
  storage_path text not null,
  captured_at timestamptz not null default now()
);

comment on table public.raw_captures is
  'Index over the raw archive on disk (D2). storage_path points at the gzipped body under runs/<run_id>/raw/; the bytes themselves are never stored here.';

create index if not exists raw_captures_run_id_idx on public.raw_captures (run_id);
create index if not exists raw_captures_shape_hash_idx on public.raw_captures (shape_hash);
create index if not exists raw_captures_captured_at_idx on public.raw_captures (captured_at desc);
create index if not exists raw_captures_url_pattern_idx on public.raw_captures (url_pattern);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table if not exists public.persons (
  urn text primary key,
  vanity text,
  name text,
  headline text,
  location text,
  current_company_urn text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.persons is
  'urn is urn:li:fsd_profile:… — stable across name and vanity-URL changes. vanity is not unique: it is reassignable, and two profiles can hold the same string at different times.';

create index if not exists persons_last_seen_idx on public.persons (last_seen desc);
create index if not exists persons_vanity_idx on public.persons (vanity);
create index if not exists persons_current_company_urn_idx on public.persons (current_company_urn);

create table if not exists public.person_experience (
  id bigint generated always as identity primary key,
  person_urn text not null,
  company_urn text,
  company_name text,
  title text,
  started_on date,
  ended_on date,
  is_current boolean not null default false,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.person_experience is
  'Full employment history, not only the current role: it already arrives in the captured profile response, and re-deriving it later would mean re-scraping, which D2 exists to avoid. company_name is kept beside company_urn because past employers are often unlinked and carry no urn at all.';

-- The upsert target. NULLS NOT DISTINCT so a role with no urn, no title or no start date
-- still collapses onto itself on re-scrape instead of inserting a duplicate every run.
create unique index if not exists person_experience_natural_key
  on public.person_experience (person_urn, company_urn, company_name, title, started_on)
  nulls not distinct;

create index if not exists person_experience_person_urn_idx on public.person_experience (person_urn);
create index if not exists person_experience_company_urn_idx on public.person_experience (company_urn);
create index if not exists person_experience_current_idx on public.person_experience (person_urn) where is_current;

create table if not exists public.person_posts (
  urn text primary key,
  person_urn text not null,
  text text,
  posted_at timestamptz,
  reactions integer,
  comments integer,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.person_posts is
  'urn is the activity urn. reactions/comments are counts at last_seen, not histories — a later scrape overwrites them.';

create index if not exists person_posts_person_urn_posted_at_idx on public.person_posts (person_urn, posted_at desc);
create index if not exists person_posts_last_seen_idx on public.person_posts (last_seen desc);

-- ---------------------------------------------------------------------------
-- Companies
-- ---------------------------------------------------------------------------

create table if not exists public.companies (
  urn text primary key,
  name text,
  vanity text,
  website text,
  industry text,
  size_range text,
  hq text,
  about text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.companies is
  'urn is LinkedIn''s company id. size_range and hq are kept as the display strings LinkedIn returns; splitting them would be a parse decision the capture does not support.';

create index if not exists companies_last_seen_idx on public.companies (last_seen desc);
create index if not exists companies_vanity_idx on public.companies (vanity);
create index if not exists companies_name_idx on public.companies (name);

create table if not exists public.company_posts (
  urn text primary key,
  company_urn text not null,
  text text,
  posted_at timestamptz,
  reactions integer,
  comments integer,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

create index if not exists company_posts_company_urn_posted_at_idx on public.company_posts (company_urn, posted_at desc);
create index if not exists company_posts_last_seen_idx on public.company_posts (last_seen desc);

create table if not exists public.company_people (
  company_urn text not null,
  person_urn text not null,
  discovered_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (company_urn, person_urn)
);

comment on table public.company_people is
  'An observation that a person appeared under a company, not a claim they still work there. discovered_at is first sighting and never moves; last_seen is bumped on re-observation.';

create index if not exists company_people_person_urn_idx on public.company_people (person_urn);
create index if not exists company_people_discovered_at_idx on public.company_people (discovered_at desc);

create table if not exists public.jobs (
  id text primary key,
  company_urn text,
  title text,
  location text,
  posted_at timestamptz,
  workplace_type text,
  description text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);

comment on table public.jobs is
  'workplace_type is left unconstrained: it is LinkedIn''s vocabulary, not ours, and a check constraint here would turn a new value into a failed run.';

create index if not exists jobs_company_urn_idx on public.jobs (company_urn);
create index if not exists jobs_posted_at_idx on public.jobs (posted_at desc);
create index if not exists jobs_last_seen_idx on public.jobs (last_seen desc);

-- ---------------------------------------------------------------------------
-- Searches
-- ---------------------------------------------------------------------------

create table if not exists public.searches (
  search_id text primary key,
  kind text not null,
  filter_url text,
  filter_json jsonb,
  created_at timestamptz not null default now()
);

comment on table public.searches is
  'kind is sn_leads / sn_accounts / classic_people / … and is deliberately unconstrained — the spec list is open-ended and a check constraint would need a migration per new search surface.';

create index if not exists searches_kind_created_at_idx on public.searches (kind, created_at desc);

create table if not exists public.search_results (
  id bigint generated always as identity primary key,
  search_id text not null references public.searches (search_id) on delete cascade,
  page integer not null,
  position integer not null,
  person_urn text,
  company_urn text,
  run_ref text references public.runs (run_id) on delete set null,
  captured_at timestamptz not null default now(),
  check (person_urn is not null or company_urn is not null)
);

comment on table public.search_results is
  'Append-only by design (§7): the same lead in two searches is two rows and one entity. There is deliberately no unique key over (search_id, page, position) — re-running a search records a second observation rather than overwriting the first.';

create index if not exists search_results_search_id_page_position_idx on public.search_results (search_id, page, position);
create index if not exists search_results_person_urn_idx on public.search_results (person_urn);
create index if not exists search_results_company_urn_idx on public.search_results (company_urn);
create index if not exists search_results_run_ref_idx on public.search_results (run_ref);

-- ---------------------------------------------------------------------------
-- Reporting
-- ---------------------------------------------------------------------------

create table if not exists public.budget_ledger (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  capability text not null,
  run_id text,
  page_loads integer not null default 0,
  search_credits integer not null default 0
);

comment on table public.budget_ledger is
  'A reporting mirror only. The ledger of record is the append-only file runs/budget.ndjson (D11) — the budget check must work when Docker is down, so nothing may ever read this table to decide whether a run may proceed.';

create index if not exists budget_ledger_ts_idx on public.budget_ledger (ts desc);
create index if not exists budget_ledger_capability_ts_idx on public.budget_ledger (capability, ts desc);
create index if not exists budget_ledger_run_id_idx on public.budget_ledger (run_id);

create table if not exists public.parse_drift (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  capability text not null,
  field text not null,
  shape_hash text,
  n integer not null default 1
);

comment on table public.parse_drift is
  'One row per drift observation: a field a parser expected and did not find, under the shape hash of the body it was reading.';

create index if not exists parse_drift_ts_idx on public.parse_drift (ts desc);
create index if not exists parse_drift_capability_field_idx on public.parse_drift (capability, field);
create index if not exists parse_drift_shape_hash_idx on public.parse_drift (shape_hash);

-- ---------------------------------------------------------------------------
-- Exposure
--
-- RLS on with no policies, and grants to service_role alone. The store client holds the
-- service role key, which bypasses RLS; anon and authenticated reach nothing at all. This
-- is deny-by-default, so a database that is later hosted is not readable by anyone holding
-- the publishable key. The agent reads bulk data over a direct Postgres connection (D4),
-- which is the superuser path and unaffected by either.
-- ---------------------------------------------------------------------------

alter table public.runs enable row level security;
alter table public.raw_captures enable row level security;
alter table public.persons enable row level security;
alter table public.person_experience enable row level security;
alter table public.person_posts enable row level security;
alter table public.companies enable row level security;
alter table public.company_posts enable row level security;
alter table public.company_people enable row level security;
alter table public.jobs enable row level security;
alter table public.searches enable row level security;
alter table public.search_results enable row level security;
alter table public.budget_ledger enable row level security;
alter table public.parse_drift enable row level security;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
