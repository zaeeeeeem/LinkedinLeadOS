import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capability as profileCapture } from "../src/capabilities/profile.capture/index.js";
import { VIEWPORT_EXPRESSION } from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor } from "../src/capabilities/profile.capture/read.js";
import { PROBE_EXPRESSION } from "../src/core/challenge/detect.js";
import type { ChallengeProbe } from "../src/core/challenge/detect.js";
import type { CdpEvent } from "../src/core/cdp/client.js";
import type { HumanCursor } from "../src/core/input/cursor.js";
import { EXIT } from "../src/core/run/receipt.js";
import { inspectLease } from "../src/core/lease/tab-lease.js";
import type { SpendRecord } from "../src/core/budget/ledger.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute } from "../src/cli/run.js";
import type { AnyCapability, SessionLike, TabLike, UniversalFlags } from "../src/cli/types.js";
import type { TapTransport } from "../src/core/tap/network-tap.js";

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
const PROFILE_URL = "https://www.linkedin.com/in/jane-doe/";
const PROFILE_BODY = JSON.stringify({
  data: {
    identityDashProfilesByMemberIdentity: {
      elements: [{ entityUrn: "urn:li:fsd_profile:ACwAAA", firstName: "Jane", headline: "Founder" }],
    },
  },
});

/** One response the fake page "fetches" after navigation. */
type Response = { url: string; body: string; status?: number; failed?: boolean };

const PREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashProfiles.7a&variables=(vanityName:jane-doe)";
const UNPREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerIdentityDashSomethingNew.9f";
const TELEMETRY = "https://www.linkedin.com/li/track";

/**
 * A fake page that emits the real CDP event sequence — `requestWillBeSent`,
 * `responseReceived`, `loadingFinished`, in that order, session-scoped — because
 * the tap's whole design is about that ordering. A double that emitted a
 * convenient shorthand would certify the capture as working against a protocol
 * Chrome does not speak (CONTEXT §3).
 */
class FakePage {
  private listeners = new Set<(e: CdpEvent) => void>();
  private nextId = 1;
  responses: Response[] = [];
  /** Emitted only after `navigate` — nothing arrives on `about:blank`. */
  navigated = false;

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  bodyOf(requestId: string): string | undefined {
    return this.bodies.get(requestId);
  }
  urlOf(requestId: string): string | undefined {
    return this.urls.get(requestId);
  }
  private bodies = new Map<string, string>();
  private urls = new Map<string, string>();
  /** Bodies for these urls take their time coming back off the wire. */
  slowBodies = new Set<string>();

  emitAll(sessionId: string): void {
    for (const r of this.responses) {
      const requestId = `req-${this.nextId++}`;
      this.bodies.set(requestId, r.body);
      this.urls.set(requestId, r.url);
      this.emit(sessionId, "Network.requestWillBeSent", {
        requestId,
        request: { url: r.url, method: "GET" },
      });
      this.emit(sessionId, "Network.responseReceived", {
        requestId,
        response: { url: r.url, status: r.status ?? 200, mimeType: "application/json" },
      });
      if (r.failed) {
        this.emit(sessionId, "Network.loadingFailed", { requestId, errorText: "net::ERR_ABORTED" });
      } else {
        this.emit(sessionId, "Network.loadingFinished", { requestId });
      }
    }
  }

  private emit(sessionId: string, method: string, params: Record<string, unknown>): void {
    for (const l of [...this.listeners]) l({ method, params, sessionId });
  }
}

class FakeTab implements TabLike {
  readonly targetId = "target-1";
  readonly sessionId = "session-1";
  closed = false;
  navigated: string[] = [];
  shots: string[] = [];
  probe: Partial<ChallengeProbe> | Error = { url: PROFILE_URL, text: "", captcha: false };
  /** A second probe answer, used from the second gate onward. */
  probeAfterRead: Partial<ChallengeProbe> | Error | null = null;
  private probeCalls = 0;
  foreground = { ok: true, via: "already" as const, hidden: false };
  /** A laid-out page by default. Set to a one-viewport shell to stage the
   *  regression from the first live run. */
  viewport: unknown = { width: 1440, height: 900, scrollHeight: 5000 };

  constructor(private readonly page: FakePage) {}

  async send<T>(): Promise<T> {
    return {} as T;
  }
  async evaluate<T>(expression: string): Promise<T> {
    if (expression === PROBE_EXPRESSION) {
      this.probeCalls++;
      const answer = this.probeCalls > 1 && this.probeAfterRead !== null ? this.probeAfterRead : this.probe;
      if (answer instanceof Error) throw answer;
      return { url: PROFILE_URL, text: "", captcha: false, ...answer } as T;
    }
    if (expression === VIEWPORT_EXPRESSION) {
      return this.viewport as T;
    }
    return "complete" as T;
  }
  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
    this.page.navigated = true;
    // Real navigation answers asynchronously; so does this.
    setTimeout(() => this.page.emitAll(this.sessionId), 0);
  }
  async currentUrl(): Promise<string> {
    return this.navigated.at(-1) ?? "about:blank";
  }
  async screenshot(path: string): Promise<string> {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "png");
    this.shots.push(path);
    return path;
  }
  async foregroundState() {
    return { hidden: this.foreground.hidden, focused: true, visibility: "visible" };
  }
  async ensureForeground() {
    return { ok: this.foreground.ok, via: this.foreground.via, state: await this.foregroundState() };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSession implements SessionLike {
  readonly endpoint = { port: 9223, wsUrl: "ws://127.0.0.1:9223/devtools/browser/fake", launched: false };
  readonly page = new FakePage();
  readonly tab: FakeTab;
  closed = false;

  constructor() {
    this.tab = new FakeTab(this.page);
  }

  readonly client: TapTransport = {
    send: async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      if (method === "Storage.getCookies") {
        return { cookies: [{ name: "li_at", domain: ".www.linkedin.com", expires: FUTURE }] } as T;
      }
      if (method === "Network.getResponseBody") {
        const requestId = String(params?.["requestId"] ?? "");
        const body = this.page.bodyOf(requestId);
        if (body === undefined) throw new Error("no such request");
        const url = this.page.urlOf(requestId);
        if (url !== undefined && this.page.slowBodies.has(url)) {
          await new Promise((r) => setTimeout(r, 60));
        }
        return { body, base64Encoded: false } as T;
      }
      return {} as T;
    },
    on: (listener) => this.page.on(listener),
  };

  async openWorkerTab(): Promise<TabLike> {
    return this.tab;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tab.close();
  }
}

/** No real sleeping. The pacing itself is proven in profile-capture-read.test.ts. */
function fakeCursor(): ReadCursor & { wheels: number; paused: number } {
  const c = {
    wheels: 0,
    paused: 0,
    async wheel(_x: number, _y: number, deltaY: number) {
      c.wheels++;
      return { requested: deltaY, scrolled: deltaY, notches: 1 };
    },
    async pause(min = 0, max = 0) {
      c.paused += 1;
      void min;
      void max;
      return 0;
    },
  };
  return c;
}

let dir: string;
let paths: { runsDir: string; leasePath: string; budgetPath: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "profile-capture-"));
  paths = {
    runsDir: join(dir, "runs"),
    leasePath: join(dir, "runs", "tab.lock"),
    budgetPath: join(dir, "runs", "budget.ndjson"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function invoke(o: {
  responses?: Response[];
  args?: Record<string, unknown>;
  flags?: Partial<UniversalFlags>;
  tune?: (session: FakeSession) => void;
}) {
  const session = new FakeSession();
  session.page.responses = o.responses ?? [{ url: PREDICTED_GQL, body: PROFILE_BODY }];
  o.tune?.(session);
  const cursor = fakeCursor();
  return {
    session,
    cursor,
    outcome: execute({
      def: profileCapture as unknown as AnyCapability,
      rawArgs: { url: PROFILE_URL, scrolls: 2, layoutTimeoutMs: 50, ...o.args },
      flags: { ...DEFAULT_FLAGS, ...o.flags },
      ...paths,
      deps: {
        openSession: async () => session,
        makeCursor: () => cursor as unknown as HumanCursor,
      },
    }),
  };
}

function ledgerLines(): SpendRecord[] {
  if (!existsSync(paths.budgetPath)) return [];
  return readFileSync(paths.budgetPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SpendRecord);
}

function archivedBodies(runId: string): string[] {
  const raw = join(paths.runsDir, runId, "raw");
  return existsSync(raw) ? readdirSync(raw).filter((f) => f.endsWith(".json.gz")) : [];
}

// ─────────────────────────────────────────────────────────────────────────────

describe("profile.capture — the happy path", () => {
  it("captures, archives, spends exactly one page load and one profile open, and tears down", async () => {
    const { outcome, session, cursor } = invoke({});
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    expect(session.tab.navigated).toEqual([PROFILE_URL]);
    expect(receipt.counts).toEqual({ requested: 1, captured: 1, usable: 1, skipped: 0 });
    expect(receipt.warnings).toEqual([]);
    expect(receipt.cost.page_loads).toBe(1);

    const spends = ledgerLines();
    expect(spends.map((s) => s.kind).sort()).toEqual(["page_load", "profile_open"]);
    expect(spends.find((s) => s.kind === "profile_open")!.ref).toBe("in:jane-doe");

    expect(archivedBodies(receipt.run_id)).toHaveLength(1);
    expect(cursor.wheels).toBe(2);

    // Everything released.
    expect(session.closed).toBe(true);
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("archives what the page fetched and nothing it did not", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: PROFILE_BODY },
        { url: TELEMETRY, body: '{"events":[]}' },
      ],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    // Telemetry is excluded by the broad net: it is api-shaped, high volume, and
    // never carries profile data.
    expect(receipt.counts.captured).toBe(1);
    expect(archivedBodies(receipt.run_id)).toHaveLength(1);
  });

  it("reports the endpoint path and operation id without the query string", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as { capture: { endpoints: Array<Record<string, unknown>> } };
    expect(data.capture.endpoints[0]).toMatchObject({
      path: "/voyager/api/graphql",
      query_id: "voyagerIdentityDashProfiles.7a",
      profile_ish: true,
      unpredicted: false,
    });
    expect(JSON.stringify(receipt)).not.toContain("vanityName");
  });

  it("names the promotion step as the next command", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.next).toContain("fixtures:promote");
    expect(receipt.next).toContain(receipt.run_id);
  });
});

describe("profile.capture — what the patterns actually matched", () => {
  it("warns when a profile payload arrives on an endpoint no specific pattern predicted", async () => {
    const { outcome } = invoke({ responses: [{ url: UNPREDICTED_GQL, body: PROFILE_BODY }] });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PATTERN_MISMATCH");
    const data = receipt.data as { capture: { unmatched_profile_ish: number } };
    expect(data.capture.unmatched_profile_ish).toBe(1);
    // Still captured and still archived — the finding is a report, not a failure.
    expect(receipt.counts.usable).toBe(1);
    expect(archivedBodies(receipt.run_id)).toHaveLength(1);
  });

  it("warns loudly when nothing carrying person data arrived", async () => {
    const { outcome } = invoke({
      responses: [
        { url: "https://www.linkedin.com/voyager/api/graphql?queryId=feed.1", body: '{"data":{}}' },
      ],
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    // An ok receipt must never read as "we got the profile" when it did not.
    expect(receipt.counts.usable).toBe(0);
    expect(receipt.warnings.map((w) => w.code)).toContain("NO_PROFILE_PAYLOAD");
  });

  it("reports a lost body as a miss rather than as a clean zero", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: PROFILE_BODY },
        { url: UNPREDICTED_GQL, body: "{}", failed: true },
      ],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.skipped).toBe(1);
    expect(receipt.warnings.map((w) => w.code)).toContain("CAPTURE_MISSES");
  });
});

describe("profile.capture — the gates", () => {
  it("halts on a challenge after navigation, with a screenshot and a checkpoint, exit 2", async () => {
    const { outcome, session } = invoke({
      tune: (s) => {
        s.tab.probe = { url: "https://www.linkedin.com/checkpoint/challenge/", text: "", captcha: true };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.CHALLENGE);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("CHALLENGE_CAPTCHA");
    expect(receipt.error.retryable).toBe(false);
    expect(session.tab.shots).toHaveLength(1);
    expect(existsSync(join(paths.runsDir, receipt.run_id, "checkpoint.json"))).toBe(true);
    // Released even on the halting path.
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("archives a body still on the wire when the run halts, instead of losing it", async () => {
    // The property `finally { drain() }` exists for, staged so it is actually
    // load-bearing: the first response satisfies the wait, the second one's body
    // is still being fetched when the pre-success gate fires. Without the drain,
    // teardown stops the tap and the tap drops a body it fetched for a phase that
    // is over — a spent page load with an incomplete archive (D2).
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: PROFILE_BODY },
        { url: UNPREDICTED_GQL, body: PROFILE_BODY },
      ],
      tune: (s) => {
        s.page.slowBodies.add(UNPREDICTED_GQL);
        s.tab.probeAfterRead = {
          url: "https://www.linkedin.com/in/jane-doe/",
          text: "we noticed unusual activity from your account",
          captcha: false,
        };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.CHALLENGE);
    if (receipt.ok) throw new Error("expected a halt");
    expect(receipt.error.code).toBe("CHALLENGE_RESTRICTED");
    expect(archivedBodies(receipt.run_id)).toHaveLength(2);
  });

  it("halts on an http 429 in a captured response, exit 3 and retryable", async () => {
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: PROFILE_BODY, status: 429 }],
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.RATE_LIMITED);
    if (receipt.ok) throw new Error("expected a halt");
    expect(receipt.error.code).toBe("RATE_LIMITED");
    expect(receipt.error.retryable).toBe(true);
  });

  it("reports an http 403 subresource as a warning rather than halting a clean page (D111)", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: PROFILE_BODY },
        { url: UNPREDICTED_GQL, body: "{}", status: 403 },
      ],
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    const warning = receipt.warnings.find((w) => w.code === "RESPONSE_STATUS_UNRECOGNIZED");
    expect(warning?.n).toBe(1);
    expect(warning?.field).toContain("403");
  });

  it("fails transient when the page loads but issues no api call", async () => {
    const { outcome } = invoke({ responses: [], args: { captureTimeoutMs: 300 } });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.TRANSIENT);
    if (receipt.ok) throw new Error("expected a failure");
    expect(receipt.error.code).toBe("CAPTURE_TIMEOUT");
    expect(receipt.error.retryable).toBe(true);
  });

  it("warns when the page never laid out, instead of reporting a silent zero-scroll ok", async () => {
    // The first live run's exact shape (01KZH9VVPKB5JEVEBW7G2JJ6F3): readyState
    // complete, scrollHeight === innerHeight, nothing scrolled, no lazy section
    // fetched — and, before this warning existed, an ok receipt that said nothing.
    const { outcome, cursor } = invoke({
      tune: (s) => {
        s.tab.viewport = { width: 1333, height: 798, scrollHeight: 798 };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PAGE_NOT_LAID_OUT");
    expect(cursor.wheels).toBe(0);
    const data = receipt.data as { reading: { layout: { settled: boolean } } };
    expect(data.reading.layout.settled).toBe(false);
  });

  it("does not warn about layout on a page that laid out", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).not.toContain("PAGE_NOT_LAID_OUT");
  });

  it("warns when the tab could not be brought to the foreground", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.foreground = { ok: false, via: "already", hidden: true };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("TAB_NOT_FOREGROUND");
  });
});

describe("profile.capture — refusing before it costs anything", () => {
  it("rejects a non-profile url with exit 1, having navigated nowhere and spent nothing", async () => {
    const { outcome, session } = invoke({ args: { url: "https://www.linkedin.com/company/acme/" } });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.GENERIC);
    if (receipt.ok) throw new Error("expected a refusal");
    expect(receipt.error.code).toBe("PROFILE_URL_INVALID");
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toEqual([]);
  });

  it("refuses when the daily distinct-profile limit is already reached, without navigating", async () => {
    // Seeded straight into the ledger: 120 distinct profiles opened in the last
    // hour is §8's daily cap, and this run's profile is a 121st.
    mkdirSync(paths.runsDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      paths.budgetPath,
      Array.from({ length: 120 }, (_, i) =>
        JSON.stringify({
          ts: now, run_id: "seed", capability: "seed", kind: "profile_open", n: 1, ref: `in:other-${i}`,
        }),
      ).join("\n") + "\n",
    );

    const { outcome, session } = invoke({});
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.BUDGET);
    if (receipt.ok) throw new Error("expected a refusal");
    expect(session.tab.navigated).toEqual([]);
    // Refused by `check`, so no page load was recorded on the way out either.
    expect(ledgerLines().filter((l) => l.run_id === receipt.run_id)).toEqual([]);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("makes no browser call at all under --dry-run", async () => {
    const { outcome, session } = invoke({ flags: { dryRun: true } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toEqual([]);
    if (!receipt.ok) throw new Error("expected ok");
    expect((receipt.data as { estimate: unknown }).estimate).toEqual({
      page_loads: 1, search_pages: 0, profile_opens: 1,
    });
  });
});
