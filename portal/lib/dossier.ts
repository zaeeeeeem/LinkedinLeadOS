// portal/lib/dossier.ts
//
// Builds the markdown dossier an operator copies into an agent prompt.
// Truthfulness rule applies here too: nothing is ever synthesized. A missing
// scalar renders as `?`; an empty or fully-null list section renders its
// heading followed by `_not captured_` rather than vanishing.

import { depthLabel, type CompanyDepth, type PersonDepth, type PipelineStatus } from "./depth";

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

const NOT_CAPTURED = "_not captured_";

function s(v: string | null | undefined): string {
  return v === null || v === undefined || v === "" ? "?" : v;
}

function n(v: number | null | undefined): string {
  return v === null || v === undefined ? "?" : String(v);
}

function headerBlock(d: DossierData): string {
  const lines: string[] = [];
  const name = d.person.name ?? "?";
  const title = d.person.headline ?? "?";
  const company = d.company?.name ?? "?";
  lines.push(`# ${name} — ${title} @ ${company}`);
  if (d.person.vanity !== null) {
    lines.push(`LinkedIn: https://linkedin.com/in/${d.person.vanity}`);
  }
  lines.push(`Status: ${d.status} · Depth: ${depthLabel(d.depth)}`);
  lines.push(
    d.foundBy === null
      ? "Found by: not captured"
      : `Found by: ${d.foundBy.label} (captured ${d.foundBy.capturedAt})`,
  );
  return lines.join("\n");
}

function headlineSection(d: DossierData): string {
  const lines = ["## Headline"];
  if (d.person.headline === null && d.person.location === null) {
    lines.push(NOT_CAPTURED);
  } else {
    lines.push(`${s(d.person.headline)} — ${s(d.person.location)}`);
  }
  return lines.join("\n");
}

function experienceSection(d: DossierData): string {
  const lines = ["## Experience"];
  if (d.experience.length === 0) {
    lines.push(NOT_CAPTURED);
  } else {
    for (const e of d.experience) {
      const current = e.isCurrent ? " (current)" : "";
      lines.push(`- ${s(e.title)} @ ${s(e.companyName)}${current}`);
    }
  }
  return lines.join("\n");
}

function postsSection(d: DossierData): string {
  const lines = ["## Recent posts"];
  if (d.posts.length === 0) {
    lines.push(NOT_CAPTURED);
  } else {
    for (const p of d.posts) {
      lines.push(`- [${s(p.postedAt)}] ${s(p.text)} (${n(p.reactions)} reactions, ${n(p.comments)} comments)`);
    }
  }
  return lines.join("\n");
}

function companyCard(d: DossierData): string {
  const c = d.company;
  const lines = [`## Company: ${c?.name ?? "?"}`];
  if (c === null) {
    lines.push(NOT_CAPTURED);
  } else {
    lines.push(`Size: ${s(c.sizeRange)} · Industry: ${s(c.industry)} · HQ: ${s(c.hq)} · Website: ${s(c.website)}`);
    lines.push(`About: ${s(c.about)}`);
    lines.push(`Last seen: ${s(c.lastSeen)} · Depth: ${c.depth}`);
  }
  return lines.join("\n");
}

function companySection(d: DossierData): string {
  const lines = [companyCard(d)];

  lines.push("", "### Company posts");
  if (d.companyPosts.length === 0) {
    lines.push(NOT_CAPTURED);
  } else {
    for (const p of d.companyPosts) {
      lines.push(`- [${s(p.postedAt)}] ${s(p.text)}`);
    }
  }

  lines.push("", "### Open jobs (hiring signals)");
  if (d.jobs.length === 0) {
    lines.push(NOT_CAPTURED);
  } else {
    for (const j of d.jobs) {
      lines.push(`- ${s(j.title)} (posted ${s(j.postedAt)})`);
    }
  }

  return lines.join("\n");
}

function notesSection(d: DossierData): string {
  return ["## My notes", d.note === null ? NOT_CAPTURED : d.note].join("\n");
}

function rawArchiveSection(d: DossierData): string {
  const lines = ["## Raw archive"];
  if (d.rawPaths.length === 0) {
    lines.push(NOT_CAPTURED);
  } else {
    for (const p of d.rawPaths) {
      lines.push(`- ${p}`);
    }
  }
  return lines.join("\n");
}

function freshnessSection(d: DossierData): string {
  const lines = ["## Data freshness"];
  lines.push(`Person last seen: ${s(d.person.lastSeen)}`);
  lines.push(`Company last seen: ${s(d.company?.lastSeen ?? null)}`);
  lines.push(`missing: ${d.missing.length === 0 ? "none" : d.missing.join(", ")}`);
  return lines.join("\n");
}

export function buildDossier(d: DossierData, variant: "full" | "short"): string {
  const sections = [headerBlock(d)];

  if (variant === "full") {
    sections.push(
      headlineSection(d),
      experienceSection(d),
      postsSection(d),
      companySection(d),
      notesSection(d),
      rawArchiveSection(d),
      freshnessSection(d),
    );
  } else {
    sections.push(
      companyCard(d),
      notesSection(d),
      freshnessSection(d),
    );
  }

  return sections.join("\n\n");
}
