import * as cheerio from "cheerio";
import { type DomHit, type DomProbeReport } from "./dommap.js";

const JOB_URN = /urn:li:(?:fsd_jobPosting|fs_normalized_jobPosting|jobPosting):([0-9]{5,20})/g;

export type JobDomFieldMap = {
  scope: { jobIds: string[]; resolvedId: string | null };
  probes: DomProbeReport[];
  nodesWalked: number;
};

function decoded(html: string): string {
  // Decode only urn punctuation. The document contains unrelated literal `%`
  // characters, so decodeURIComponent over the whole snapshot can throw and
  // silently hide the identity we are required to cross-check.
  return html.replaceAll(/%3A/gi, ":");
}

export function buildJobDomFieldMap(html: string): JobDomFieldMap {
  const $ = cheerio.load(html);
  const ids = new Set<string>();
  for (const match of decoded(html).matchAll(JOB_URN)) ids.add(match[1]!);
  const resolvedId = ids.size === 1 ? [...ids][0]! : null;
  const anchor = $("[data-testid='expandable-text-box']").first();
  const container = anchor.length === 0 ? null : anchor.parent().parent();
  const headings = container?.find("h2").filter((_, n) => $(n).text().replace(/\s+/g, " ").trim() === "About the job");
  const valid = container !== null && headings !== undefined && headings.length === 1;
  const hits: DomHit[] = valid ? [{
    path: '[data-testid="expandable-text-box"]', sample: "description content following the expandable-text-box anchor",
    basis: "attribute", inSubjectScope: ids.size > 0,
  }] : [];
  const probes: DomProbeReport[] = [
    ids.size === 0
      ? { name: "job_id", what: "jobPosting urn candidates cross-checked against the normalized URL", hits: [], miss: "no job posting id found" }
      : { name: "job_id", what: "jobPosting urn candidates cross-checked against the normalized URL", hits: [...ids].map((id) => ({ path: "document", sample: id, basis: "attribute" as const, inSubjectScope: true })) },
    hits.length > 0
      ? { name: "description", what: "paragraphs in the About the job block", hits }
      : { name: "description", what: "paragraphs in the About the job block", hits: [], miss: "no expandable-text-box under an About the job h2" },
  ];
  return { scope: { jobIds: [...ids], resolvedId }, probes, nodesWalked: $("*").length };
}

export function renderJobDomFieldMap(o: { file: string; bytes: number; sourceRun: string; map: JobDomFieldMap }): string {
  const lines = [`## \`${o.file}\` — rendered job DOM snapshot`, "", `- ${o.bytes} bytes of \`outerHTML\`, captured by run \`${o.sourceRun}\``, "- **This is a DOM-sourced job fixture (D305).**", "", "### Subject scope", ""];
  if (o.map.scope.jobIds.length === 0) {
    lines.push("⚠ **No job identity candidate was found.** Do not write a parser against this snapshot.", "");
    return lines.join("\n") + "\n";
  }
  lines.push(`- job id candidates: ${o.map.scope.jobIds.map((id) => `\`${id}\``).join(", ")}`);
  lines.push("- the parser accepts only the candidate equal to the normalized requested URL", "", "### Fields", "");
  for (const p of o.map.probes) {
    lines.push(`#### ${p.name}`, "", p.what, "");
    if (p.hits.length === 0) lines.push(`⚠ **Not found.** ${p.miss ?? ""}`, "");
    else for (const hit of p.hits) lines.push(`- \`${hit.path}\` (${hit.basis}): ${hit.sample}`, "");
  }
  return lines.join("\n") + "\n";
}
