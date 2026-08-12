// portal/lib/depth.ts
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

export function personDepth(i: PersonDepthInputs): PersonDepth {
  if (i.hasPosts) return 4;
  if (i.hasExperience) return 3;
  if (i.hasHeadline) return 2;
  return 1;
}

export function companyDepth(i: CompanyDepthInputs): CompanyDepth {
  if (i.hasActivity) return 3;
  if (i.hasDetail) return 2;
  if (!i.hasCompanyUrn) return 0;
  return 1;
}

export function effectiveStatus(stored: PipelineStatus | null, depth: PersonDepth): PipelineStatus {
  if ((stored === null || stored === "new") && depth >= 3) return "enriched";
  if (stored === null) return "new";
  return stored;
}

export function depthLabel(d: PersonDepth): string {
  switch (d) {
    case 1: return "D1 — SN row";
    case 2: return "D2 — SN profile";
    case 3: return "D3 — Full profile";
    case 4: return "D4 — Activity";
  }
}
