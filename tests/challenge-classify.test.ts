import { describe, expect, it } from "vitest";
import {
  CHALLENGE_PRECEDENCE,
  challengeError,
  classifyResponse,
  classifyText,
  classifyUrl,
  worstVerdict,
} from "../src/core/challenge/classify.js";
import type { ChallengeDetection } from "../src/core/challenge/classify.js";
import { CHALLENGE_PATHS, SOFT_MARKER_MAX_TEXT } from "../src/core/challenge/constants.js";
import { EXIT } from "../src/core/run/receipt.js";

const url = (u: string) => classifyUrl(u).kind;

describe("classifyUrl — clean app surface", () => {
  it.each([
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/in/some-person/",
    "https://www.linkedin.com/in/some-person/recent-activity/all/",
    "https://www.linkedin.com/company/acme/",
    "https://www.linkedin.com/school/some-university/",
    "https://www.linkedin.com/search/results/people/?keywords=x",
    "https://www.linkedin.com/jobs/view/12345/",
    "https://www.linkedin.com/posts/some-person_activity-123",
    "https://www.linkedin.com/mynetwork/",
    "https://www.linkedin.com/messaging/thread/2-abc/",
    "https://www.linkedin.com/notifications/",
    "https://www.linkedin.com/sales/search/people?query=x",
    "https://www.linkedin.com/sales/lead/ACwAA_1,NAME,abc",
    "https://linkedin.com/feed/",
  ])("%s is clean", (u) => {
    expect(url(u)).toBe("clean");
  });

  it("treats a non-LinkedIn URL as clean — LinkedIn has no opinion about it", () => {
    expect(url("https://example.com/anything")).toBe("clean");
    expect(url("about:blank")).toBe("clean");
  });
});

describe("classifyUrl — challenge paths", () => {
  it.each([
    ["https://www.linkedin.com/checkpoint/challenge/AgH-abc", "checkpoint"],
    ["https://www.linkedin.com/checkpoint/challengesV2/AgH-abc", "checkpoint"],
    ["https://www.linkedin.com/checkpoint/anything-new-they-invent", "checkpoint"],
    ["https://www.linkedin.com/checkpoint/lg/login", "login"],
    ["https://www.linkedin.com/checkpoint/lg/login-submit", "login"],
    ["https://www.linkedin.com/checkpoint/rp/request-password-reset", "login"],
    ["https://www.linkedin.com/authwall?trk=x", "login"],
    ["https://www.linkedin.com/uas/login?session_redirect=%2Ffeed", "login"],
    ["https://www.linkedin.com/login", "login"],
    ["https://www.linkedin.com/signup/cold-join", "login"],
  ] as const)("%s is %s", (u, kind) => {
    expect(url(u)).toBe(kind);
  });

  it("halts on the guest homepage without claiming the session is dead (D63)", () => {
    // The bounce reasoning is unverified, and `login` is not a neutral guess: it
    // exits 4 and instructs a re-login, which is itself an event LinkedIn
    // watches. `unrecognized` stops the run just as hard.
    for (const u of ["https://www.linkedin.com/", "https://www.linkedin.com/home"]) {
      const v = classifyUrl(u);
      expect(v.clean).toBe(false);
      expect(v.kind).toBe("unrecognized");
    }
  });

  it("matches the longest challenge prefix, whatever order they are declared in", () => {
    // /checkpoint/lg/ (exit 4) and /checkpoint/ (exit 2) are different operator
    // actions, so this is load-bearing. Sorting is what makes it hold — these
    // pass under declaration order too, which is why the invariant below exists.
    expect(url("https://www.linkedin.com/checkpoint/lg/login")).toBe("login");
    expect(url("https://www.linkedin.com/checkpoint/lg/login-submit")).toBe("login");
    expect(url("https://www.linkedin.com/checkpoint/rp/request-password-reset")).toBe("login");
  });

  it("shadows no challenge prefix — every entry is reachable", () => {
    // The invariant, not one instance of it: a new specific prefix appended
    // under a generic one used to be silently unreachable, which downgrades its
    // exit code without failing anything. `/checkpoint/challengesV2` was exactly
    // that. Matching now sorts by length, so this holds by construction — and
    // this test fails if that sort is ever removed.
    for (const { prefix, kind, detail } of CHALLENGE_PATHS) {
      const v = classifyUrl(`https://www.linkedin.com${prefix}probe`);
      expect(v.clean).toBe(false);
      expect(v.kind).toBe(kind);
      expect(v.detail).toBe(detail);
    }
  });
});

describe("classifyUrl — the unknown page is the point", () => {
  it("classifies a LinkedIn path it has never seen as unrecognized, not clean", () => {
    const v = classifyUrl("https://www.linkedin.com/verify/identity/step-2");
    expect(v.kind).toBe("unrecognized");
    expect(v.clean).toBe(false);
  });

  it("does the same for a challenge surface invented after this code was written", () => {
    for (const u of [
      "https://www.linkedin.com/security/hold",
      "https://www.linkedin.com/account/restricted",
      "https://www.linkedin.com/interstitial/robot-check",
    ]) {
      expect(classifyUrl(u).clean).toBe(false);
    }
  });

  it("also covers LinkedIn subdomains", () => {
    expect(url("https://business.linkedin.com/something")).toBe("unrecognized");
  });

  it("refuses to certify a URL it cannot parse", () => {
    expect(classifyUrl("not a url").kind).toBe("unrecognized");
    expect(classifyUrl("").kind).toBe("unrecognized");
  });
});

describe("classifyText", () => {
  it("finds the restriction wording", () => {
    const v = classifyText("Header\nWe noticed unusual activity from your account\nfooter");
    expect(v.kind).toBe("restricted");
    expect(v.clean).toBe(false);
  });

  it("finds a soft throttle on a short page", () => {
    expect(classifyText("Couldn’t load this content").kind).toBe("rate-limited");
    expect(classifyText("Too many requests").kind).toBe("rate-limited");
    expect(classifyText("Please try again later").kind).toBe("rate-limited");
  });

  it("ignores a soft throttle phrase buried in a full page (D64)", () => {
    // LinkedIn renders "couldn't load this content" on one broken feed card
    // while the session is healthy. Trusting it there halts a good run with
    // RATE_LIMITED and a back-off, and the receipt is indistinguishable from a
    // real throttle.
    const feed = "Jane Doe posted a job. ".repeat(200); // > SOFT_MARKER_MAX_TEXT
    expect(feed.length).toBeGreaterThan(SOFT_MARKER_MAX_TEXT);
    expect(classifyText(`${feed}Couldn’t load this content${feed}`).kind).toBe("clean");
    expect(classifyText(`${feed}Too many requests${feed}`).kind).toBe("clean");
  });

  it("still trusts the specific wording at any page length", () => {
    // Only the throttle set is soft. A restriction notice is specific enough
    // that its length says nothing, and missing it is the expensive direction.
    const feed = "Jane Doe posted a job. ".repeat(200);
    expect(classifyText(`${feed}We noticed unusual activity from your account`).kind).toBe("restricted");
    expect(classifyText(`${feed}Let's do a quick security check`).kind).toBe("captcha");
  });

  it("finds captcha wording", () => {
    expect(classifyText("Let's do a quick security check").kind).toBe("captcha");
  });

  it("reports only the matched marker as detail, never the page text", () => {
    const secret = "Jane Doe — VP of Engineering at Acme";
    const v = classifyText(`${secret}\nToo many requests\n${secret}`);
    expect(v.detail).not.toContain("Jane Doe");
    expect(v.detail.toLowerCase()).toContain("too many requests");
  });

  it("is clean on ordinary page text and on empty text", () => {
    expect(classifyText("Feed — 500 connections — Jobs you may be interested in").kind).toBe("clean");
    expect(classifyText("").kind).toBe("clean");
  });
});

describe("classifyResponse", () => {
  it("maps 429 to rate-limited and carries retry_after", () => {
    const v = classifyResponse({ status: 429, url: "https://www.linkedin.com/voyager/api/x" });
    expect(v.kind).toBe("rate-limited");
    const withHeader = classifyResponse({
      status: 429,
      url: "https://www.linkedin.com/voyager/api/x",
      retryAfterSeconds: 30,
    });
    expect(withHeader.clean).toBe(false);
    expect((withHeader as ChallengeDetection).retryAfterMs).toBe(30_000);
  });

  it("maps 401 to a dead session — unauthenticated is unambiguous", () => {
    expect(classifyResponse({ status: 401, url: "https://www.linkedin.com/voyager/api/x" }).kind).toBe("login");
  });

  it("halts on 403 without prescribing a re-login (D63)", () => {
    // 403 means "logged out" or "this member is out of your network", and the
    // two need opposite responses. Exit 4 would tell the operator to
    // authenticate a session that may be fine.
    const v = classifyResponse({ status: 403, url: "https://www.linkedin.com/voyager/api/x" });
    expect(v.clean).toBe(false);
    expect(v.kind).toBe("unrecognized");
  });

  it("maps LinkedIn's 999 to restricted", () => {
    expect(classifyResponse({ status: 999, url: "https://www.linkedin.com/in/x" }).kind).toBe("restricted");
  });

  it("does NOT deny-by-default on response URLs — an unknown API path is normal", () => {
    // classifyUrl asks "is the page we are on a challenge?" and denies by
    // default. A response URL is a different question: LinkedIn serves hundreds
    // of API paths and none of them is an allowlist we could keep current.
    expect(classifyUrl("https://www.linkedin.com/voyager/api/identity/profiles/x").kind).toBe("unrecognized");
    expect(classifyResponse({ status: 200, url: "https://www.linkedin.com/voyager/api/identity/profiles/x" }).kind).toBe("clean");
  });

  it("still catches a response redirected onto a challenge path", () => {
    expect(classifyResponse({ status: 200, url: "https://www.linkedin.com/checkpoint/challenge/x" }).kind).toBe("checkpoint");
    expect(classifyResponse({ status: 200, url: "https://www.linkedin.com/uas/login" }).kind).toBe("login");
  });

  it("leaves ordinary failures alone — a 500 is not a challenge", () => {
    expect(classifyResponse({ status: 500, url: "https://www.linkedin.com/voyager/api/x" }).kind).toBe("clean");
    expect(classifyResponse({ status: 200, url: "https://www.linkedin.com/feed/" }).kind).toBe("clean");
  });
});

describe("worstVerdict", () => {
  it("never lets a clean signal outvote a challenge signal", () => {
    expect(worstVerdict(classifyUrl("https://www.linkedin.com/feed/"), classifyText("Too many requests")).kind)
      .toBe("rate-limited");
  });

  it("prefers the more specific identification over a weaker one", () => {
    const v = worstVerdict(
      classifyUrl("https://www.linkedin.com/checkpoint/challenge/x"),
      classifyText("Let's do a quick security check"),
    );
    expect(v.kind).toBe("captcha");
  });

  it("lets any positive identification beat unrecognized", () => {
    const unknown = classifyUrl("https://www.linkedin.com/verify/identity");
    expect(worstVerdict(unknown, classifyText("Too many requests")).kind).toBe("rate-limited");
  });

  it("is clean only when every input is clean", () => {
    expect(worstVerdict(classifyUrl("https://www.linkedin.com/feed/"), classifyText("all fine")).kind).toBe("clean");
  });

  it("does not certify nothing as clean", () => {
    // No signals checked is not the same as every signal reporting clean. The
    // module denies by default (D60), and this is the one place it did not.
    expect(worstVerdict().clean).toBe(false);
    expect(worstVerdict().kind).toBe("unrecognized");
  });

  it("ranks every non-clean kind", () => {
    expect(new Set(CHALLENGE_PRECEDENCE)).toEqual(
      new Set(["captcha", "checkpoint", "restricted", "login", "rate-limited", "unrecognized"]),
    );
  });
});

describe("challengeError", () => {
  const detect = (kind: ChallengeDetection["kind"]): ChallengeDetection => ({
    kind, clean: false, signal: "url", detail: "test",
  });

  it.each([
    ["captcha", "CHALLENGE_CAPTCHA", EXIT.CHALLENGE, "HALT_AND_NOTIFY", false],
    ["checkpoint", "CHALLENGE_CHECKPOINT", EXIT.CHALLENGE, "HALT_AND_NOTIFY", false],
    ["restricted", "CHALLENGE_RESTRICTED", EXIT.CHALLENGE, "HALT_AND_NOTIFY", false],
    ["unrecognized", "CHALLENGE_UNRECOGNIZED", EXIT.CHALLENGE, "HALT_AND_NOTIFY", false],
    ["login", "SESSION_DEAD", EXIT.AUTH, "REAUTH", false],
    ["rate-limited", "RATE_LIMITED", EXIT.RATE_LIMITED, "RETRY_BACKOFF", true],
  ] as const)("%s → %s", (kind, code, exit, action, retryable) => {
    const e = challengeError(detect(kind));
    expect(e.code).toBe(code);
    expect(e.exit).toBe(exit);
    expect(e.action).toBe(action);
    expect(e.retryable).toBe(retryable);
  });

  it("gives every kind its own code — one code per operator action", () => {
    const codes = CHALLENGE_PRECEDENCE.map((k) => challengeError(detect(k)).code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("carries the evidence path when one is given", () => {
    expect(challengeError(detect("captcha"), "runs/x/shots/001-challenge.png").evidence)
      .toBe("runs/x/shots/001-challenge.png");
  });

  it("carries retry_after_ms through to the receipt", () => {
    const e = challengeError({ ...detect("rate-limited"), retryAfterMs: 45_000 });
    expect(e.retryAfterMs).toBe(45_000);
  });
});
