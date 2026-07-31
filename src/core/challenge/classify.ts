import { CapabilityError, EXIT } from "../run/receipt.js";
import type { FailureAction, ExitCode } from "../run/receipt.js";
import {
  APP_PATH_PREFIXES,
  CHALLENGE_EXACT_PATHS,
  CHALLENGE_PATHS,
  LINKEDIN_DENIED_STATUS,
  LINKEDIN_HOSTS,
  LINKEDIN_HOST_SUFFIX,
  TEXT_MARKERS,
} from "./constants.js";

/**
 * What LinkedIn is doing to this session.
 *
 * `unrecognized` is not a hedge — it is a verdict with an exit code and an
 * operator action, and it exists because the classifier's clean answer is an
 * allowlist (D60): a LinkedIn page that is neither a known challenge nor a known
 * part of the app halts the run rather than being parsed.
 */
export type ChallengeKind =
  | "clean"
  /** A captcha widget is in front of us. */
  | "captcha"
  /** A verification interstitial: email code, two-step, identity confirmation. */
  | "checkpoint"
  /** Bounced to a login surface — the session is dead, not challenged. */
  | "login"
  /** LinkedIn is throttling: HTTP 429, or its own "try again later" wording. */
  | "rate-limited"
  /** The account itself is restricted ("unusual activity", profile-view limits). */
  | "restricted"
  /** A LinkedIn page this classifier cannot vouch for. */
  | "unrecognized";

/** Which input produced the verdict. Diagnostic only — it never changes the class. */
export type ChallengeSignal = "url" | "status" | "dom" | "none";

export type CleanVerdict = {
  kind: "clean";
  clean: true;
  signal: ChallengeSignal;
  detail: string;
};

export type ChallengeDetection = {
  kind: Exclude<ChallengeKind, "clean">;
  clean: false;
  signal: ChallengeSignal;
  /** Short, human-readable, and safe to print: a path, a status, or the matched
   *  marker itself — never page text, which is captured LinkedIn data. */
  detail: string;
  retryAfterMs?: number;
};

export type ChallengeVerdict = CleanVerdict | ChallengeDetection;

/**
 * Which kind wins when two signals disagree, most decisive first.
 *
 * `captcha` and `checkpoint` lead because they are the page telling us outright
 * what it is. `restricted` and `login` are facts about the account and the
 * session. `rate-limited` sits below them because it can legitimately co-occur
 * with any of the above and is the only recoverable one. `unrecognized` is last
 * because it is the *absence* of an identification, so any positive one beats it.
 */
export const CHALLENGE_PRECEDENCE: ReadonlyArray<ChallengeDetection["kind"]> = [
  "captcha",
  "checkpoint",
  "restricted",
  "login",
  "rate-limited",
  "unrecognized",
];

/** One code, one exit, one operator action per kind. Nothing shares a code:
 *  a receipt has to tell "solve the captcha" from "log in again" from
 *  "come look at a page we don't know". */
const ERROR_CLASS: Record<
  ChallengeDetection["kind"],
  { code: string; exit: ExitCode; action: FailureAction; retryable: boolean }
> = {
  captcha: { code: "CHALLENGE_CAPTCHA", exit: EXIT.CHALLENGE, action: "HALT_AND_NOTIFY", retryable: false },
  checkpoint: { code: "CHALLENGE_CHECKPOINT", exit: EXIT.CHALLENGE, action: "HALT_AND_NOTIFY", retryable: false },
  restricted: { code: "CHALLENGE_RESTRICTED", exit: EXIT.CHALLENGE, action: "HALT_AND_NOTIFY", retryable: false },
  unrecognized: { code: "CHALLENGE_UNRECOGNIZED", exit: EXIT.CHALLENGE, action: "HALT_AND_NOTIFY", retryable: false },
  login: { code: "SESSION_DEAD", exit: EXIT.AUTH, action: "REAUTH", retryable: false },
  // The one recoverable kind, and the only one whose `retryable` is true: backing
  // off genuinely changes the outcome. Everything else needs a human (D6).
  "rate-limited": { code: "RATE_LIMITED", exit: EXIT.RATE_LIMITED, action: "RETRY_BACKOFF", retryable: true },
};

const CLEAN = (signal: ChallengeSignal, detail: string): CleanVerdict => ({
  kind: "clean", clean: true, signal, detail,
});

const DETECTED = (
  kind: ChallengeDetection["kind"],
  signal: ChallengeSignal,
  detail: string,
  retryAfterMs?: number,
): ChallengeDetection => ({ kind, clean: false, signal, detail, retryAfterMs });

function isLinkedInHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (LINKEDIN_HOSTS as readonly string[]).includes(h) || h.endsWith(LINKEDIN_HOST_SUFFIX);
}

/** The deny list alone: does this path name a challenge surface outright? */
function challengePath(pathname: string): ChallengeDetection | null {
  const p = pathname.toLowerCase();
  for (const { path, kind, detail } of CHALLENGE_EXACT_PATHS) {
    if (p === path) return DETECTED(kind, "url", detail);
  }
  for (const { prefix, kind, detail } of CHALLENGE_PATHS) {
    if (p.startsWith(prefix)) return DETECTED(kind, "url", detail);
  }
  return null;
}

function isAppPath(pathname: string): boolean {
  const p = pathname.toLowerCase();
  return APP_PATH_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Classifies the page the worker tab is sitting on.
 *
 * Deny list first, allowlist second, **halt by default** (D60). The asymmetry is
 * the whole design: a challenge shape nobody has seen before still stops the run,
 * because a false positive costs a manual restart and a false negative costs the
 * account. An unparseable URL is likewise not certifiable.
 *
 * A non-LinkedIn URL is clean: LinkedIn has no opinion about `about:blank` or a
 * local probe page, and the worker tab is legitimately on both.
 */
export function classifyUrl(rawUrl: string): ChallengeVerdict {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return DETECTED("unrecognized", "url", `unparseable url (${rawUrl.length} chars)`);
  }

  if (!isLinkedInHost(parsed.hostname)) return CLEAN("url", `off-site (${parsed.protocol}//${parsed.hostname})`);

  const denied = challengePath(parsed.pathname);
  if (denied) return denied;

  if (isAppPath(parsed.pathname)) return CLEAN("url", parsed.pathname);

  return DETECTED(
    "unrecognized",
    "url",
    `linkedin path outside the known app surface: ${parsed.pathname}`,
  );
}

/**
 * Classifies the rendered page text against LinkedIn's own wording.
 *
 * The detail carries the matched marker and nothing else — the surrounding text
 * is captured LinkedIn data and must never reach a receipt or a log.
 */
export function classifyText(text: string): ChallengeVerdict {
  for (const { kind, pattern } of TEXT_MARKERS) {
    const m = pattern.exec(text);
    if (m) return DETECTED(kind, "dom", `page text: "${m[0]}"`);
  }
  return CLEAN("dom", "no challenge wording");
}

export type ResponseFacts = {
  status: number;
  url: string;
  /** Parsed `Retry-After` in seconds, when the header carried one. */
  retryAfterSeconds?: number;
};

/**
 * Classifies one HTTP response.
 *
 * The URL check here is the **deny list only**, unlike `classifyUrl`. These are
 * two different questions: "is the page we are on a challenge" can be answered by
 * allowlist because the app surface is a short list of product areas, while
 * "is this API response a challenge" cannot — LinkedIn serves hundreds of
 * endpoint paths, and denying by default would halt the run on the first normal
 * request. A response that got *redirected* onto a challenge path is still caught,
 * which is the case that matters.
 */
export function classifyResponse(facts: ResponseFacts): ChallengeVerdict {
  let parsed: URL | null = null;
  try {
    parsed = new URL(facts.url);
  } catch {
    parsed = null;
  }
  if (parsed && isLinkedInHost(parsed.hostname)) {
    const denied = challengePath(parsed.pathname);
    if (denied) return denied;
  }

  if (facts.status === 429) {
    return DETECTED(
      "rate-limited",
      "status",
      "http 429",
      facts.retryAfterSeconds === undefined ? undefined : facts.retryAfterSeconds * 1000,
    );
  }
  if (facts.status === LINKEDIN_DENIED_STATUS) {
    return DETECTED("restricted", "status", `http ${LINKEDIN_DENIED_STATUS} (linkedin request denied)`);
  }
  // Per the task contract: 401/403 on a LinkedIn endpoint means the session is
  // dead. Known imprecision — a 403 can also mean "this member is out of your
  // network" rather than "you are logged out" — and it errs toward halting for
  // reauth, which is the safe direction. Task 15's live run is where a real 403
  // gets looked at.
  if (facts.status === 401 || facts.status === 403) {
    return DETECTED("login", "status", `http ${facts.status}`);
  }

  // A 5xx is a broken server, not a challenge. Classifying it here would put a
  // transient outage under exit 2 and stop a run that should simply retry.
  return CLEAN("status", `http ${facts.status}`);
}

/**
 * Combines verdicts from independent signals. Clean only if every input is clean;
 * otherwise the highest-precedence detection wins.
 */
export function worstVerdict(...verdicts: ChallengeVerdict[]): ChallengeVerdict {
  let worst: ChallengeDetection | null = null;
  for (const v of verdicts) {
    if (v.clean) continue;
    if (worst === null || CHALLENGE_PRECEDENCE.indexOf(v.kind) < CHALLENGE_PRECEDENCE.indexOf(worst.kind)) {
      worst = v;
    }
  }
  return worst ?? CLEAN("none", "no signal reported a challenge");
}

/** Turns a detection into the error its kind maps to, carrying its evidence. */
export function challengeError(d: ChallengeDetection, evidence?: string): CapabilityError {
  const cls = ERROR_CLASS[d.kind];
  return new CapabilityError({
    code: cls.code,
    exit: cls.exit,
    action: cls.action,
    retryable: cls.retryable,
    message: `${d.kind} detected via ${d.signal}: ${d.detail}`,
    evidence,
    retryAfterMs: d.retryAfterMs,
  });
}
