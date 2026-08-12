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

export interface LedgerRow {
  capability: string;
  pageLoads: number;
  searchCredits: number;
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
  ledger: LedgerRow[];
  drift: DriftRow[];
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

  const { data: results, error: resultsErr } = await db
    .from("search_results")
    .select("person_urn, search_id, captured_at")
    .not("person_urn", "is", null);
  if (resultsErr) throw resultsErr;

  const rows = (results ?? []) as { person_urn: string; search_id: string; captured_at: string }[];
  if (rows.length === 0) return [];

  const personUrns = [...new Set(rows.map((r) => r.person_urn))];
  const searchIds = [...new Set(rows.map((r) => r.search_id))];

  const [personsRes, searchesRes, pipelineRes, expRes, postsRes] = await Promise.all([
    db.from("persons").select("urn, name, headline, location, current_company_urn, last_seen").in("urn", personUrns),
    db.from("searches").select("search_id, filter_json").in("search_id", searchIds),
    db.from("lead_pipeline").select("person_urn, status, contacted_at").in("person_urn", personUrns),
    db.from("person_experience").select("person_urn").in("person_urn", personUrns),
    db.from("person_posts").select("person_urn").in("person_urn", personUrns),
  ]);
  if (personsRes.error) throw personsRes.error;
  if (searchesRes.error) throw searchesRes.error;
  if (pipelineRes.error) throw pipelineRes.error;
  if (expRes.error) throw expRes.error;
  if (postsRes.error) throw postsRes.error;

  const persons = personsRes.data ?? [];
  const companyUrns = [...new Set(persons.map((p) => p.current_company_urn).filter((u): u is string => u !== null))];

  const companiesRes = companyUrns.length === 0
    ? { data: [] as { urn: string; name: string | null }[], error: null }
    : await db.from("companies").select("urn, name").in("urn", companyUrns);
  if (companiesRes.error) throw companiesRes.error;

  const personByUrn = new Map(persons.map((p) => [p.urn as string, p]));
  const searchById = new Map((searchesRes.data ?? []).map((s) => [s.search_id as string, s]));
  const companyNameByUrn = new Map((companiesRes.data ?? []).map((c) => [c.urn as string, c.name as string | null]));
  const pipelineByUrn = new Map((pipelineRes.data ?? []).map((p) => [p.person_urn as string, p]));
  const hasExperienceSet = new Set((expRes.data ?? []).map((r) => r.person_urn as string));
  const hasPostsSet = new Set((postsRes.data ?? []).map((r) => r.person_urn as string));

  const out: LeadRowRaw[] = [];
  for (const r of rows) {
    const person = personByUrn.get(r.person_urn);
    if (!person) continue; // search_results row with no matching persons entity yet — skip
    const search = searchById.get(r.search_id);
    const label = searchLabel(search?.filter_json, r.search_id);
    const pipelineRow = pipelineByUrn.get(r.person_urn);
    out.push({
      personUrn: r.person_urn,
      name: person.name,
      headline: person.headline,
      location: person.location,
      companyUrn: person.current_company_urn,
      companyName: person.current_company_urn
        ? companyNameByUrn.get(person.current_company_urn) ?? null
        : null,
      hasExperience: hasExperienceSet.has(r.person_urn),
      hasPosts: hasPostsSet.has(r.person_urn),
      status: (pipelineRow?.status as PipelineStatus | undefined) ?? null,
      contactedAt: pipelineRow?.contacted_at ?? null,
      searchLabel: label,
      searchCapturedAt: r.captured_at,
      lastActivity: person.last_seen,
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

  const { data: searches, error } = await db
    .from("searches")
    .select("search_id, kind, filter_url, filter_json, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;

  const rows = searches ?? [];
  if (rows.length === 0) return [];

  const { data: resultRows, error: resultErr } = await db.from("search_results").select("search_id");
  if (resultErr) throw resultErr;

  const counts = new Map<string, number>();
  for (const r of resultRows ?? []) {
    const id = r.search_id as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return rows.map((s) => ({
    searchId: s.search_id,
    kind: s.kind,
    label: searchLabel(s.filter_json, s.search_id),
    filterUrl: s.filter_url,
    createdAt: s.created_at,
    resultCount: counts.get(s.search_id) ?? 0,
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

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data: ledgerRows, error: ledgerErr } = await db
    .from("budget_ledger")
    .select("capability, page_loads, search_credits")
    .gte("ts", todayStart.toISOString());
  if (ledgerErr) throw ledgerErr;

  const sums = new Map<string, { pageLoads: number; searchCredits: number }>();
  for (const r of ledgerRows ?? []) {
    const cur = sums.get(r.capability) ?? { pageLoads: 0, searchCredits: 0 };
    cur.pageLoads += r.page_loads;
    cur.searchCredits += r.search_credits;
    sums.set(r.capability, cur);
  }

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
    ledger: [...sums.entries()].map(([capability, v]) => ({
      capability,
      pageLoads: v.pageLoads,
      searchCredits: v.searchCredits,
    })),
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
