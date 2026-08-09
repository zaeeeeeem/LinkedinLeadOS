import { CapabilityError, EXIT } from "../../core/run/receipt.js";

/**
 * A job-posting target, canonicalized.
 *
 * **The canonical id is the bare numeric posting id** (D260). It is what §7's
 * `jobs.id` primary key holds, what `ref` dedupes on, and what
 * `urn:li:fsd_jobPosting:<id>` is built from — one form across `job.get`,
 * `company.jobs` and anything else that ever writes the `jobs` table. Every
 * other spelling LinkedIn uses (a slugged `/jobs/view/` segment, a
 * `currentJobId` query parameter, a urn) is an *input* form that reduces to it.
 */
export type JobTarget = {
  kind: "job";
  /** The URL the worker tab navigates to — always the canonical detail page. */
  url: string;
  /** Stable identity for this target: the `ref` on events and on ledger lines. */
  ref: string;
  /** The numeric posting id, as a string. Ids exceed 2^53, so never a number. */
  id: string;
  /** The urn form, for cross-checking against bodies and against session urns. */
  urn: string;
};

/**
 * A LinkedIn job posting id. Numeric, currently ten digits and growing; the
 * bounds are wide because the length is LinkedIn's to change and narrow enough
 * that a stray `4` or a tracking number cannot pass as one.
 */
const JOB_ID = /^[0-9]{5,20}$/;

/** `/jobs/view/<id>` and the slugged share form `/jobs/view/<title>-at-<co>-<id>`. */
const SLUGGED_ID = /^(?:.*-)?([0-9]{5,20})$/;

/** `urn:li:fsd_jobPosting:4012345678` and its older spellings. */
const JOB_URN = /^urn:li:(?:fsd_jobPosting|fs_normalized_jobPosting|jobPosting):([0-9]{5,20})$/;

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_LINKEDIN_HOST = /^\/?(?:[a-z0-9-]+\.)*linkedin\.com\//i;

const ACCEPTED =
  "accepted forms: https://www.linkedin.com/jobs/view/<id>, a listing url carrying " +
  "?currentJobId=<id>, a bare numeric posting id, or urn:li:fsd_jobPosting:<id>";

function invalid(input: string, why: string): CapabilityError {
  return new CapabilityError({
    code: "JOB_URL_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: `${why}; ${ACCEPTED}`,
    // The operator typed this, so echoing it leaks nothing they do not already
    // have, and a receipt that omits it cannot be acted on.
    evidence: input.length > 300 ? `${input.slice(0, 300)}… (${input.length} chars)` : input,
  });
}

function isLinkedInHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "linkedin.com" || h.endsWith(".linkedin.com");
}

function targetFor(id: string): JobTarget {
  return {
    kind: "job",
    url: `https://www.linkedin.com/jobs/view/${id}/`,
    ref: `job:${id}`,
    id,
    urn: `urn:li:fsd_jobPosting:${id}`,
  };
}

/**
 * Turns whatever the operator passed into one canonical job target, or refuses
 * it loudly.
 *
 * Pure and total: no I/O, one error class, and it runs before anything is
 * navigated or spent, so a typo costs nothing.
 *
 * Two deliberate refusals rather than guesses. A `/jobs/search` or
 * `/jobs/collections` url with **no** `currentJobId` names no posting — opening
 * it would spend a page load on whichever job LinkedIn happens to select, and a
 * capture keyed to a job nobody asked for is worse than an error. And a
 * `/jobs/view/` segment with no trailing digit run is refused rather than
 * navigated: LinkedIn resolves some non-numeric segments by redirect, and a
 * target whose id is only known *after* the load cannot be budget-deduped or
 * keyed before it.
 */
export function normalizeJobUrl(rawInput: string): JobTarget {
  const input = rawInput.trim();
  if (input === "") throw invalid(rawInput, "the job url is empty");

  const urn = JOB_URN.exec(input);
  if (urn) return targetFor(urn[1]!);

  if (JOB_ID.test(input)) return targetFor(input);

  // A bare `jobs/view/<id>` or `/jobs/view/<id>`, which is neither a url nor an id.
  const barePath = /^\/?jobs\/view\/([^/?#]+)/i.exec(input);
  if (barePath && !HAS_SCHEME.test(input)) return fromSegment(rawInput, barePath[1]!);

  const looksLikeUrl = HAS_SCHEME.test(input) || BARE_LINKEDIN_HOST.test(input);
  if (!looksLikeUrl) {
    throw invalid(rawInput, `"${input}" is neither a url nor a numeric job posting id`);
  }
  if (HAS_SCHEME.test(input) && !/^https?:/i.test(input)) {
    throw invalid(rawInput, "only http and https urls are accepted");
  }

  const withScheme = HAS_SCHEME.test(input) ? input : `https://${input.replace(/^\//, "")}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw invalid(rawInput, "the url could not be parsed");
  }
  if (!isLinkedInHost(url.hostname)) {
    throw invalid(rawInput, `${url.hostname} is not a linkedin.com host`);
  }

  const segments = url.pathname.split("/").filter((s) => s !== "");
  const head = (segments[0] ?? "").toLowerCase();
  if (head !== "jobs") throw invalid(rawInput, `${url.pathname} is not a job posting url`);

  if ((segments[1] ?? "").toLowerCase() === "view") {
    const segment = segments[2];
    if (segment === undefined) throw invalid(rawInput, "the url has no id segment after /jobs/view/");
    return fromSegment(rawInput, segment);
  }

  // A listing page — `/jobs/collections/recommended`, `/jobs/search` — names the
  // open posting in `currentJobId`. That is a real id, so it is accepted, but
  // the target is still the canonical detail page: this capability measures the
  // detail surface, and the pane inside a listing is a different one.
  const current = url.searchParams.get("currentJobId");
  if (current !== null && JOB_ID.test(current)) return targetFor(current);

  throw invalid(
    rawInput,
    `${url.pathname} names no job posting (no /jobs/view/<id> segment and no currentJobId)`,
  );
}

function fromSegment(input: string, segment: string): JobTarget {
  const decoded = decodeSafely(segment);
  const m = SLUGGED_ID.exec(decoded);
  if (!m) throw invalid(input, `"${decoded}" carries no numeric job posting id`);
  return targetFor(m[1]!);
}

/** Percent-decoding that cannot throw on a malformed escape. */
function decodeSafely(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
