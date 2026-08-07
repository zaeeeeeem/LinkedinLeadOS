import { describe, expect, it, vi } from "vitest";
import {
  PROBE_EXPRESSION,
  assertNoChallenge,
  detectChallenge,
  probeTab,
  recordChallenge,
} from "../src/core/challenge/detect.js";
import type { ChallengeProbe, ChallengeTab } from "../src/core/challenge/detect.js";
import type { ChallengeDetection } from "../src/core/challenge/classify.js";
import { PROBE_TEXT_LIMIT } from "../src/core/challenge/constants.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import type { ShotTab, ChallengeArchive } from "../src/core/challenge/detect.js";
import type { WorkerTab } from "../src/core/session/tab.js";
import type { RunContext, Screenshotter } from "../src/core/run/context.js";

/** A tab that answers the probe with whatever the test hands it. Shaped like the
 *  real `WorkerTab.evaluate`, which resolves the page value or throws a
 *  CapabilityError — it never resolves `undefined` on a page error. */
function fakeTab(
  probe: Partial<ChallengeProbe> | Error,
  opts: { shotFails?: boolean } = {},
): ChallengeTab & { screenshot(p: string): Promise<string>; shots: string[] } {
  const shots: string[] = [];
  return {
    shots,
    async evaluate<T>(): Promise<T> {
      if (probe instanceof Error) throw probe;
      return { url: "https://www.linkedin.com/feed/", text: "", captcha: false, ...probe } as T;
    },
    async screenshot(p: string): Promise<string> {
      if (opts.shotFails) throw new Error("EACCES: shots/ is read-only");
      shots.push(p);
      return p;
    },
  };
}

function fakeRun(opts: { shotFails?: boolean; checkpointFails?: boolean } = {}) {
  const events: { event: string; detail: unknown }[] = [];
  const checkpoints: unknown[] = [];
  return {
    events,
    checkpoints,
    log(event: string, fields?: { detail?: Record<string, unknown> }) {
      events.push({ event, detail: fields?.detail });
      return undefined;
    },
    checkpoint(state: unknown) {
      if (opts.checkpointFails) throw new Error("ENOSPC");
      checkpoints.push(state);
    },
    async screenshot(tab: { screenshot(p: string): Promise<unknown> }, name: string) {
      if (opts.shotFails) throw new Error("EACCES");
      await tab.screenshot(`runs/x/shots/001-${name}.png`);
      return `runs/x/shots/001-${name}.png`;
    },
  };
}

/** A stub element the probe's visibility check can interrogate. `rect` omitted
 *  means "getBoundingClientRect throws" — an element that cannot be judged. */
type StubEl = {
  rect?: { width: number; height: number; top: number; left: number; right: number; bottom: number };
  style?: { display?: string; visibility?: string };
};

function stubEl(el: StubEl) {
  return {
    getBoundingClientRect() {
      if (!el.rect) throw new Error("no layout");
      return el.rect;
    },
    __style: { display: "block", visibility: "visible", ...el.style },
  };
}

/** An on-screen, normally-sized widget — the shape a real challenge has. */
const SHOWN: StubEl = { rect: { width: 300, height: 200, top: 100, left: 100, right: 400, bottom: 300 } };

describe("PROBE_EXPRESSION — run as real JS against a stub document", () => {
  function evalProbe(
    doc: { body: { innerText: string } | null; hits?: Record<string, StubEl[]> },
    href: string,
  ) {
    const fn = new Function(
      "location",
      "document",
      `return (${PROBE_EXPRESSION});`,
    ) as (l: unknown, d: unknown) => ChallengeProbe | null;
    return fn(
      { href },
      {
        body: doc.body,
        documentElement: { clientWidth: 1440, clientHeight: 900 },
        defaultView: {
          getComputedStyle: (el: { __style: unknown }) => el.__style,
        },
        querySelectorAll: (sel: string) => (doc.hits?.[sel] ?? []).map(stubEl),
      },
    );
  }

  it("returns url, text and the captcha flag", () => {
    const r = evalProbe({ body: { innerText: "hello" } }, "https://www.linkedin.com/feed/");
    expect(r).toEqual({ url: "https://www.linkedin.com/feed/", text: "hello", captcha: false });
  });

  it("caps the text it pulls back over the socket", () => {
    const r = evalProbe({ body: { innerText: "x".repeat(PROBE_TEXT_LIMIT * 3) } }, "https://www.linkedin.com/feed/");
    expect(r?.text.length).toBe(PROBE_TEXT_LIMIT);
  });

  it("survives a document with no body", () => {
    const r = evalProbe({ body: null }, "https://www.linkedin.com/feed/");
    expect(r).toEqual({ url: "https://www.linkedin.com/feed/", text: "", captcha: false });
  });

  it("reports a mounted captcha widget when it is actually shown", () => {
    const r = evalProbe(
      { body: { innerText: "" }, hits: { 'iframe[src*="arkoselabs" i]': [SHOWN] } },
      "https://www.linkedin.com/checkpoint/challenge/x",
    );
    expect(r?.captcha).toBe(true);
  });

  // The false positive that halted the first company probe (run
  // 01KZKFR7RNRVA3FXPEJAKDQ30K): LinkedIn's pemberly.tracking.recaptcha.v3
  // experiment mounts Google's invisible reCAPTCHA Enterprise on company pages.
  // The rect/style values below are the badge's, verbatim from the archived
  // snapshot: the anchor iframe sits in a display:none .grecaptcha-badge
  // (zero-size rect), and a sibling iframe is parked at left:-9999px.
  it("ignores the invisible reCAPTCHA tracking badge (zero-size rect)", () => {
    const badge: StubEl = { rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } };
    const r = evalProbe(
      { body: { innerText: "Wispr Flow" }, hits: { 'iframe[title*="captcha" i]': [badge] } },
      "https://www.linkedin.com/company/wisprflow/",
    );
    expect(r?.captcha).toBe(false);
  });

  it("ignores a captcha iframe parked off-screen", () => {
    const offscreen: StubEl = {
      rect: { width: 256, height: 60, top: 0, left: -9999, right: -9743, bottom: 60 },
    };
    const r = evalProbe(
      { body: { innerText: "Wispr Flow" }, hits: { 'iframe[src*="captcha" i]': [offscreen] } },
      "https://www.linkedin.com/company/wisprflow/",
    );
    expect(r?.captcha).toBe(false);
  });

  it("ignores a sized captcha iframe whose computed style hides it", () => {
    const hidden: StubEl = { ...SHOWN, style: { visibility: "hidden" } };
    const r = evalProbe(
      { body: { innerText: "" }, hits: { 'iframe[src*="captcha" i]': [hidden] } },
      "https://www.linkedin.com/company/wisprflow/",
    );
    expect(r?.captcha).toBe(false);
  });

  it("still reports the widget when one match is hidden and another is shown", () => {
    const badge: StubEl = { rect: { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } };
    const r = evalProbe(
      { body: { innerText: "" }, hits: { 'iframe[src*="captcha" i]': [badge, SHOWN] } },
      "https://www.linkedin.com/checkpoint/challenge/x",
    );
    expect(r?.captcha).toBe(true);
  });

  it("treats a widget whose visibility cannot be judged as shown — fail toward detection", () => {
    const unjudgeable: StubEl = {}; // getBoundingClientRect throws
    const r = evalProbe(
      { body: { innerText: "" }, hits: { "#captcha-internal": [unjudgeable] } },
      "https://www.linkedin.com/feed/",
    );
    expect(r?.captcha).toBe(true);
  });
});

describe("probeTab", () => {
  it("reads the page in one evaluate, so url and text describe the same moment", async () => {
    const tab = fakeTab({ url: "https://www.linkedin.com/in/x/", text: "hi" });
    const spy = vi.spyOn(tab, "evaluate");
    const p = await probeTab(tab);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(p).toEqual({ url: "https://www.linkedin.com/in/x/", text: "hi", captcha: false, readable: true });
  });

  it("reports an unreadable page rather than throwing", async () => {
    const p = await probeTab(fakeTab(new Error("context destroyed")));
    expect(p.readable).toBe(false);
    expect(p.url).toBeNull();
  });
});

describe("detectChallenge", () => {
  it("is clean on an ordinary profile page", async () => {
    const v = await detectChallenge(fakeTab({ url: "https://www.linkedin.com/in/x/", text: "About Experience" }));
    expect(v.kind).toBe("clean");
  });

  it("catches the checkpoint bounce from the URL", async () => {
    const v = await detectChallenge(fakeTab({ url: "https://www.linkedin.com/checkpoint/challenge/x", text: "" }));
    expect(v.kind).toBe("checkpoint");
  });

  it("sharpens a checkpoint into a captcha when the widget is mounted", async () => {
    const v = await detectChallenge(
      fakeTab({ url: "https://www.linkedin.com/checkpoint/challenge/x", text: "", captcha: true }),
    );
    expect(v.kind).toBe("captcha");
  });

  it("catches a restriction banner served on a perfectly normal URL", async () => {
    const v = await detectChallenge(
      fakeTab({
        url: "https://www.linkedin.com/in/x/",
        text: "We noticed unusual activity from your account",
      }),
    );
    expect(v.kind).toBe("restricted");
  });

  it("halts on a challenge shape it has never seen", async () => {
    // The test that matters: a page with wording nobody has catalogued, on a
    // path nobody has catalogued, must not read as a normal page.
    const v = await detectChallenge(
      fakeTab({ url: "https://www.linkedin.com/some-2027-security-flow/step-1", text: "Please hold." }),
    );
    expect(v.clean).toBe(false);
    expect(v.kind).toBe("unrecognized");
  });

  it("refuses to certify a page whose body it could not read", async () => {
    const v = await detectChallenge(fakeTab(new Error("context destroyed")));
    expect(v.clean).toBe(false);
    expect(v.kind).toBe("unrecognized");
  });

  it("keeps the specific verdict when the URL is a challenge and the body is unreadable", async () => {
    const tab: ChallengeTab = {
      async evaluate<T>(): Promise<T> {
        throw new CapabilityError({
          code: "TAB_EVAL_FAILED", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF",
          retryable: true, message: "page JS threw",
        });
      },
    };
    // No URL either — the probe is atomic, so an unreadable page yields neither.
    expect((await detectChallenge(tab)).kind).toBe("unrecognized");
  });
});

describe("recordChallenge", () => {
  const detection: ChallengeDetection = {
    kind: "captcha", clean: false, signal: "url", detail: "checkpoint challenge",
  };

  it("screenshots, checkpoints, logs, and returns the classed error", async () => {
    const tab = fakeTab({});
    const run = fakeRun();
    const err = await recordChallenge({ detection, tab, run, state: { page: 3 } });

    expect(err.code).toBe("CHALLENGE_CAPTCHA");
    expect(err.exit).toBe(EXIT.CHALLENGE);
    expect(err.evidence).toBe("runs/x/shots/001-challenge-captcha.png");
    expect(run.checkpoints).toEqual([{ page: 3 }]);
    expect(run.events.map((e) => e.event)).toContain("challenge.detected");
  });

  it("checkpoints BEFORE it screenshots — local disk cannot be taken away by a dying browser", async () => {
    const order: string[] = [];
    const tab = fakeTab({});
    const run = fakeRun();
    const wrapped = {
      ...run,
      checkpoint: (s: unknown) => { order.push("checkpoint"); run.checkpoint(s); },
      screenshot: async (t: { screenshot(p: string): Promise<unknown> }, n: string) => {
        order.push("screenshot");
        return run.screenshot(t, n);
      },
    };
    await recordChallenge({ detection, tab, run: wrapped, state: { page: 1 } });
    expect(order).toEqual(["checkpoint", "screenshot"]);
  });

  it("still returns the halt when the screenshot fails, and says so", async () => {
    const err = await recordChallenge({ detection, tab: fakeTab({}), run: fakeRun({ shotFails: true }) });
    expect(err.code).toBe("CHALLENGE_CAPTCHA");
    expect(err.exit).toBe(EXIT.CHALLENGE);
    expect(err.evidence).toBeUndefined();
    expect(err.message).toMatch(/screenshot failed/i);
  });

  it("still returns the halt when the checkpoint write fails", async () => {
    const run = fakeRun({ checkpointFails: true });
    const err = await recordChallenge({ detection, tab: fakeTab({}), run, state: { page: 9 } });
    expect(err.code).toBe("CHALLENGE_CAPTCHA");
    expect(err.message).toMatch(/checkpoint failed/i);
  });

  it("still returns the halt with no run context at all", async () => {
    const err = await recordChallenge({ detection, tab: fakeTab({}) });
    expect(err.code).toBe("CHALLENGE_CAPTCHA");
    expect(err.evidence).toBeUndefined();
  });

  it("never throws, whatever the run context does", async () => {
    const hostile = {
      log() { throw new Error("log is broken"); },
      checkpoint() { throw new Error("checkpoint is broken"); },
      async screenshot(): Promise<string> { throw new Error("screenshot is broken"); },
    };
    await expect(recordChallenge({ detection, tab: fakeTab({}), run: hostile, state: {} })).resolves
      .toBeInstanceOf(CapabilityError);
  });
});

describe("assertNoChallenge", () => {
  it("returns the clean verdict and touches nothing", async () => {
    const run = fakeRun();
    const v = await assertNoChallenge({ tab: fakeTab({ url: "https://www.linkedin.com/feed/" }), run });
    expect(v.clean).toBe(true);
    expect(run.events).toEqual([]);
    expect(run.checkpoints).toEqual([]);
  });

  it("throws the classed error, with evidence, on a challenge", async () => {
    const tab = fakeTab({ url: "https://www.linkedin.com/checkpoint/challenge/x" });
    const run = fakeRun();
    await expect(assertNoChallenge({ tab, run, state: { page: 2 } })).rejects.toMatchObject({
      code: "CHALLENGE_CHECKPOINT",
      exit: EXIT.CHALLENGE,
      evidence: "runs/x/shots/001-challenge-checkpoint.png",
    });
    expect(run.checkpoints).toEqual([{ page: 2 }]);
  });

  it("throws REAUTH, not a challenge halt, on a login bounce", async () => {
    await expect(
      assertNoChallenge({ tab: fakeTab({ url: "https://www.linkedin.com/uas/login" }) }),
    ).rejects.toMatchObject({ code: "SESSION_DEAD", exit: EXIT.AUTH, action: "REAUTH" });
  });
});

describe("the real classes satisfy the structural types (checked by tsc, not at runtime)", () => {
  it("WorkerTab is a ChallengeTab and a ShotTab, and RunContext is a ChallengeArchive", () => {
    // Compile-time assertions. They are the only proof that the gate composes
    // with Task 4 and Task 6 — nothing in this file can construct a real
    // WorkerTab offline, and `npx tsc --noEmit` is part of the gate.
    //
    // This is not decorative: RunContext.screenshot's parameter previously
    // returned Promise<void>, WorkerTab.screenshot returns Promise<string>, and
    // the two would not typecheck together. The challenge path is the first
    // caller that needs both, which is where it surfaced.
    type Assert<T extends true> = T;
    type Extends<A, B> = A extends B ? true : false;
    type _tab = Assert<Extends<WorkerTab, ChallengeTab & ShotTab>>;
    type _run = Assert<Extends<RunContext, ChallengeArchive>>;
    type _shot = Assert<Extends<WorkerTab, Screenshotter>>;
    const witness: (_tab | _run | _shot)[] = [true, true, true];
    expect(witness).toEqual([true, true, true]);
  });
});
