import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capability as profileCapture } from "../src/capabilities/profile.capture/index.js";
import {
  DEFERRED_SECTIONS_EXPRESSION, VIEWPORT_EXPRESSION,
} from "../src/capabilities/profile.capture/read.js";
import { DEFERRED_SECTIONS_TIMEOUT_MS } from "../src/capabilities/profile.capture/constants.js";
import {
  DOM_SNAPSHOT_PATTERN, SNAPSHOT_EXPRESSION, isDomSnapshotEntry,
} from "../src/capabilities/profile.capture/snapshot.js";
import { RawArchive } from "../src/core/archive/raw.js";
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
import type { Navigation } from "../src/core/session/tab.js";

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

/** The subject id the fake page's card refs are namespaced by. Shaped like a
 *  real one — `AC` then a long opaque tail — because `resolveSubjectScope`
 *  tests the shape before it will call a prefix an id. */
const SUBJECT_ID = "ACoAAAjaneDoe0000000000000000000000000";
const CARD_REF = "com.linkedin.sdui.profile.card.ref";

/** What the fake page's rendered DOM serializes to. Small, but shaped like the
 *  real thing on the two points that matter: a subject container with a sidebar
 *  the parser must not read, and profile cards carrying the SDUI card-ref
 *  namespace that identity is resolved from (D127, D130). Three cards, because
 *  one cannot confirm an id boundary and the resolver refuses on one. */
const SNAPSHOT_HTML =
  "<html><body><main id=\"workspace\">" +
  `<section componentkey="${CARD_REF}${SUBJECT_ID}Topcard">Founder at Example</section>` +
  `<section componentkey="${CARD_REF}${SUBJECT_ID}About">About</section>` +
  `<section componentkey="${CARD_REF}${SUBJECT_ID}ExperienceTopLevelSection">Jobs</section>` +
  `<section componentkey="${CARD_REF}jane-doeActivity">Activity</section>` +
  "</main><aside>People also viewed</aside></body></html>";

/** The same page with the card refs stripped: rendered, archivable, and
 *  impossible to key. The `SUBJECT_IDENTITY_UNRESOLVED` case. */
const SNAPSHOT_HTML_NO_CARDS =
  "<html><body><main id=\"workspace\"><section>Founder at Example</section></main>" +
  "<aside>People also viewed</aside></body></html>";

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
  viewport: unknown = {
    width: 1440, height: 900, scrollHeight: 5000,
    innerScroller: true, scrollerHeight: 860, documentScrollHeight: 900,
  };
  /**
   * The deferred cards below the Activity section, hydrated by default (D320).
   * Set `{ total: n, hydrated: 0 }` to stage the page whose Experience,
   * Education and Skills never fetched — the live failure of 2026-08-10.
   */
  deferred: unknown = { total: 7, hydrated: 6 };
  /** A rendered profile by default. Set to a shell, or to an Error, to stage
   *  the not-rendered and unreadable branches of the DOM snapshot (D123). */
  snapshot: unknown = {
    html: SNAPSHOT_HTML,
    url: PROFILE_URL,
    htmlChars: SNAPSHOT_HTML.length,
    textChars: 30_963,
    container: {
      selector: "main#workspace", chars: 800, textChars: 9_000,
      sections: 14, sidebars: 3, sidebarsInside: 0,
    },
  };

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
    if (expression === DEFERRED_SECTIONS_EXPRESSION) {
      return this.deferred as T;
    }
    if (expression === SNAPSHOT_EXPRESSION) {
      if (this.snapshot instanceof Error) throw this.snapshot;
      return this.snapshot as T;
    }
    return "complete" as T;
  }
  async navigate(url: string): Promise<Navigation> {
    this.navigated.push(url);
    this.page.navigated = true;
    // Real navigation answers asynchronously; so does this.
    setTimeout(() => this.page.emitAll(this.sessionId), 0);
    return { settledOn: "complete", readyState: "complete", waitedMs: 0 };
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

function archivedFiles(runId: string): string[] {
  const raw = join(paths.runsDir, runId, "raw");
  return existsSync(raw) ? readdirSync(raw).filter((f) => f.endsWith(".json.gz")) : [];
}

/** Everything the archive holds, split by where it came from. The DOM snapshot
 *  lands in the same directory as the tapped bodies and must never be counted
 *  as one — it is a DOM read, not something LinkedIn served (D123). */
async function archived(runId: string): Promise<{ network: string[]; snapshots: string[] }> {
  const entries = await new RawArchive(join(paths.runsDir, runId, "raw")).list();
  return {
    network: entries.filter((e) => !isDomSnapshotEntry(e)).map((e) => e.file),
    snapshots: entries.filter(isDomSnapshotEntry).map((e) => e.file),
  };
}

/** The tapped bodies only — what every assertion written before Task 16 meant. */
async function archivedBodies(runId: string): Promise<string[]> {
  return (await archived(runId)).network;
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

    expect(await archivedBodies(receipt.run_id)).toHaveLength(1);
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
    expect(await archivedBodies(receipt.run_id)).toHaveLength(1);
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
    expect(await archivedBodies(receipt.run_id)).toHaveLength(1);
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
    expect(await archivedBodies(receipt.run_id)).toHaveLength(2);
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
        s.tab.viewport = {
          width: 1333, height: 798, scrollHeight: 798,
          innerScroller: false, scrollerHeight: 798, documentScrollHeight: 798,
        };
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

  it("warns when the cards below Activity never filled, so a null field is not read as absent (D320)", async () => {
    // The live shape of run 01KZMMFNSMFJ8CKHV9R9JJZ1GY: 7 deferred containers,
    // 0 of them filled, a clean exit 0, and a person stored with no employment.
    const { outcome } = invoke({
      args: { scrolls: undefined },
      tune: (s) => {
        s.tab.deferred = { total: 7, hydrated: 0 };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("DEFERRED_SECTIONS_EMPTY");
    const data = receipt.data as { deferred_sections: { total: number; hydrated: number } };
    expect(data.deferred_sections).toEqual({ total: 7, hydrated: 0 });
    // Longer than the default: this is the one path that waits out the whole
    // DEFERRED_SECTIONS_TIMEOUT_MS window, because nothing ever arrives to end
    // it early. That wait is the behaviour under test, not overhead around it.
  }, DEFERRED_SECTIONS_TIMEOUT_MS + 5_000);

  it("does not warn when the deferred cards arrived, even with one left legitimately empty", async () => {
    const { outcome } = invoke({ tune: (s) => { s.tab.deferred = { total: 7, hydrated: 6 }; } });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).not.toContain("DEFERRED_SECTIONS_EMPTY");
  });

  it("warns when the read ran out of passes with page still below it (D320)", async () => {
    const { outcome } = invoke({
      // No explicit scroll count, so the read seeks the bottom — of a page no
      // ceiling can reach.
      args: { scrolls: undefined },
      tune: (s) => {
        s.tab.viewport = {
          width: 1333, height: 798, scrollHeight: 900_000,
          innerScroller: true, scrollerHeight: 746, documentScrollHeight: 798,
        };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PAGE_NOT_READ_TO_BOTTOM");
    const data = receipt.data as { reading: { reached_bottom: boolean | null } };
    expect(data.reading.reached_bottom).toBe(false);
  });

  it("reads a page that answered with its document and no api call at all (D321)", async () => {
    // Measured twice live on 2026-08-10: the profile document arrived, 1.0MB and
    // fully populated, and no Voyager call followed. Waiting on the api alone
    // failed the run CAPTURE_TIMEOUT and spent the page load for nothing — while
    // the reader's actual source, the rendered DOM, was sitting right there.
    const { outcome } = invoke({
      responses: [{ url: PROFILE_URL, body: "<html><body>a server-rendered profile</body></html>" }],
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
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

// ─────────────────────────────────────────────────────────────────────────────

/** The identity body, as D121 measured it on the wire: a `*elements` list of
 *  urn references, not inlined records. */
const IDENTITY_BODY = JSON.stringify({
  data: {
    identityDashProfilesByMemberIdentity: {
      "*elements": ["urn:li:fsd_profile:ACoAAEsubject"],
    },
  },
});
const ME_URL = "https://www.linkedin.com/voyager/api/me";
const ME_BODY = JSON.stringify({ miniProfile: { entityUrn: "urn:li:fsd_profile:ACoAAAoperator" } });

type SnapshotReceipt = {
  archived: string | null;
  bytes: number;
  rendered: boolean;
  failure: string | null;
  container: { selector: string | null; sections: number; sidebarsInside: number } | null;
  html_chars: number;
};
type VoyagerIdentityReceipt = {
  bodies: number; found: boolean; path: string | null; urnKind: string | null;
  isSession: boolean; sessionUrns: number;
};

type IdentityReceipt = {
  resolved: boolean; urnKind: string | null; vanityKnown: boolean; cards: number;
  strangerCards: number; unrecognisedCards: string[]; memberUrns: number; isSession: boolean;
  voyager: VoyagerIdentityReceipt;
};

function warningCodes(receipt: { ok: true; warnings: { code: string }[] } | { ok: false }): string[] {
  return receipt.ok ? receipt.warnings.map((w) => w.code) : [];
}

describe("profile.capture — the rendered-DOM snapshot (D123)", () => {
  it("archives the snapshot beside the tapped bodies, marked as a DOM read", async () => {
    const { outcome } = invoke({ responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }] });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");

    const files = await archived(receipt.run_id);
    expect(files.network).toHaveLength(1);
    expect(files.snapshots).toHaveLength(1);
    // Both live in the same directory; only the sidecar tells them apart.
    expect(archivedFiles(receipt.run_id)).toHaveLength(2);

    const entries = await new RawArchive(join(paths.runsDir, receipt.run_id, "raw")).list();
    const snap = entries.find(isDomSnapshotEntry)!;
    expect(snap.pattern).toBe(DOM_SNAPSHOT_PATTERN);
    expect(snap.status).toBe(0);
    expect(snap.url).toBe(`dom-snapshot:${PROFILE_URL}`);

    // Byte-identical: a reformatted snapshot would prove a parser against
    // markup the browser never rendered (D2's reason, one step on).
    const back = await new RawArchive(join(paths.runsDir, receipt.run_id, "raw")).readText(snap);
    expect(back).toBe(SNAPSHOT_HTML);

    const s = (receipt.data as { snapshot: SnapshotReceipt }).snapshot;
    expect(s.rendered).toBe(true);
    expect(s.failure).toBeNull();
    expect(s.archived).toBe(snap.file);
    expect(s.container?.selector).toBe("main#workspace");
    expect(warningCodes(receipt)).not.toContain("SUBJECT_CONTAINER_NOT_RENDERED");
  });

  it("does not count the snapshot as a captured response", async () => {
    // `counts.captured` is what an operator reads as "how much LinkedIn served".
    // A DOM read inflating it would make the tap look healthier than it is.
    const { outcome } = invoke({ responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }] });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.captured).toBe(1);
    expect((receipt.data as { capture: { captured: number } }).capture.captured).toBe(1);
  });

  it("warns, and does not claim a fixture, when the subject's container never rendered", async () => {
    // The not-rendered branch, proven — not just the happy path. A short
    // snapshot is still archived, because it is the evidence for the warning.
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = {
          html: "<html><body><main id=\"workspace\"></main></body></html>",
          url: PROFILE_URL,
          htmlChars: 52,
          textChars: 0,
          container: { selector: "main#workspace", chars: 30, textChars: 0, sections: 0, sidebars: 0, sidebarsInside: 0 },
        };
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(warningCodes(receipt)).toContain("SUBJECT_CONTAINER_NOT_RENDERED");
    expect((receipt.data as { snapshot: SnapshotReceipt }).snapshot.rendered).toBe(false);
    expect((await archived(receipt.run_id)).snapshots).toHaveLength(1);
  });

  it("warns when the container does not exclude the sidebar", async () => {
    // Container scoping is the only thing separating the subject from a "people
    // also viewed" stranger (D121/D123). If it does not hold, say so.
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = {
          html: SNAPSHOT_HTML,
          url: PROFILE_URL,
          htmlChars: SNAPSHOT_HTML.length,
          textChars: 9_000,
          container: { selector: "main#workspace", chars: 800, textChars: 9_000, sections: 14, sidebars: 3, sidebarsInside: 2 },
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(warningCodes(receipt)).toContain("SUBJECT_CONTAINER_NOT_SCOPED");
  });

  it("warns and keeps going when the page will not answer the snapshot read", async () => {
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = new Error("TAB_EVAL_FAILED: page JS threw during evaluate");
      },
    });
    const { receipt, exit } = await outcome;
    // The page load is already spent; 1 archived body is worth more than a halt.
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(warningCodes(receipt)).toContain("DOM_SNAPSHOT_FAILED");
    expect((await archived(receipt.run_id)).snapshots).toHaveLength(0);
    expect((await archived(receipt.run_id)).network).toHaveLength(1);
  });

  it("logs a lost snapshot as capture.miss, never as a hit with a null file", async () => {
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = null;
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const events = readFileSync(join(paths.runsDir, receipt.run_id, "events.ndjson"), "utf8")
      .split("\n").filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as { event: string; detail?: { kind?: string } });
    const snapEvents = events.filter((e) => e.detail?.kind === "dom-snapshot");
    expect(snapEvents).toHaveLength(1);
    expect(snapEvents[0]!.event).toBe("capture.miss");
  });
});

describe("profile.capture — identity from the snapshot (D130)", () => {
  function identityOf(receipt: { ok: true; data?: unknown } | { ok: false }): IdentityReceipt {
    if (!receipt.ok) throw new Error("expected ok");
    return (receipt.data as { identity: IdentityReceipt }).identity;
  }

  it("resolves the subject from the card-ref namespace, and never prints the id", async () => {
    const { outcome } = invoke({
      responses: [
        { url: ME_URL, body: ME_BODY },
        { url: PREDICTED_GQL, body: IDENTITY_BODY },
      ],
    });
    const { receipt } = await outcome;
    const id = identityOf(receipt);
    expect(id.resolved).toBe(true);
    expect(id.urnKind).toBe("urn:li:fsd_profile");
    expect(id.cards).toBe(3);
    expect(id.vanityKnown).toBe(true);
    expect(id.unrecognisedCards).toEqual([]);
    expect(id.isSession).toBe(false);
    // The prospect's id is captured data and receipts go to stdout (§4.1, D3).
    expect(JSON.stringify(receipt)).not.toContain(SUBJECT_ID);
    expect(warningCodes(receipt)).not.toContain("SUBJECT_IDENTITY_UNRESOLVED");
  });

  it("warns, and does not guess, when the snapshot carries no card refs", async () => {
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = {
          html: SNAPSHOT_HTML_NO_CARDS,
          url: PROFILE_URL,
          htmlChars: SNAPSHOT_HTML_NO_CARDS.length,
          textChars: 9_000,
          container: {
            selector: "main#workspace", chars: 800, textChars: 9_000,
            sections: 14, sidebars: 1, sidebarsInside: 0,
          },
        };
      },
    });
    const { receipt } = await outcome;
    expect(warningCodes(receipt)).toContain("SUBJECT_IDENTITY_UNRESOLVED");
    const id = identityOf(receipt);
    expect(id.resolved).toBe(false);
    expect(id.urnKind).toBeNull();
  });

  it("reports card names it does not know, because a shifted boundary is a wrong urn", async () => {
    // `ATopcard` / `ZAbout` is what a mis-cut id boundary looks like from the
    // other side: the names come out shifted by exactly the characters the id
    // is wrong by. One unknown name is a new card; this is the signal either way.
    const shifted =
      "<html><body><main id=\"workspace\">" +
      `<section componentkey="${CARD_REF}${SUBJECT_ID}Topcard">a</section>` +
      `<section componentkey="${CARD_REF}${SUBJECT_ID}BrandNewCard">b</section>` +
      `<section componentkey="${CARD_REF}${SUBJECT_ID}About">c</section>` +
      "</main></body></html>";
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: IDENTITY_BODY }],
      tune: (s) => {
        s.tab.snapshot = {
          html: shifted, url: PROFILE_URL, htmlChars: shifted.length, textChars: 9_000,
          container: {
            selector: "main#workspace", chars: 800, textChars: 9_000,
            sections: 14, sidebars: 0, sidebarsInside: 0,
          },
        };
      },
    });
    const { receipt } = await outcome;
    expect(warningCodes(receipt)).toContain("SUBJECT_CARD_NAMES_UNRECOGNISED");
    expect(identityOf(receipt).unrecognisedCards).toEqual(["BrandNewCard"]);
  });

  it("keeps the Voyager check as a field and raises no warning for it (D126)", async () => {
    // That endpoint takes the operator's own urn as its input and returns that
    // member, so `is_session` is true on every run for every profile. As a
    // warning it would fire forever and teach an operator to skip the block the
    // real identity warnings live in.
    const operator = "urn:li:fsd_profile:ACoAAAoperator";
    const { outcome } = invoke({
      responses: [
        { url: ME_URL, body: ME_BODY },
        {
          url: PREDICTED_GQL,
          body: JSON.stringify({
            data: { identityDashProfilesByMemberIdentity: { "*elements": [operator] } },
          }),
        },
      ],
    });
    const { receipt } = await outcome;
    const id = identityOf(receipt);
    expect(id.voyager.isSession).toBe(true);
    expect(id.voyager.bodies).toBe(1);
    // The subject still resolves from the snapshot, and it is not the operator.
    expect(id.resolved).toBe(true);
    expect(id.isSession).toBe(false);
    for (const code of warningCodes(receipt)) expect(code.startsWith("IDENTITY_")).toBe(false);
  });

  it("records a missing Voyager body without warning about it", async () => {
    const { outcome } = invoke({ responses: [{ url: UNPREDICTED_GQL, body: PROFILE_BODY }] });
    const { receipt } = await outcome;
    expect(identityOf(receipt).voyager.bodies).toBe(0);
    expect(warningCodes(receipt)).not.toContain("IDENTITY_BODY_ABSENT");
    // The identity that matters came from the snapshot, so the run is keyable.
    expect(identityOf(receipt).resolved).toBe(true);
  });

  it("warns when the snapshot's own identity is the operator's (D119)", async () => {
    // Must never happen against LinkedIn — it would mean the subject's profile
    // cards are namespaced by the operator. Pinned because this same trap has
    // now been found in three separate places.
    const operatorId = "ACoAAAoperator00000000000000000000000";
    const html =
      "<html><body><main id=\"workspace\">" +
      `<section componentkey="${CARD_REF}${operatorId}Topcard">a</section>` +
      `<section componentkey="${CARD_REF}${operatorId}About">b</section>` +
      `<section componentkey="${CARD_REF}${operatorId}Skills">c</section>` +
      "</main></body></html>";
    const { outcome } = invoke({
      responses: [
        { url: ME_URL, body: JSON.stringify({ miniProfile: { entityUrn: `urn:li:fsd_profile:${operatorId}` } }) },
        { url: PREDICTED_GQL, body: IDENTITY_BODY },
      ],
      tune: (s) => {
        s.tab.snapshot = {
          html, url: PROFILE_URL, htmlChars: html.length, textChars: 9_000,
          container: {
            selector: "main#workspace", chars: 800, textChars: 9_000,
            sections: 14, sidebars: 0, sidebarsInside: 0,
          },
        };
      },
    });
    const { receipt } = await outcome;
    expect(warningCodes(receipt)).toContain("SUBJECT_IDENTITY_IS_SESSION");
    expect(identityOf(receipt).isSession).toBe(true);
  });
});
