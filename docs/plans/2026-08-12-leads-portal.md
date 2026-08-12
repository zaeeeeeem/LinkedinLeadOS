# Leads Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A localhost Next.js portal over the existing Supabase data: pipeline-first lead list, per-lead dossier with one-click agent-ready markdown copy, searches summary, machine health tab.

**Architecture:** Next.js App Router app in `portal/` (own package.json, not part of the root vitest/tsc surface). Server components + route handlers talk to Supabase with the service-role key (server-side only). All non-trivial logic — depth derivation, effective status, dossier markdown — lives in `portal/lib/` as pure functions with vitest tests. The portal writes exactly one table, `lead_pipeline` (new migration in the root repo); every scraper table is read-only to it. The portal never touches LinkedIn or the budget.

**Tech Stack:** Next.js 15 (App Router) · React 19 · Tailwind CSS v4 · @supabase/supabase-js · vitest (portal-local) · TypeScript.

**Spec:** `docs/specs/2026-08-12-leads-portal-design.md`. Read it before starting any task.

## Global Constraints

- Portal never issues LinkedIn requests, never spends budget, never triggers capability runs.
- Portal writes ONLY `public.lead_pipeline`. All other tables strictly read-only.
- Missing data renders as "not captured" — never invented, never silently implied complete.
- Statuses: `new · enriched · contacted · replied · won · lost · skipped` (exact strings).
- Person depth D1–D4 and company depth C1–C3 are **computed, never stored**.
- Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` read from the repo root `.env`. Service key stays server-side.
- Do not edit `supabase/migrations/20260808120000_m1_m3_schema.sql` — new migration file only.
- All migration DDL is `if not exists` / idempotent, matching existing convention; `npm run db:verify` must pass (applies twice).
- Raw-archive section of a dossier lists `raw_captures.storage_path` values — it does not parse archived bodies.
- Commit after every task at minimum; the plan's steps say when.

## Derivation rules (referenced by several tasks — the single source of truth)

Person depth (highest matching wins):

- **D4** — any `person_posts` row for the urn.
- **D3** — any `person_experience` row for the urn.
- **D2** — a `persons` row with non-null `headline`.
- **D1** — otherwise (a `search_results` row is what put the lead in the portal at all).

Company depth:

- **C3** — any `company_posts` OR `jobs` OR `company_people` row for the company urn.
- **C2** — a `companies` row with any of `about`, `industry`, `size_range` non-null.
- **C1** — a `companies` row or a search row naming it, but none of the above.
- **C0** — lead has no company urn at all.

Effective status: stored status from `lead_pipeline` (missing row = `new`). If stored is `new` and person depth ≥ D3, effective status is `enriched`. All other stored values pass through unchanged.

---

### Task 1: `lead_pipeline` migration

**Files:**
- Create: `supabase/migrations/20260812180000_lead_pipeline.sql`
- Test: `tests/lead-pipeline-migration.test.ts`

**Interfaces:**
- Produces: table `public.lead_pipeline` with columns `person_urn text pk`, `status text` (checked set), `note text`, `new_at`, `enriched_at`, `contacted_at`, `replied_at`, `closed_at`, `updated_at`. Later tasks read/write it via supabase-js.

- [ ] **Step 1: Write the failing test** (mirrors the static assertions in `tests/schema-migration.test.ts` — read that file first and follow its style):

```ts
// tests/lead-pipeline-migration.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync("supabase/migrations/20260812180000_lead_pipeline.sql", "utf8");

describe("lead_pipeline migration", () => {
  it("creates the table idempotently", () => {
    expect(sql).toMatch(/create table if not exists public\.lead_pipeline/);
  });
  it("constrains status to the seven pipeline values", () => {
    for (const s of ["new", "enriched", "contacted", "replied", "won", "lost", "skipped"]) {
      expect(sql).toContain(`'${s}'`);
    }
  });
  it("enables row level security", () => {
    expect(sql).toMatch(/alter table public\.lead_pipeline enable row level security/);
  });
  it("never drops or rewrites", () => {
    expect(sql).not.toMatch(/\bdrop\b|\btruncate\b/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lead-pipeline-migration.test.ts`
Expected: FAIL — file not found.

- [ ] **Step 3: Write the migration**

```sql
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/lead-pipeline-migration.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Apply and verify idempotency**

Run: `npm run db:reset && npm run db:verify`
Expected: both succeed (verify applies the full migration set twice).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260812180000_lead_pipeline.sql tests/lead-pipeline-migration.test.ts
git commit -m "feat(portal): lead_pipeline table — the one table the portal writes"
```

---

### Task 2: Portal scaffold

**Files:**
- Create: `portal/package.json`, `portal/tsconfig.json`, `portal/next.config.ts`, `portal/postcss.config.mjs`, `portal/app/globals.css`, `portal/app/layout.tsx`, `portal/app/page.tsx`, `portal/lib/db.ts`, `portal/vitest.config.ts`, `portal/.gitignore`
- Modify: root `package.json` (add `portal` script)

**Interfaces:**
- Produces: `getDb(): SupabaseClient` from `portal/lib/db.ts` — server-side Supabase client, used by every later data task. Sidebar layout with nav links `/` (Pipeline), `/searches`, `/machine`; dossier route will be `/lead/[urn]`.

- [ ] **Step 1: Scaffold manually** (no `create-next-app` — it fights existing dirs; the file set is small):

`portal/package.json`:

```json
{
  "name": "linkedinleadsos-portal",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3999",
    "build": "next build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.112.2",
    "next": "^15.5.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@tailwindcss/postcss": "^4.1.0",
    "@types/node": "^26.2.0",
    "@types/react": "^19.1.0",
    "dotenv": "^17.2.0",
    "tailwindcss": "^4.1.0",
    "typescript": "^5.9.3",
    "vitest": "^4.1.10"
  }
}
```

`portal/next.config.ts`:

```ts
import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// Portal reads the toolkit's own .env — one credentials file for the whole repo.
loadEnv({ path: resolve(import.meta.dirname, "../.env") });

const nextConfig: NextConfig = {};
export default nextConfig;
```

`portal/lib/db.ts`:

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;

/** Server-side only. Service role key must never reach a client component. */
export function getDb(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — is ../.env present?");
  }
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
  return client;
}
```

`portal/app/layout.tsx` — sidebar shell:

```tsx
import "./globals.css";
import Link from "next/link";
import type { ReactNode } from "react";

export const metadata = { title: "LeadsOS Portal" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen bg-zinc-50 text-zinc-900">
        <nav className="w-48 shrink-0 border-r border-zinc-200 bg-white p-4">
          <div className="mb-6 text-sm font-bold tracking-wide">LeadsOS</div>
          <ul className="space-y-1 text-sm">
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/">Pipeline</Link></li>
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/searches">Searches</Link></li>
            <li><Link className="block rounded px-2 py-1 hover:bg-zinc-100" href="/machine">Machine</Link></li>
          </ul>
        </nav>
        <main className="min-w-0 flex-1 p-6">{children}</main>
      </body>
    </html>
  );
}
```

`portal/app/globals.css`: `@import "tailwindcss";`
`portal/postcss.config.mjs`: `export default { plugins: { "@tailwindcss/postcss": {} } };`
`portal/app/page.tsx`: placeholder `<h1>` (replaced in Task 6).
`portal/tsconfig.json`: copy Next.js 15 default (strict, `moduleResolution: "bundler"`, plugin `next`, paths `@/*` → `./*`).
`portal/vitest.config.ts`: `export default { test: { include: ["lib/**/*.test.ts"] } }` (typed via `defineConfig` from vitest/config).
`portal/.gitignore`: `.next/`, `node_modules/`, `next-env.d.ts`.

Root `package.json` scripts — add: `"portal": "npm --prefix portal run dev"`.

- [ ] **Step 2: Install and smoke**

Run: `cd portal && npm install && npm run typecheck`
Then: `npm run portal` from repo root; open http://localhost:3999 — sidebar renders, no console errors. Port 3999 to stay clear of anything else local.

- [ ] **Step 3: Commit**

```bash
git add portal root package.json (and package-lock.json)
git commit -m "feat(portal): Next.js scaffold — sidebar shell, server-side Supabase client"
```

---

### Task 3: Pure lib — depth + effective status

**Files:**
- Create: `portal/lib/depth.ts`, `portal/lib/depth.test.ts`

**Interfaces:**
- Produces:

```ts
export type PersonDepth = 1 | 2 | 3 | 4;
export type CompanyDepth = 0 | 1 | 2 | 3;
export type PipelineStatus =
  "new" | "enriched" | "contacted" | "replied" | "won" | "lost" | "skipped";

export interface PersonDepthInputs {
  hasHeadline: boolean;     // persons.headline non-null
  hasExperience: boolean;   // any person_experience row
  hasPosts: boolean;        // any person_posts row
}
export interface CompanyDepthInputs {
  hasCompanyUrn: boolean;   // lead has a company urn at all
  hasCompanyRow: boolean;   // companies row exists
  hasDetail: boolean;       // any of about/industry/size_range non-null
  hasActivity: boolean;     // any company_posts, jobs, or company_people row
}

export function personDepth(i: PersonDepthInputs): PersonDepth;
export function companyDepth(i: CompanyDepthInputs): CompanyDepth;
export function effectiveStatus(stored: PipelineStatus | null, depth: PersonDepth): PipelineStatus;
export function depthLabel(d: PersonDepth): string; // "D1 — SN row" … "D4 — Activity"
```

- [ ] **Step 1: Write the failing tests**

```ts
// portal/lib/depth.test.ts
import { describe, expect, it } from "vitest";
import { companyDepth, effectiveStatus, personDepth } from "./depth";

const base = { hasHeadline: false, hasExperience: false, hasPosts: false };

describe("personDepth", () => {
  it("D1 when only the search row exists", () => {
    expect(personDepth(base)).toBe(1);
  });
  it("D2 when a headline was captured", () => {
    expect(personDepth({ ...base, hasHeadline: true })).toBe(2);
  });
  it("D3 when experience exists, even without a headline (odd data degrades safely)", () => {
    expect(personDepth({ ...base, hasExperience: true })).toBe(3);
  });
  it("D4 when posts exist", () => {
    expect(personDepth({ ...base, hasHeadline: true, hasExperience: true, hasPosts: true })).toBe(4);
  });
});

describe("companyDepth", () => {
  it("C0 when the lead has no company urn", () => {
    expect(companyDepth({ hasCompanyUrn: false, hasCompanyRow: false, hasDetail: false, hasActivity: false })).toBe(0);
  });
  it("C1 name-only", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: false, hasActivity: false })).toBe(1);
  });
  it("C2 when detail fields captured", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: true, hasActivity: false })).toBe(2);
  });
  it("C3 when posts/jobs/people captured", () => {
    expect(companyDepth({ hasCompanyUrn: true, hasCompanyRow: true, hasDetail: true, hasActivity: true })).toBe(3);
  });
});

describe("effectiveStatus", () => {
  it("missing pipeline row means new", () => {
    expect(effectiveStatus(null, 1)).toBe("new");
  });
  it("new + depth >= D3 shows enriched automatically", () => {
    expect(effectiveStatus("new", 3)).toBe("enriched");
    expect(effectiveStatus(null, 4)).toBe("enriched");
  });
  it("human-set statuses always pass through", () => {
    expect(effectiveStatus("contacted", 4)).toBe("contacted");
    expect(effectiveStatus("skipped", 1)).toBe("skipped");
  });
});
```

- [ ] **Step 2: Run to verify fail** — `cd portal && npx vitest run lib/depth.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — straight transcription of the Derivation rules section at the top of this plan (highest matching level wins; `effectiveStatus` upgrades only `null`/`"new"` at depth ≥ 3).

- [ ] **Step 4: Run to verify pass** — same command, all green.

- [ ] **Step 5: Commit** — `git commit -m "feat(portal): depth derivation + effective status (pure, tested)"`

---

### Task 4: Pure lib — dossier markdown builder

**Files:**
- Create: `portal/lib/dossier.ts`, `portal/lib/dossier.test.ts`

**Interfaces:**
- Consumes: `PersonDepth`, `CompanyDepth`, `PipelineStatus`, `depthLabel` from `./depth`.
- Produces:

```ts
export interface DossierData {
  person: { urn: string; name: string | null; headline: string | null;
            location: string | null; vanity: string | null; lastSeen: string | null };
  status: PipelineStatus;
  depth: PersonDepth;
  foundBy: { label: string; capturedAt: string } | null;  // search that found them
  experience: Array<{ title: string | null; companyName: string | null; isCurrent: boolean }>;
  posts: Array<{ postedAt: string | null; text: string | null; reactions: number | null; comments: number | null }>;
  company: { name: string | null; sizeRange: string | null; industry: string | null;
             hq: string | null; website: string | null; about: string | null;
             lastSeen: string | null; depth: CompanyDepth } | null;
  companyPosts: Array<{ postedAt: string | null; text: string | null }>;
  jobs: Array<{ title: string | null; postedAt: string | null }>;
  note: string | null;
  rawPaths: string[];       // raw_captures.storage_path values for this lead's runs
  missing: string[];        // human labels of uncaptured levels, e.g. ["activity (D4)"]
}

export function buildDossier(d: DossierData, variant: "full" | "short"): string;
```

- [ ] **Step 1: Write the failing tests** — assert on the output string:

```ts
// portal/lib/dossier.test.ts
import { describe, expect, it } from "vitest";
import { buildDossier, type DossierData } from "./dossier";

const full: DossierData = {
  person: { urn: "urn:li:fsd_profile:X1", name: "Jane Doe", headline: "VP Eng",
            location: "Austin, TX", vanity: "janedoe", lastSeen: "2026-08-12" },
  status: "enriched", depth: 3,
  foundBy: { label: "US SaaS VPs 11-50", capturedAt: "2026-08-12" },
  experience: [{ title: "VP Engineering", companyName: "Acme", isCurrent: true }],
  posts: [{ postedAt: "2026-08-01", text: "Shipping is a feature", reactions: 14, comments: 3 }],
  company: { name: "Acme", sizeRange: "11-50", industry: "SaaS", hq: "Austin",
             website: "acme.com", about: "We do things", lastSeen: "2026-08-10", depth: 2 },
  companyPosts: [], jobs: [{ title: "Senior Backend Engineer", postedAt: "2026-08-02" }],
  note: "warm intro possible", rawPaths: ["runs/01ABC/raw/profile.json.gz"],
  missing: ["activity (D4)"],
};

describe("buildDossier full", () => {
  const md = buildDossier(full, "full");
  it("headline line carries name, title, company", () => {
    expect(md).toContain("# Jane Doe");
    expect(md).toContain("https://linkedin.com/in/janedoe");
  });
  it("uncaptured sections say not captured, never vanish silently", () => {
    expect(md).toContain("## Company posts");
    expect(md).toContain("not captured");
  });
  it("freshness footer always present, names what is missing", () => {
    expect(md).toContain("## Data freshness");
    expect(md).toContain("missing: activity (D4)");
  });
  it("raw archive paths listed for the agent to read directly", () => {
    expect(md).toContain("runs/01ABC/raw/profile.json.gz");
  });
  it("no LinkedIn url when vanity is unknown", () => {
    const noVanity = { ...full, person: { ...full.person, vanity: null } };
    expect(buildDossier(noVanity, "full")).not.toContain("linkedin.com/in/");
  });
});

describe("buildDossier short", () => {
  const md = buildDossier(full, "short");
  it("keeps header, company, notes", () => {
    expect(md).toContain("# Jane Doe");
    expect(md).toContain("## Company: Acme");
    expect(md).toContain("warm intro possible");
  });
  it("drops posts and jobs", () => {
    expect(md).not.toContain("Shipping is a feature");
    expect(md).not.toContain("Senior Backend Engineer");
  });
  it("keeps the freshness footer", () => {
    expect(md).toContain("## Data freshness");
  });
});
```

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement.** Section order (spec): header block · Headline · Experience · Recent posts · Company (with nested Company posts, Open jobs) · My notes · Raw archive · Data freshness. Every list section that is empty renders `_not captured_`. `short` variant = header + Company card + My notes + Data freshness. Null scalar fields render as `?` inside lines, and a fully-null section falls back to `_not captured_`. Nothing is ever synthesized.

- [ ] **Step 4: Run to verify pass.**

- [ ] **Step 5: Commit** — `git commit -m "feat(portal): dossier markdown builder (full + short, truthful gaps)"`

---

### Task 5: Data access layer

**Files:**
- Create: `portal/lib/queries.ts`, `portal/lib/assemble.ts`, `portal/lib/assemble.test.ts`

**Interfaces:**
- Consumes: `getDb()` (Task 2), depth functions (Task 3), `DossierData` (Task 4).
- Produces (used by every screen):

```ts
// queries.ts — thin, untested-by-unit-tests, all reads via getDb()
export function fetchLeadRows(): Promise<LeadRowRaw[]>;         // pipeline screen source
export function fetchLeadDetail(urn: string): Promise<LeadDetailRaw | null>;
export function fetchSearchSummaries(): Promise<SearchSummaryRaw[]>;
export function fetchMachine(): Promise<MachineRaw>;            // runs + ledger + drift

// assemble.ts — PURE, tested: raw rows in, screen models out
export interface LeadListItem {
  urn: string; name: string | null; title: string | null; companyName: string | null;
  location: string | null; status: PipelineStatus; depth: PersonDepth;
  searchLabel: string | null; lastActivity: string | null; needsResearch: boolean;
  contactedDaysAgo: number | null;
}
export function assembleLeadList(raw: LeadRowRaw[], now: Date): LeadListItem[];
export function assembleDossierData(raw: LeadDetailRaw): DossierData;
```

- [ ] **Step 1: Define the raw-row types and write failing tests for `assemble.ts`.** Test with hand-built fixture rows (same discipline as parser fixtures):
  - A lead with only a search row assembles to depth 1, status `new`, `needsResearch: true`.
  - A lead with experience rows and stored status `new` assembles to effective `enriched`, `needsResearch: false`.
  - A lead `contacted` 5 days before `now` yields `contactedDaysAgo: 5`.
  - `assembleDossierData` fills `missing` correctly (no posts → `"activity (D4)"` present) and passes raw paths through.
  - Duplicate search rows for one person (append-only table!) collapse to one list item, keeping the newest search label.

- [ ] **Step 2: Run to verify fail.**

- [ ] **Step 3: Implement `queries.ts`.** Query set, all read-only, page-sized sanely:
  - Lead rows: `search_results` where `person_urn is not null` joined app-side with `persons`, `lead_pipeline`, `searches` (label = `filter_json->>'label'` fallback `search_id`), plus per-urn existence sets from `person_experience`, `person_posts` (select urns only). Supabase-js has no joins across these without FKs — fetch the tables separately and join in `assemble.ts`; volumes are hundreds of rows, fine.
  - Detail: person row, experience rows, posts (newest 10), company row + company posts (newest 5) + jobs (newest 10), pipeline row, this person's `search_results` → `searches`, and `raw_captures.storage_path` for runs referenced by this person's `search_results.run_ref` (plus runs whose `args` contain the person's vanity or urn — `args::text ilike`; use `.or()`; best-effort, absence is fine).
  - Machine: last 50 `runs`, today's `budget_ledger` sums grouped by capability, last 20 `parse_drift`.

- [ ] **Step 4: Implement `assemble.ts` to green.** Run `npx vitest run` in `portal/`.

- [ ] **Step 5: Commit** — `git commit -m "feat(portal): data access — thin queries, pure tested assembly"`

---

### Task 6: Pipeline screen + status mutations

**Files:**
- Create: `portal/app/api/pipeline/route.ts`, `portal/components/StatusSelect.tsx`, `portal/components/LeadTable.tsx`, `portal/components/DepthDots.tsx`
- Modify: `portal/app/page.tsx`

**Interfaces:**
- Consumes: `fetchLeadRows` + `assembleLeadList` (Task 5).
- Produces: `PATCH /api/pipeline` body `{ personUrn: string; status?: PipelineStatus; note?: string }` → upserts `lead_pipeline`, stamps `updated_at` and the stage timestamp (`contacted_at` when status becomes `contacted`, `replied_at` for `replied`, `closed_at` for `won|lost|skipped`, `enriched_at` for `enriched`). Reused by Task 7's dossier page.

- [ ] **Step 1: Route handler.** Validate status against the seven allowed strings (reject 400 otherwise — this is the portal's only write path, keep it strict). Upsert via `getDb().from("lead_pipeline").upsert(...)`. Timestamp stamping logic is 10 lines in the handler; acceptable untested — the allowed-status validation constants come from `lib/depth.ts` so they cannot drift.

- [ ] **Step 2: Page.** Server component: fetch + assemble, render stage-grouped list with counts header (`New 47 · Enriched 12 · …`). `LeadTable` is a client component receiving items: rows show name, title, company, location, `DepthDots` (`●●○○`, `title` attr = `depthLabel`), status select, search label, last activity. Row click → `/lead/[urn]`.
  Filter bar (client-side state, no URL persistence this phase): status dropdown, search dropdown, "needs research" toggle, "contacted > 7d no reply" toggle. Bulk: checkbox column + "mark skipped" button looping the PATCH.
  `StatusSelect` calls the PATCH and `router.refresh()`.

- [ ] **Step 3: Manual smoke** with live local Supabase: statuses persist across reload; a lead with experience rows shows `enriched` without any row in `lead_pipeline`; bulk-skip works; Supabase down → banner (wrap fetch in try/catch, render `<ErrorBanner>` + empty shell — create the tiny component here, reuse on other pages).

- [ ] **Step 4: Commit** — `git commit -m "feat(portal): pipeline screen — grouped list, filters, status writes"`

---

### Task 7: Dossier screen + copy buttons

**Files:**
- Create: `portal/app/lead/[urn]/page.tsx`, `portal/components/CopyButton.tsx`, `portal/components/EnrichmentChecklist.tsx`, `portal/components/NotesBox.tsx`

**Interfaces:**
- Consumes: `fetchLeadDetail` + `assembleDossierData` (Task 5), `buildDossier` (Task 4), PATCH route (Task 6).

- [ ] **Step 1: Page.** Server component; urn decoded from route param (urns contain `:` — `encodeURIComponent` in links, `decodeURIComponent` here). Unknown urn → "lead not captured" page, not a crash. Sections per spec: header (name, headline, location, LinkedIn link when vanity known, `StatusSelect`, `NotesBox` — textarea, save button → PATCH `note`), company card, experience, posts, company posts, jobs, provenance strip (search label + dates + `last_seen` per entity), `EnrichmentChecklist`. Every empty section renders "not captured".

- [ ] **Step 2: Copy buttons.** `CopyButton` (client): receives pre-built markdown string as prop (built server-side via `buildDossier`), `navigator.clipboard.writeText`, flashes "copied ✓". Two at top: **Copy dossier** (full) and **Copy short**. Per-section copy icons on posts and company sections (same component, section-only markdown sliced by the builder's section text).

- [ ] **Step 3: Checklist panel.** For each level D2–D4 / C2–C3: ✓ when reached, else the copy-ready CLI command with the lead's best identifier:
  - D3: `npm run cap -- profile.get <linkedin-url-or-urn>`
  - D4: `npm run cap -- profile.posts <linkedin-url-or-urn>`
  - C2: `npm run cap -- company.get <company-urn>`
  - C3: `npm run cap -- company.posts <company-urn>` / `company.jobs`
  Before implementing, check `src/cli/index.ts` for the real invocation shapes and copy those verbatim — the commands shown must actually run. Each command gets its own small copy icon. A caption states: "portal never runs these — paste to the agent".

- [ ] **Step 4: Manual smoke:** copy full dossier for a real enriched lead → paste into a text editor → sections, freshness footer, raw paths all present; thin lead shows "needs research" badge and mostly "not captured".

- [ ] **Step 5: Commit** — `git commit -m "feat(portal): dossier page — copy full/short, enrichment checklist"`

---

### Task 8: Searches screen

**Files:**
- Create: `portal/app/searches/page.tsx`
- Modify: `portal/lib/assemble.ts`, `portal/lib/assemble.test.ts` (add `assembleSearchSummaries`)

**Interfaces:**
- Consumes: `fetchSearchSummaries` (Task 5) — searches + their result counts + joined pipeline statuses.
- Produces: `assembleSearchSummaries(raw): SearchSummary[]` where `SearchSummary = { searchId, label, kind, createdAt, resultCount, byStatus: Record<PipelineStatus, number> }`.

- [ ] **Step 1: Failing test** for `assembleSearchSummaries`: two searches sharing a person count that person in both (append-only truth); statuses roll up using **effective** status (a D3 lead with no pipeline row counts as `enriched`, not `new`).
- [ ] **Step 2: Implement to green.**
- [ ] **Step 3: Page.** Table: label, kind, created, results, then one small count per stage. Row click → Pipeline pre-filtered to that search (`/?search=<id>` — read the param in the page and pass as initial filter state to `LeadTable`).
- [ ] **Step 4: Commit** — `git commit -m "feat(portal): searches screen — which audience is working"`

---

### Task 9: Machine screen

**Files:**
- Create: `portal/app/machine/page.tsx`, `portal/components/BudgetBar.tsx`

**Interfaces:**
- Consumes: `fetchMachine` (Task 5).

- [ ] **Step 1: Caps.** Read the real daily caps from `src/core/budget/constants.ts` (import type-only is impossible across packages — copy the two numbers into `portal/lib/caps.ts` with a comment naming the source file; a portal that displays a stale cap is annoying but harmless, the ledger of record is elsewhere).
- [ ] **Step 2: Page.** Three blocks: **Budget today** — `BudgetBar` per metric (page loads, search credits): spent/cap, bar turns amber > 70%, red > 90%. **Recent runs** — table of last 50: capability, status (error rows red), page_loads, credits, started, duration. **Drift** — last 20 `parse_drift` rows, any in the last 24h flagged red with capability + field.
- [ ] **Step 3: Manual smoke** against live data (there are real runs + ledger rows from 2026-08-12).
- [ ] **Step 4: Commit** — `git commit -m "feat(portal): machine screen — budget bars, runs, drift"`

---

### Task 10: Wiring + docs

**Files:**
- Modify: `STATE.md`, `README.md` (root — add portal section), `CLAUDE.md` (Index + one line under Phase)
- Create: `portal/README.md`

**Steps:**

- [ ] **Step 1: `portal/README.md`** — what it is (spec link), how to run (`npm run portal`, needs `npm run db:start` first), the boundary rules (writes only `lead_pipeline`, never LinkedIn, never budget), where the pure logic + tests live.
- [ ] **Step 2: Root docs.** README: one "Portal" paragraph. CLAUDE.md Index: `- Leads portal → portal/README.md`. STATE.md: portal shipped, tasks list.
- [ ] **Step 3: Full verification.** Root: `npm test` and `npm run typecheck` (portal excluded from root tsconfig — verify root typecheck still passes untouched). Portal: `npm run test` + `npm run typecheck` + `npm run build`.
- [ ] **Step 4: Commit** — `git commit -m "docs(portal): wiring, run instructions, state"`

---

## Self-review notes (done at write time)

- Spec coverage: pipeline statuses/writes (T1, T6) · depth + checklist (T3, T7) · dossier + copy variants + raw paths + freshness (T4, T7) · searches (T8) · machine (T9) · error banner (T6 step 3) · "cut this phase" list untouched — no kanban, no reminders, no templates.
- Deviation from spec, deliberate: "raw-archive extras" = listed `storage_path`s, not parsed bodies (agent reads the files itself). Noted in T4/T5.
- Types named identically across tasks: `PersonDepth`, `PipelineStatus`, `DossierData`, `LeadListItem`, `effectiveStatus` — defined once (T3/T4/T5), consumed by name later.
