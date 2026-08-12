-- Portal pipeline state (spec: docs/specs/2026-08-12-leads-portal-design.md).
--
-- The ONE table the portal writes. A lead with no row here is status 'new' by
-- definition — harvest does not write this table, the portal inserts on first
-- human action. person_urn carries no foreign key, same reasoning as every other
-- urn column in this schema: a pipeline row may outlive or precede its entity row.
--
-- DO NOT EDIT ONCE APPLIED ANYWHERE. New migration instead.

create table if not exists public.lead_pipeline (
  person_urn text primary key,
  status text not null default 'new'
    check (status in ('new', 'enriched', 'contacted', 'replied', 'won', 'lost', 'skipped')),
  note text,
  new_at timestamptz not null default now(),
  enriched_at timestamptz,
  contacted_at timestamptz,
  replied_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.lead_pipeline is
  'Operator workflow state per lead. Written by the portal (and optionally the agent); enrichment depth is deliberately NOT here — it is computed from data presence, never stored.';

create index if not exists lead_pipeline_status_idx on public.lead_pipeline (status);
create index if not exists lead_pipeline_updated_at_idx on public.lead_pipeline (updated_at desc);

alter table public.lead_pipeline enable row level security;
-- Grants: the default privileges set in 20260808120000 already give service_role
-- select/insert/update/delete on new tables and revoke anon/authenticated.
