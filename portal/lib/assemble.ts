// portal/lib/assemble.ts
//
// PURE, tested: raw rows in, screen models out. No I/O, no Date.now() — `now` is always
// passed in so tests are deterministic.

import { companyDepth, effectiveStatus, personDepth, type CompanyDepth, type PersonDepth, type PipelineStatus } from "./depth";
import type { DossierData } from "./dossier";
import type { LeadDetailRaw, LeadRowRaw } from "./queries";

export interface LeadListItem {
  urn: string;
  name: string | null;
  title: string | null;
  companyName: string | null;
  location: string | null;
  status: PipelineStatus;
  depth: PersonDepth;
  searchLabel: string | null;
  lastActivity: string | null;
  needsResearch: boolean;
  contactedDaysAgo: number | null;
}

const MS_PER_DAY = 86_400_000;

function daysAgo(iso: string | null, now: Date): number | null {
  if (iso === null) return null;
  return Math.floor((now.getTime() - new Date(iso).getTime()) / MS_PER_DAY);
}

export function assembleLeadList(raw: LeadRowRaw[], now: Date): LeadListItem[] {
  // search_results is append-only, so the same person can show up once per search they
  // were found by. Collapse to one item per person, keeping the row with the newest
  // searchCapturedAt for the search label (ISO timestamps compare lexically).
  const newestByUrn = new Map<string, LeadRowRaw>();
  for (const row of raw) {
    const existing = newestByUrn.get(row.personUrn);
    if (!existing || row.searchCapturedAt > existing.searchCapturedAt) {
      newestByUrn.set(row.personUrn, row);
    }
  }

  const items: LeadListItem[] = [];
  for (const row of newestByUrn.values()) {
    const depth = personDepth({
      hasHeadline: row.headline !== null,
      hasExperience: row.hasExperience,
      hasPosts: row.hasPosts,
    });
    items.push({
      urn: row.personUrn,
      name: row.name,
      title: row.headline,
      companyName: row.companyName,
      location: row.location,
      status: effectiveStatus(row.status, depth),
      depth,
      searchLabel: row.searchLabel,
      lastActivity: row.lastActivity,
      needsResearch: depth < 3,
      contactedDaysAgo: daysAgo(row.contactedAt, now),
    });
  }
  return items;
}

export function assembleDossierData(raw: LeadDetailRaw): DossierData {
  const hasHeadline = raw.person.headline !== null;
  const hasExperience = raw.experience.length > 0;
  const hasPosts = raw.posts.length > 0;
  const depth = personDepth({ hasHeadline, hasExperience, hasPosts });
  const status = effectiveStatus(raw.status, depth);

  const hasCompanyUrn = raw.companyUrn !== null;
  const hasCompanyRow = raw.company !== null;
  const hasDetail =
    raw.company !== null &&
    (raw.company.industry !== null || raw.company.sizeRange !== null || raw.company.about !== null);
  const hasActivity = raw.companyPosts.length > 0 || raw.jobs.length > 0;
  const cDepth: CompanyDepth = companyDepth({ hasCompanyUrn, hasCompanyRow, hasDetail, hasActivity });

  const missing: string[] = [];
  if (depth < 2) missing.push("SN profile (D2)");
  if (depth < 3) missing.push("full profile (D3)");
  if (depth < 4) missing.push("activity (D4)");
  if (hasCompanyUrn) {
    if (cDepth < 2) missing.push("company detail (C2)");
    if (cDepth < 3) missing.push("company activity (C3)");
  }

  return {
    person: raw.person,
    status,
    depth,
    foundBy: raw.foundBy,
    experience: raw.experience,
    posts: raw.posts,
    company:
      raw.company === null
        ? null
        : {
            name: raw.company.name,
            sizeRange: raw.company.sizeRange,
            industry: raw.company.industry,
            hq: raw.company.hq,
            website: raw.company.website,
            about: raw.company.about,
            lastSeen: raw.company.lastSeen,
            depth: cDepth,
          },
    companyPosts: raw.companyPosts,
    jobs: raw.jobs,
    note: raw.note,
    rawPaths: raw.rawPaths,
    missing,
  };
}
