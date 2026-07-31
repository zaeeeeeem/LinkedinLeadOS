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
    ["https://www.linkedin.com/", "login"],
    ["https://www.linkedin.com/home", "login"],
  ] as const)("%s is %s", (u, kind) => {
    expect(url(u)).toBe(kind);
  });

  it("puts /checkpoint/lg/ ahead of /checkpoint/ — reauth is not a captcha", () => {
    // The two map to different exit codes (4 vs 2) and different operator
    // actions, so prefix order in CHALLENGE_PATHS is load-bearing.
    expect(url("https://www.linkedin.com/checkpoint/lg/login")).toBe("login");
    expect(url("https://www.linkedin.com/checkpoint/lg/login-submit")).toBe("login");
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

  it("finds a soft throttle", () => {
    expect(classifyText("Couldn’t load this content").kind).toBe("rate-limited");
    expect(classifyText("Too many requests").kind).toBe("rate-limited");
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

  it("maps 401 and 403 to a dead session", () => {
    expect(classifyResponse({ status: 401, url: "https://www.linkedin.com/voyager/api/x" }).kind).toBe("login");
    expect(classifyResponse({ status: 403, url: "https://www.linkedin.com/voyager/api/x" }).kind).toBe("login");
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
    expect(worstVerdict().kind).toBe("clean");
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
