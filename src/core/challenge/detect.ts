import type { CapabilityError } from "../run/receipt.js";
import type { EventFields, EventName } from "../run/events.js";
import {
  challengeError,
  classifyText,
  classifyUrl,
  worstVerdict,
} from "./classify.js";
import type { ChallengeDetection, ChallengeVerdict, CleanVerdict } from "./classify.js";
import { CAPTCHA_SELECTORS, PROBE_TEXT_LIMIT } from "./constants.js";

/**
 * The slice of Task 4's `WorkerTab` the gate needs. Structural, so the whole
 * detector is testable offline against a fake — the classification is the safety
 * property, and it must be provable without a browser.
 */
export type ChallengeTab = {
  evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T>;
};

/** A tab that can produce evidence. Task 4's `WorkerTab` satisfies it. */
export type ShotTab = { screenshot(filePath: string): Promise<unknown> };

/**
 * The run's archive, structurally. Task 6's `RunContext` satisfies it; the gate
 * works without one, because a challenge must still halt a caller that has not
 * opened a run.
 */
export type ChallengeArchive = {
  screenshot?(tab: ShotTab, name: string): Promise<string>;
  checkpoint?(state: unknown): void;
  log?(event: EventName, fields?: EventFields): unknown;
};

export type ChallengeProbe = {
  url: string;
  text: string;
  captcha: boolean;
};

export type ProbeResult = {
  url: string | null;
  text: string | null;
  captcha: boolean;
  /** False when the page could not be read at all. An unreadable page is never
   *  certified clean — see `detectChallenge`. */
  readable: boolean;
};

/**
 * One expression, one round trip: URL, text and captcha-widget presence all
 * describe the same instant. Reading the URL separately from the body would let
 * a redirect land between the two reads and produce a verdict about a page that
 * never existed — a clean URL paired with a challenge body, or the reverse.
 *
 * A matched widget only counts if it is shown: on-screen, sized, and not hidden
 * by computed style. LinkedIn mounts Google's *invisible* reCAPTCHA Enterprise
 * on some pages purely for tracking (the pemberly.tracking.recaptcha.v3
 * experiment; first seen on the company surface, D183) — a display:none badge
 * plus an iframe parked at left:-9999px — and that is not a challenge anyone is
 * being asked to solve. A widget whose visibility cannot be judged still counts
 * as shown, so every failure widens detection rather than narrowing it.
 *
 * This is one of the four DOM reads D1 permits.
 */
export const PROBE_EXPRESSION = `(() => {
  try {
    var sel = ${JSON.stringify(CAPTCHA_SELECTORS)};
    var de = document.documentElement;
    var vw = (de && de.clientWidth) || 0;
    var vh = (de && de.clientHeight) || 0;
    var view = document.defaultView;
    var shown = function (el) {
      try {
        var r = el.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) return false;
        if (r.right <= 0 || r.bottom <= 0) return false;
        if (vw > 0 && r.left >= vw) return false;
        if (vh > 0 && r.top >= vh) return false;
        if (view && view.getComputedStyle) {
          var s = view.getComputedStyle(el);
          if (s && (s.display === "none" || s.visibility === "hidden")) return false;
        }
        return true;
      } catch (e) { return true; }
    };
    var captcha = false;
    for (var i = 0; i < sel.length && !captcha; i++) {
      try {
        var found = document.querySelectorAll(sel[i]);
        for (var j = 0; j < found.length; j++) {
          if (shown(found[j])) { captcha = true; break; }
        }
      } catch (e) {}
    }
    var body = document.body;
    return {
      url: location.href,
      text: body ? String(body.innerText || "").slice(0, ${PROBE_TEXT_LIMIT}) : "",
      captcha: captcha,
    };
  } catch (e) {
    return null;
  }
})()`;

/**
 * Reads the page. Never throws: a page that cannot be read is a fact the gate has
 * to classify, not an error to propagate — the caller asked "are we challenged",
 * and "we cannot tell" is an answer with consequences (see `detectChallenge`).
 */
export async function probeTab(tab: ChallengeTab): Promise<ProbeResult> {
  let probe: ChallengeProbe | null = null;
  try {
    probe = await tab.evaluate<ChallengeProbe | null>(PROBE_EXPRESSION);
  } catch {
    probe = null;
  }
  if (probe === null || typeof probe !== "object" || typeof probe.url !== "string") {
    return { url: null, text: null, captcha: false, readable: false };
  }
  return {
    url: probe.url,
    text: typeof probe.text === "string" ? probe.text : "",
    captcha: probe.captcha === true,
    readable: true,
  };
}

/**
 * The gate. Runs after every navigation and before every parse.
 *
 * Three independent signals are combined and the worst one wins: the URL
 * (deny list, then allowlist, then halt — D60), the rendered text against
 * LinkedIn's own wording, and whether a captcha widget is mounted. A page that
 * could not be read at all contributes `unrecognized`, so an unreadable page is
 * never certified clean; if the URL already named a specific challenge, that
 * more specific verdict still wins.
 */
export async function detectChallenge(tab: ChallengeTab): Promise<ChallengeVerdict> {
  const probe = await probeTab(tab);

  const signals: ChallengeVerdict[] = [];

  if (probe.url === null) {
    signals.push({
      kind: "unrecognized",
      clean: false,
      signal: "dom",
      detail: "the page could not be read at all (no url, no body)",
    });
  } else {
    signals.push(classifyUrl(probe.url));
  }

  if (probe.text === null) {
    signals.push({
      kind: "unrecognized",
      clean: false,
      signal: "dom",
      detail: "page body could not be read, so it cannot be cleared",
    });
  } else {
    signals.push(classifyText(probe.text));
  }

  if (probe.captcha) {
    signals.push({
      kind: "captcha",
      clean: false,
      signal: "dom",
      detail: "a captcha widget is mounted on the page",
    });
  }

  return worstVerdict(...signals);
}

/**
 * Turns a detection into the error its kind maps to, having first preserved
 * everything an operator needs: the checkpoint, the screenshot, the event.
 *
 * Every step is individually guarded, and the order is deliberate. The checkpoint
 * goes first because it is a local disk write that a wedged or dying browser
 * cannot take away, and it is what makes the run resumable after the human
 * clears the challenge. The screenshot goes second because it needs the browser.
 *
 * Nothing here can change the outcome: evidence gathering that fails degrades the
 * receipt, never the halt. A challenge that stopped being a halt because the
 * shots directory was read-only is the exact failure this whole module exists to
 * prevent.
 */
export async function recordChallenge(o: {
  detection: ChallengeDetection;
  tab: ShotTab;
  run?: ChallengeArchive;
  state?: unknown;
}): Promise<CapabilityError> {
  const { detection, tab, run, state } = o;
  const notes: string[] = [];

  try {
    run?.log?.("challenge.detected", {
      level: "error",
      detail: { kind: detection.kind, signal: detection.signal, detail: detection.detail },
    });
  } catch (cause) {
    notes.push(`event log failed: ${String(cause)}`);
  }

  if (state !== undefined) {
    try {
      run?.checkpoint?.(state);
    } catch (cause) {
      notes.push(`checkpoint failed: ${String(cause)}`);
    }
  }

  let evidence: string | undefined;
  try {
    evidence = await run?.screenshot?.(tab, `challenge-${detection.kind}`);
  } catch (cause) {
    notes.push(`screenshot failed: ${String(cause)}`);
  }

  const err = challengeError(detection, evidence);
  if (notes.length === 0) return err;

  // Rebuilt rather than mutated: CapabilityError's fields are readonly, and the
  // class must survive verbatim — only the message gains the note.
  return challengeError(
    { ...detection, detail: `${detection.detail} [${notes.join("; ")}]` },
    evidence,
  );
}

/**
 * The call site shape: check the tab, carry on if clean, halt if not.
 *
 * Throws the `CapabilityError` for the kind detected — exit 2 for a challenge,
 * 4 for a dead session, 3 for a throttle. Never solves anything, never retries
 * (D6).
 */
export async function assertNoChallenge(o: {
  tab: ChallengeTab & ShotTab;
  run?: ChallengeArchive;
  state?: unknown;
}): Promise<CleanVerdict> {
  const verdict = await detectChallenge(o.tab);
  if (verdict.clean) return verdict;
  throw await recordChallenge({ detection: verdict, tab: o.tab, run: o.run, state: o.state });
}
