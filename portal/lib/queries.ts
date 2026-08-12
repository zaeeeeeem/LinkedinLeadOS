// portal/lib/queries.ts
//
// Thin, read-only queries over the scraper schema + lead_pipeline. Not unit-tested —
// the logic worth testing lives in assemble.ts, which takes these raw row shapes as
// plain data. No query here ever writes.

import { getDb } from "./db";
import type { PipelineStatus } from "./depth";

// ---------------------------------------------------------------------------
// Raw-row shapes
// ---------------------------------------------------------------------------

export interface LeadRowRaw {
  personUrn: string;
  name: string | null;
  headline: string | null;
  location: string | null;
  companyUrn: string | null;
  companyName: string | null;
  hasExperience: boolean;
  hasPosts: boolean;
  status: PipelineStatus | null;
  contactedAt: string | null;
  searchLabel: string;
  searchCapturedAt: string;
  lastActivity: string | null;
}

export interface PersonExperienceRow {
  title: string | null;
  companyName: string | null;
  isCurrent: boolean;
}

export interface PersonPostRow {
  postedAt: string | null;
  text: string | null;
  reactions: number | null;
  comments: number | null;
}

export interface CompanyPostRow {
  postedAt: string | null;
  text: string | null;
}

export interface JobRow {
  title: string | null;
  postedAt: string | null;
}

export interface LeadDetailRaw {
  person: {
    urn: string;
    name: string | null;
    headline: string | null;
    location: string | null;
    vanity: string | null;
    lastSeen: string | null;
  };
  status: PipelineStatus | null;
  note: string | null;
  experience: PersonExperienceRow[];
  posts: PersonPostRow[];
  companyUrn: string | null;
  company: {
    name: string | null;
    sizeRange: string | null;
    industry: string | null;
    hq: string | null;
    website: string | null;
    about: string | null;
    lastSeen: string | null;
  } | null;
  companyPosts: CompanyPostRow[];
  jobs: JobRow[];
  hasCompanyPeople: boolean;
  foundBy: { label: string; capturedAt: string } | null;
  rawPaths: string[];
}

export interface SearchSummaryRaw {
  searchId: string;
  kind: string;
  label: string;
  filterUrl: string | null;
  createdAt: string;
  resultCount: number;
}

export interface RunRow {
  runId: string;
  capability: string;
  status: string;
  pageLoads: number;
  searchCredits: number;
  elapsedMs: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
}

export interface DriftRow {
  id: number;
  ts: string;
  capability: string;
  field: string;
  shapeHash: string | null;
  n: number;
}

export interface MachineRaw {
  runs: RunRow[];
  spend24h: { pageLoads: number; searchCredits: number };
  drift: DriftRow[];
}

// supabase/config.toml sets max_rows = 1000 — any select that can plausibly exceed that
// must be paged explicitly, or rows silently vanish past the cap. Pages until a short
// page (fewer than pageSize rows) comes back.
const PAGE_SIZE = 1000;

async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const to = from + PAGE_SIZE - 1;
    const { data, error } = await build(from, to);
    if (error) throw error;
    const page = data ?? [];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
}

function searchLabel(filterJson: unknown, searchId: string): string {
  if (filterJson !== null && typeof filterJson === "object" && "label" in filterJson) {
    const label = (filterJson as { label?: unknown }).label;
    if (typeof label === "string" && label.length > 0) return label;
  }
  return searchId;
}

// ---------------------------------------------------------------------------
// Pipeline screen source
// ---------------------------------------------------------------------------

export async function fetchLeadRows(): Promise<LeadRowRaw[]> {
  const db = getDb();

  const rows = await fetchAllRows<{ person_urn: string; search_id: string; captured_at: string }>(
    (from, to) =>
      db
        .from("search_results")
        .select("person_urn, search_id, captured_at")
        .not("person_urn", "is", null)
        .order("captured_at", { ascending: true })
        .range(from, to),
  );
  if (rows.length === 0) return [];

  const personUrns = [...new Set(rows.map((r) => r.person_urn))];
  const searchIds = [...new Set(rows.map((r) => r.search_id))];

  type PersonRow = {
    urn: string; name: string | null; headline: string | null; location: string | null;
    current_company_urn: string | null; last_seen: string | null;
  };
  type SearchRow = { search_id: string; filter_json: unknown };
  type PipelineRow = { person_urn: string; status: string | null; contacted_at: string | null };
  type PersonUrnRow = { person_urn: string };

  const [persons, searches, pipelineRows, expRows, postsRows] = await Promise.all([
    fetchAllRows<PersonRow>((from, to) =>
      db
        .from("persons")
        .select("urn, name, headline, location, current_company_urn, last_seen")
        .in("urn", personUrns)
        .order("urn", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<SearchRow>((from, to) =>
      db.from("searches").select("search_id, filter_json").in("search_id", searchIds).order("search_id", { ascending: true }).range(from, to),
    ),
    fetchAllRows<PipelineRow>((from, to) =>
      db
        .from("lead_pipeline")
        .select("person_urn, status, contacted_at")
        .in("person_urn", personUrns)
        .order("person_urn", { ascending: true })
        .range(from, to),
    ),
    fetchAllRows<PersonUrnRow>((from, to) =>
      db.from("person_experience").select("person_urn").in("person_urn", personUrns).order("person_urn", { ascending: true }).range(from, to),
    ),
    fetchAllRows<PersonUrnRow>((from, to) =>
      db.from("person_posts").select("person_urn").in("person_urn", personUrns).order("person_urn", { ascending: true }).range(from, to),
    ),
  ]);

  const companyUrns = [...new Set(persons.map((p) => p.current_company_urn).filter((u): u is string => u !== null))];

  const companies =
    companyUrns.length === 0
      ? []
      : await fetchAllRows<{ urn: string; name: string | null }>((from, to) =>
          db.from("companies").select("urn, name").in("urn", companyUrns).order("urn", { ascending: true }).range(from, to),
        );

  const personByUrn = new Map(persons.map((p) => [p.urn, p]));
  const searchById = new Map(searches.map((s) => [s.search_id, s]));
  const companyNameByUrn = new Map(companies.map((c) => [c.urn, c.name]));
  const pipelineByUrn = new Map(pipelineRows.map((p) => [p.person_urn, p]));
  const hasExperienceSet = new Set(expRows.map((r) => r.person_urn));
  const hasPostsSet = new Set(postsRows.map((r) => r.person_urn));

  const out: LeadRowRaw[] = [];
  for (const r of rows) {
    // A search_results row with no matching persons entity yet is a freshly harvested
    // lead that profile.get hasn't enriched — exactly the "needs research" queue. Keep
    // it, with null person fields, rather than dropping it.
    const person = personByUrn.get(r.person_urn);
    const search = searchById.get(r.search_id);
    const label = searchLabel(search?.filter_json, r.search_id);
    const pipelineRow = pipelineByUrn.get(r.person_urn);
    out.push({
      personUrn: r.person_urn,
      name: person?.name ?? null,
      headline: person?.headline ?? null,
      location: person?.location ?? null,
      companyUrn: person?.current_company_urn ?? null,
      companyName: person?.current_company_urn
        ? companyNameByUrn.get(person.current_company_urn) ?? null
        : null,
      hasExperience: hasExperienceSet.has(r.person_urn),
      hasPosts: hasPostsSet.has(r.person_urn),
      status: (pipelineRow?.status as PipelineStatus | undefined) ?? null,
      contactedAt: pipelineRow?.contacted_at ?? null,
      searchLabel: label,
      searchCapturedAt: r.captured_at,
      lastActivity: person?.last_seen ?? null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dossier screen source
// ---------------------------------------------------------------------------

export async function fetchLeadDetail(urn: string): Promise<LeadDetailRaw | null> {
  const db = getDb();

  const { data: person, error: personErr } = await db
    .from("persons")
    .select("urn, name, headline, location, vanity, last_seen, current_company_urn")
    .eq("urn", urn)
    .maybeSingle();
  if (personErr) throw personErr;
  if (!person) return null;

  const [expRes, postsRes, pipelineRes, searchResultsRes] = await Promise.all([
    db.from("person_experience").select("title, company_name, is_current").eq("person_urn", urn),
    db
      .from("person_posts")
      .select("posted_at, text, reactions, comments")
      .eq("person_urn", urn)
      .order("posted_at", { ascending: false })
      .limit(10),
    db.from("lead_pipeline").select("status, note").eq("person_urn", urn).maybeSingle(),
    db
      .from("search_results")
      .select("search_id, run_ref, captured_at")
      .eq("person_urn", urn)
      .order("captured_at", { ascending: false }),
  ]);
  if (expRes.error) throw expRes.error;
  if (postsRes.error) throw postsRes.error;
  if (pipelineRes.error) throw pipelineRes.error;
  if (searchResultsRes.error) throw searchResultsRes.error;

  const searchResults = searchResultsRes.data ?? [];
  const runRefs = new Set<string>();
  let foundBy: { label: string; capturedAt: string } | null = null;

  if (searchResults.length > 0) {
    const searchIds = [...new Set(searchResults.map((r) => r.search_id as string))];
    const { data: searches, error: searchesErr } = await db
      .from("searches")
      .select("search_id, filter_json")
      .in("search_id", searchIds);
    if (searchesErr) throw searchesErr;
    const labelBySearchId = new Map(
      (searches ?? []).map((s) => [s.search_id as string, searchLabel(s.filter_json, s.search_id as string)]),
    );
    const newest = searchResults[0]; // already ordered newest-first
    foundBy = {
      label: labelBySearchId.get(newest.search_id) ?? newest.search_id,
      capturedAt: newest.captured_at,
    };
    for (const r of searchResults) {
      if (r.run_ref) runRefs.add(r.run_ref as string);
    }
  }

  let company: LeadDetailRaw["company"] = null;
  let companyPosts: CompanyPostRow[] = [];
  let jobs: JobRow[] = [];
  let hasCompanyPeople = false;

  if (person.current_company_urn) {
    const companyUrn = person.current_company_urn as string;
    const [companyRes, companyPostsRes, jobsRes, companyPeopleRes] = await Promise.all([
      db
        .from("companies")
        .select("name, size_range, industry, hq, website, about, last_seen")
        .eq("urn", companyUrn)
        .maybeSingle(),
      db
        .from("company_posts")
        .select("posted_at, text")
        .eq("company_urn", companyUrn)
        .order("posted_at", { ascending: false })
        .limit(5),
      db
        .from("jobs")
        .select("title, posted_at")
        .eq("company_urn", companyUrn)
        .order("posted_at", { ascending: false })
        .limit(10),
      // Existence-only: one column, one row, never pulled into the detail payload.
      db.from("company_people").select("company_urn").eq("company_urn", companyUrn).limit(1),
    ]);
    if (companyRes.error) throw companyRes.error;
    if (companyPostsRes.error) throw companyPostsRes.error;
    if (jobsRes.error) throw jobsRes.error;
    if (companyPeopleRes.error) throw companyPeopleRes.error;

    if (companyRes.data) {
      company = {
        name: companyRes.data.name,
        sizeRange: companyRes.data.size_range,
        industry: companyRes.data.industry,
        hq: companyRes.data.hq,
        website: companyRes.data.website,
        about: companyRes.data.about,
        lastSeen: companyRes.data.last_seen,
      };
    }
    companyPosts = (companyPostsRes.data ?? []).map((p) => ({ postedAt: p.posted_at, text: p.text }));
    jobs = (jobsRes.data ?? []).map((j) => ({ title: j.title, postedAt: j.posted_at }));
    hasCompanyPeople = (companyPeopleRes.data ?? []).length > 0;
  }

  // Best-effort: runs whose args mention this person's urn or vanity, in addition to the
  // run(s) directly referenced by their search_results rows. Absence is fine — a failure
  // here must not sink the rest of the dossier.
  try {
    const orClauses = [`args::text.ilike.%${urn}%`];
    if (person.vanity) orClauses.push(`args::text.ilike.%${person.vanity}%`);
    const { data: argRuns, error: argRunsErr } = await db.from("runs").select("run_id").or(orClauses.join(","));
    if (argRunsErr) throw argRunsErr;
    for (const r of argRuns ?? []) runRefs.add(r.run_id as string);
  } catch {
    // best-effort — a broken ilike/or probe never blocks the dossier.
  }

  let rawPaths: string[] = [];
  if (runRefs.size > 0) {
    const { data: captures, error: capturesErr } = await db
      .from("raw_captures")
      .select("storage_path")
      .in("run_id", [...runRefs]);
    if (capturesErr) throw capturesErr;
    rawPaths = (captures ?? []).map((c) => c.storage_path as string);
  }

  return {
    person: {
      urn: person.urn,
      name: person.name,
      headline: person.headline,
      location: person.location,
      vanity: person.vanity,
      lastSeen: person.last_seen,
    },
    status: (pipelineRes.data?.status as PipelineStatus | undefined) ?? null,
    note: pipelineRes.data?.note ?? null,
    experience: (expRes.data ?? []).map((e) => ({
      title: e.title,
      companyName: e.company_name,
      isCurrent: e.is_current,
    })),
    posts: (postsRes.data ?? []).map((p) => ({
      postedAt: p.posted_at,
      text: p.text,
      reactions: p.reactions,
      comments: p.comments,
    })),
    companyUrn: person.current_company_urn,
    company,
    companyPosts,
    jobs,
    hasCompanyPeople,
    foundBy,
    rawPaths,
  };
}

// ---------------------------------------------------------------------------
// Searches screen source
// ---------------------------------------------------------------------------

export async function fetchSearchSummaries(): Promise<SearchSummaryRaw[]> {
  const db = getDb();

  type SearchRow = { search_id: string; kind: string; filter_url: string | null; filter_json: unknown; created_at: string };
  const rows = await fetchAllRows<SearchRow>((from, to) =>
    db
      .from("searches")
      .select("search_id, kind, filter_url, filter_json, created_at")
      .order("created_at", { ascending: false })
      .range(from, to),
  );
  if (rows.length === 0) return [];

  // Result counts must be exact, not a count of a possibly-capped fetch (max_rows = 1000
  // in supabase/config.toml). head:true issues a HEAD request and reads the count from the
  // Content-Range header — no rows are transferred or capped.
  const counts = await Promise.all(
    rows.map(async (s) => {
      const { count, error } = await db
        .from("search_results")
        .select("search_id", { count: "exact", head: true })
        .eq("search_id", s.search_id);
      if (error) throw error;
      return [s.search_id, count ?? 0] as const;
    }),
  );
  const countBySearchId = new Map(counts);

  return rows.map((s) => ({
    searchId: s.search_id,
    kind: s.kind,
    label: searchLabel(s.filter_json, s.search_id),
    filterUrl: s.filter_url,
    createdAt: s.created_at,
    resultCount: countBySearchId.get(s.search_id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Machine screen source
// ---------------------------------------------------------------------------

export async function fetchMachine(): Promise<MachineRaw> {
  const db = getDb();

  const { data: runRows, error: runsErr } = await db
    .from("runs")
    .select("run_id, capability, status, page_loads, search_credits, elapsed_ms, started_at, ended_at, exit_code")
    .order("started_at", { ascending: false })
    .limit(50);
  if (runsErr) throw runsErr;

  // budget_ledger is never written by anything in this repo — the ledger of record is
  // runs/budget.ndjson, and its populated DB mirror is runs.page_loads / runs.search_credits.
  // The window is a rolling last-24-hours, not calendar midnight, to match the budget
  // enforcer's own rolling DAY_MS window (src/core/budget/ledger.ts).
  const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
  type SpendRow = { page_loads: number; search_credits: number };
  const spendRows = await fetchAllRows<SpendRow>((from, to) =>
    db
      .from("runs")
      .select("page_loads, search_credits")
      .gte("started_at", windowStart.toISOString())
      .order("started_at", { ascending: false })
      .range(from, to),
  );
  const spend24h = spendRows.reduce(
    (acc, r) => ({ pageLoads: acc.pageLoads + r.page_loads, searchCredits: acc.searchCredits + r.search_credits }),
    { pageLoads: 0, searchCredits: 0 },
  );

  const { data: driftRows, error: driftErr } = await db
    .from("parse_drift")
    .select("id, ts, capability, field, shape_hash, n")
    .order("ts", { ascending: false })
    .limit(20);
  if (driftErr) throw driftErr;

  return {
    runs: (runRows ?? []).map((r) => ({
      runId: r.run_id,
      capability: r.capability,
      status: r.status,
      pageLoads: r.page_loads,
      searchCredits: r.search_credits,
      elapsedMs: r.elapsed_ms,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      exitCode: r.exit_code,
    })),
    spend24h,
    drift: (driftRows ?? []).map((d) => ({
      id: d.id,
      ts: d.ts,
      capability: d.capability,
      field: d.field,
      shapeHash: d.shape_hash,
      n: d.n,
    })),
  };
}
