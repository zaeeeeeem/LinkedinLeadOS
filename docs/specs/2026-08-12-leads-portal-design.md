# Leads Portal — Design

**Date:** 2026-08-12
**Status:** Approved by operator (brainstorming session 2026-08-12)

## Summary

A local-only web portal replacing raw Supabase browsing. Pipeline-first workbench: every
harvested lead has a workflow status and a computed enrichment depth; every lead has a
dossier page with a one-click "copy dossier" button that puts an agent-ready markdown
block on the clipboard. A separate Machine tab shows runs, budget, and errors.

Solo operator, localhost only. Reads Supabase (existing credentials) and the local `runs/`
raw archive. Writes exactly one new table (`lead_pipeline`). Never talks to LinkedIn,
never spends budget, never mutates scraper tables.

## Why (problem)

Leads live in Supabase tables (`search_results`, `persons`, `companies`, `person_posts`,
`company_posts`, `jobs`, `person_experience`). Browsing them in the Supabase dashboard is
unusable as a working surface: no notion of workflow state, no assembled view of a lead,
no way to know which leads still need research, no fast path from "lead" to
"personalization material in an agent prompt".

## Core model: two independent dimensions per lead

1. **Pipeline status** — where the lead is in the *operator's* workflow. Stored,
   human-moved (mostly).
2. **Enrichment depth** — how much data the machine has. **Never stored, always
   computed** from what exists in the DB, so it cannot drift out of sync.

### Pipeline statuses

`new → enriched → contacted → replied → won | lost`, plus `skipped` (bad fit; keeps the
list clean without deleting).

Who moves what:

- Harvest → lead appears as `new` automatically.
- `enriched` — set automatically when the lead reaches depth D3+ (see below).
- `contacted`, `replied`, `won`, `lost`, `skipped` — operator, one click (status
  dropdown, or kanban drag once the board view ships).
- Every status change stamps a date. Rows can show "contacted 5 days ago, no reply",
  which surfaces follow-up candidates for free.

Storage: one new Supabase table `lead_pipeline`:
`person_urn` (pk) · `status` · `note` (free text) · `updated_at` · per-stage timestamps
(`new_at`, `enriched_at`, `contacted_at`, `replied_at`, `closed_at`).

The portal writes this table; the agent/CLI may read and write the same table later.
Nothing else is ever written by the portal.

Notes: one free-text field per lead. No structured activity log this phase.

### Enrichment depth (computed)

Person levels:

- **D1 — SN row**: only a `search_results` entry (name, title, company).
- **D2 — SN profile**: Sales Navigator lead profile captured.
- **D3 — Full profile**: real `/in/` profile read (`profile.get`) — headline,
  experience, location in `persons` / `person_experience`.
- **D4 — Activity**: posts/activity captured (`profile.posts` → `person_posts`).

Company levels (same idea):

- **C1** — name only, from a search row.
- **C2** — `company.get` captured (about, size, industry, website, HQ).
- **C3** — company posts / jobs / people captured.

A lead's dossier shows both: person depth and their company's depth.

Where depth shows:

- Pipeline rows: depth dots (e.g. `●●○○`) next to the name, tooltip names the level.
- Filter: "depth < D3" is the research queue.
- Dossier: a checklist panel — what's fetched ✓, what's missing, and for each missing
  level the **exact CLI command**, copy-ready (e.g. `profile.get <url>`). The operator
  pastes it to the agent; the agent runs it under normal budget rules. **The portal never
  triggers LinkedIn reads itself.**

Depth computation degrades safely on odd data (orphan search rows, person without a
company): it reports the lowest provable level.

## Screens

Four screens, sidebar navigation.

### 1. Pipeline (home)

All leads grouped by status, with counts per stage. Row: name, title, company, location,
status, depth dots, which search found them, last activity date. Click → dossier.

Filter bar: by search, by status, by "needs research" (depth < D3), by "contacted > N
days ago with no reply". Bulk select → mark `skipped`.

List view ships first; kanban board view (drag between columns) is a later addition.

### 2. Lead dossier

Everything known about one person, one page:

- Header: name, headline, location, LinkedIn URL (link out), status dropdown, notes box.
- Company card: name, size, industry, website, HQ, about.
- Experience: current + past positions.
- Recent posts — the lead's and their company's.
- Company jobs (hiring = buying signal).
- Provenance strip: which search found them, harvested when, enriched when, `last_seen`
  freshness per entity.
- Enrichment checklist panel (see above).
- **Copy dossier** buttons (see below), plus per-section copy icons (just posts, just
  company).
- "Needs research" badge when the lead is thin.

### 3. Searches

Saved/harvested searches: filters used, result count, harvest date, and how many leads
from each search sit in each pipeline stage. Answers "which audience is working".

### 4. Machine

Runs table (capability, status, page loads, credits, started/ended). Today's budget
spend vs caps as simple bars. Recent errors and parse drift flagged red. One glance =
"is it healthy, how much budget is left".

## Copy dossier

One markdown block on the clipboard, agent-ready:

```markdown
# Jane Doe — VP Engineering @ Acme Corp
LinkedIn: https://linkedin.com/in/janedoe | Location: Austin, TX
Status: enriched (D3) | Found by: "US SaaS VPs 11-50" (2026-08-12)

## Headline
...

## Experience
- VP Engineering, Acme Corp (current)

## Recent posts
- [2026-08-01] "..." (14 reactions, 3 comments)

## Company: Acme Corp
Size: 11-50 | Industry: SaaS | HQ: Austin | Site: acme.com
About: ...
### Company posts
...
### Open jobs (hiring signals)
- Senior Backend Engineer (posted 2026-08-02)

## My notes
...

## Data freshness
person last_seen 2026-08-12 · company 2026-08-10 · missing: activity (D4)
```

Rules:

- **Only real captured data.** A missing section renders a "not captured" line — never
  omitted silently in a way that implies completeness, never invented.
- Freshness footer always present, so the agent knows how stale the material is.
- Two variants, two buttons, no config screen: **full** (default) and **short** (header +
  company + notes).
- Raw-archive extras (fields parsed but not present in typed tables) come from the local
  `runs/` archive when present; skipped silently when absent.

## Architecture

- Next.js + Tailwind, in `portal/` inside the LinkedinLeadsOS repo. `npm run portal` →
  localhost. No auth, no hosting, no deploy pipeline.
- Reads Supabase with existing credentials; reads `runs/` archive from disk.
- **Boundaries:** never talks to LinkedIn · never spends budget · scraper tables strictly
  read-only · writes only `lead_pipeline`.
- Data-assembly logic (depth computer, dossier markdown builder, pipeline queries) lives
  as pure functions separate from UI components — testable offline, reusable by the CLI
  later.

## Error handling

- Supabase unreachable → clear banner; page shell still renders.
- Missing/partial data → "not captured" placeholders; never crashes, never invents.
- Odd data shapes → depth degrades to lowest provable level.

## Testing

Pure functions (depth derivation, dossier builder, pipeline queries) get vitest tests
against fixture rows — the same offline-fixture discipline as the parsers. UI: manual
smoke only this phase.

## Explicitly cut this phase

Kanban drag view (after list view works) · reminders · message templates · structured
activity log · multi-user · hosting · any portal-triggered LinkedIn read.
