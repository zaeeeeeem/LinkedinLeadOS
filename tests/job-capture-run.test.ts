import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RECEIPT_ENDPOINT_CAP, capability as jobCapture } from "../src/capabilities/job.capture/index.js";
import { EXPANDER_EXPRESSION } from "../src/capabilities/job.capture/probe.js";
import type { ProbeTab } from "../src/capabilities/job.capture/probe.js";
import { VIEWPORT_EXPRESSION } from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab } from "../src/capabilities/profile.capture/read.js";
import { SNAPSHOT_EXPRESSION, isDomSnapshotEntry } from "../src/capabilities/profile.capture/snapshot.js";
import type { SnapshotTab } from "../src/capabilities/profile.capture/snapshot.js";
import { RawArchive } from "../src/core/archive/raw.js";
import type { Navigation } from "../src/core/session/tab.js";
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

/**
 * Compile-time: the worker tab satisfies all three of the interfaces this
 * capability drives it through — two of them written for `profile.capture` and
 * one new. `job.capture` is the first place a *second* capability composes that
 * machinery, and a mismatch would otherwise surface only at the live run
 * (m1-m3 CONTEXT §4: Task 6's `Screenshotter` against Task 4's `WorkerTab`).
 */
type Composes = TabLike extends SnapshotTab & ReadTab & ProbeTab ? true : never;
const _tabComposes: Composes = true;
void _tabComposes;

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
const JOB_ID = "4012345678";
const JOB_URL = `https://www.linkedin.com/jobs/view/${JOB_ID}/`;
const JOB_BODY = JSON.stringify({
  data: { entityUrn: `urn:li:fsd_jobPosting:${JOB_ID}`, company: "urn:li:fsd_company:1234" },
});
const ME_URL = "https://www.linkedin.com/voyager/api/me";
const ME_BODY = JSON.stringify({ miniProfile: { entityUrn: "urn:li:fsd_profile:ACoAAAOperator" } });

const PREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashJobPostings.1a&variables=(jobPostingId:4012345678)";
const UNPREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashSomethingNew.9f";
const TELEMETRY = "https://www.linkedin.com/li/track";

/** What the fake page's rendered DOM serializes to: a main container carrying
 *  more than the render floor, so the archived snapshot counts as evidence. */
const SNAPSHOT_HTML =
  `<html><body><main id="workspace"><h1>Senior Engineer</h1>` +
  `<div>${"posting text ".repeat(60)}</div>` +
  `<a href="/jobs/view/${JOB_ID}/">apply</a></main></body></html>`;

type Response = { url: string; body: string; status?: number; failed?: boolean };

/**
 * A fake page that emits the real CDP event sequence — `requestWillBeSent`,
 * `responseReceived`, `loadingFinished`, session-scoped and in that order. A
 * double emitting a convenient shorthand would certify the capture as working
 * against a protocol Chrome does not speak.
 */
class FakePage {
  private listeners = new Set<(e: CdpEvent) => void>();
  private nextId = 1;
  responses: Response[] = [];
  navigated = false;
  private bodies = new Map<string, string>();
  private urls = new Map<string, string>();
  /** Bodies for these urls take their time coming back off the wire, which is
   *  what makes the `finally { drain() }` assertion below load-bearing. */
  slowBodies = new Set<string>();

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

  emitAll(sessionId: string): void {
    for (const r of this.responses) {
      const requestId = `req-${this.nextId++}`;
      this.bodies.set(requestId, r.body);
      this.urls.set(requestId, r.url);
      this.emit(sessionId, "Network.requestWillBeSent", { requestId, request: { url: r.url, method: "GET" } });
      this.emit(sessionId, "Network.responseReceived", {
        requestId,
        response: { url: r.url, status: r.status ?? 200, mimeType: "application/json" },
      });
      if (r.failed) this.emit(sessionId, "Network.loadingFailed", { requestId, errorText: "net::ERR_ABORTED" });
      else this.emit(sessionId, "Network.loadingFinished", { requestId });
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
  navigateThrows: Error | null = null;
  probe: Partial<ChallengeProbe> | Error = { url: JOB_URL, text: "", captcha: false };
  probeAfterRead: Partial<ChallengeProbe> | Error | null = null;
  private probeCalls = 0;
  foreground = { ok: true, via: "already" as const, hidden: false };
  viewport: unknown = {
    width: 1440, height: 900, scrollHeight: 6000,
    innerScroller: true, scrollerHeight: 860, documentScrollHeight: 900,
  };
  snapshot: unknown = {
    html: SNAPSHOT_HTML,
    url: JOB_URL,
    htmlChars: SNAPSHOT_HTML.length,
    textChars: 9_000,
    container: {
      selector: "main#workspace", chars: 1_200, textChars: 900,
      sections: 0, sidebars: 0, sidebarsInside: 0,
    },
  };
  /** A clamped description behind a see-more control: the `dom-toggle` shape. */
  expander: unknown = {
    seeMoreControls: 1,
    clampedBlocks: 1,
    largest: {
      chars: 4_000, tag: "div", componentkey: "com.linkedin.sdui.jobs.description", id: null,
      clientHeight: 300, scrollHeight: 2_400, clamped: true, endsWithEllipsis: false,
    },
    textChars: 9_000,
    elementsWalked: 1_200,
    truncated: false,
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
      return { url: JOB_URL, text: "", captcha: false, ...answer } as T;
    }
    if (expression === VIEWPORT_EXPRESSION) return this.viewport as T;
    if (expression === SNAPSHOT_EXPRESSION) {
      if (this.snapshot instanceof Error) throw this.snapshot;
      return this.snapshot as T;
    }
    if (expression === EXPANDER_EXPRESSION) {
      if (this.expander instanceof Error) throw this.expander;
      return this.expander as T;
    }
    return "complete" as T;
  }
  async navigate(url: string): Promise<Navigation> {
    this.navigated.push(url);
    if (this.navigateThrows !== null) throw this.navigateThrows;
    this.page.navigated = true;
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
    async pause() {
      c.paused += 1;
      return 0;
    },
  };
  return c;
}

let dir: string;
let paths: { runsDir: string; leasePath: string; budgetPath: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "job-capture-"));
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
  session.page.responses = o.responses ?? [
    { url: PREDICTED_GQL, body: JOB_BODY },
    { url: ME_URL, body: ME_BODY },
  ];
  o.tune?.(session);
  const cursor = fakeCursor();
  return {
    session,
    cursor,
    outcome: execute({
      def: jobCapture as unknown as AnyCapability,
      rawArgs: { url: JOB_URL, scrolls: 2, layoutTimeoutMs: 50, ...o.args },
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

async function archived(runId: string): Promise<{ network: string[]; snapshots: string[] }> {
  const entries = await new RawArchive(join(paths.runsDir, runId, "raw")).list();
  return {
    network: entries.filter((e) => !isDomSnapshotEntry(e)).map((e) => e.file),
    snapshots: entries.filter(isDomSnapshotEntry).map((e) => e.file),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("job.capture — the happy path", () => {
  it("captures, archives bodies and a snapshot, spends one page load, and tears down", async () => {
    const { outcome, session, cursor } = invoke({});
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    expect(session.tab.navigated).toEqual([JOB_URL]);
    expect(receipt.counts).toEqual({ requested: 1, captured: 2, usable: 1, skipped: 0 });
    expect(receipt.warnings).toEqual([]);
    expect(receipt.cost.page_loads).toBe(1);

    const files = await archived(receipt.run_id);
    expect(files.network).toHaveLength(2);
    expect(files.snapshots).toHaveLength(1);
    expect(cursor.wheels).toBe(2);

    expect(session.closed).toBe(true);
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("spends a page load and never a profile open — a posting is not a profile view (D262)", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");

    const spends = ledgerLines();
    expect(spends.map((s) => s.kind)).toEqual(["page_load"]);
    expect(spends[0]!.capability).toBe("job.capture");
    // The receipt's cost is measured, not estimated: no profile_open was spent,
    // so no `profile_open` line exists to count.
    expect(spends.filter((s) => s.kind === "profile_open")).toEqual([]);
  });

  it("reports the endpoint path and operation id, never the query string", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as { capture: { endpoints: Array<Record<string, unknown>>; job_ish: number } };
    expect(data.capture.job_ish).toBe(1);
    // By operation id, not by position: bodies come off the wire in whatever
    // order Chrome answers `getResponseBody` in, and a positional assertion here
    // passes or fails on that race.
    const row = data.capture.endpoints.find((e) => e["query_id"] === "voyagerJobsDashJobPostings.1a");
    expect(row).toMatchObject({
      path: "/voyager/api/graphql",
      query_id: "voyagerJobsDashJobPostings.1a",
      profile_ish: true,
      unpredicted: false,
    });
    // `variables=(jobPostingId:…)` is captured data and must not reach stdout.
    expect(JSON.stringify(receipt)).not.toContain("jobPostingId:");
  });

  it("measures the scroller and the description, and prints neither page text nor a company id", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as {
      reading: { viewport: { innerScroller: boolean; scrollHeight: number } };
      description: { verdict: string; see_more_controls: number };
      identity: { companyResolved: boolean; companyUrnKind: string | null; subjectBodies: number };
    };

    // The job surface's own scroller measurement — never assumed to be the
    // profile's (D115).
    expect(data.reading.viewport.innerScroller).toBe(true);
    expect(data.reading.viewport.scrollHeight).toBe(6_000);
    expect(data.description).toMatchObject({ verdict: "dom-toggle", see_more_controls: 1 });
    expect(data.identity).toMatchObject({
      subjectBodies: 1, companyResolved: true, companyUrnKind: "urn:li:fsd_company",
    });
    // The urn family, never the id.
    expect(JSON.stringify(receipt)).not.toContain("urn:li:fsd_company:1234");
  });

  it("names the job-family promotion step as the next command", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.next).toContain("fixtures:promote");
    expect(receipt.next).toContain("--capability=job.get");
    expect(receipt.next).toContain(receipt.run_id);
  });
});

describe("job.capture — what it refuses to report as success", () => {
  it("warns when no captured body and no snapshot names the requested posting", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: JSON.stringify({ data: { entityUrn: "urn:li:fsd_jobPosting:9999999999" } }) },
        { url: ME_URL, body: ME_BODY },
      ],
      tune: (s) => {
        s.tab.snapshot = {
          html: "<html><body><main>other posting</main></body></html>",
          url: JOB_URL, htmlChars: 60, textChars: 500,
          container: { selector: "main", chars: 60, textChars: 500, sections: 0, sidebars: 0, sidebarsInside: 0 },
        };
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    // Promoting this would file a stranger's posting under the requested id.
    expect(receipt.warnings.map((w) => w.code)).toContain("JOB_SUBJECT_NOT_SERVED");
  });

  it("warns when nothing carrying job data arrived", async () => {
    const { outcome } = invoke({
      responses: [{ url: "https://www.linkedin.com/voyager/api/graphql?queryId=feed.1", body: '{"data":{}}' }],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.usable).toBe(0);
    expect(receipt.warnings.map((w) => w.code)).toContain("NO_JOB_PAYLOAD");
  });

  it("warns when a posting arrives on an endpoint no specific pattern predicted", async () => {
    const { outcome } = invoke({ responses: [{ url: UNPREDICTED_GQL, body: JOB_BODY }] });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PATTERN_MISMATCH");
    expect(receipt.counts.usable).toBe(1);
  });

  it("warns when the session's own urns are unknown, so the identity checks proved nothing", async () => {
    const { outcome } = invoke({ responses: [{ url: PREDICTED_GQL, body: JOB_BODY }] });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("SESSION_IDENTITY_UNKNOWN");
  });

  it("warns, with the count, when the hiring company cannot be resolved by agreement", async () => {
    const { outcome } = invoke({
      responses: [
        {
          url: PREDICTED_GQL,
          body: JSON.stringify({
            data: { entityUrn: `urn:li:fsd_jobPosting:${JOB_ID}`, a: "urn:li:fsd_company:1", b: "urn:li:fsd_company:2" },
          }),
        },
        { url: ME_URL, body: ME_BODY },
      ],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const warning = receipt.warnings.find((w) => w.code === "COMPANY_URN_UNRESOLVED");
    expect(warning?.n).toBe(2);
  });

  it("says the description source is unknown rather than letting it read as 'no fetch'", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.expander = {
          seeMoreControls: 2, clampedBlocks: 0, largest: null,
          textChars: 100, elementsWalked: 10, truncated: false,
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("DESCRIPTION_SOURCE_UNKNOWN");
    expect((receipt.data as { description: { verdict: string } }).description.verdict).toBe("unknown");
  });

  it("warns when the description measurement did not run at all", async () => {
    const { outcome } = invoke({ tune: (s) => { s.tab.expander = new Error("context destroyed"); } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("DESCRIPTION_NOT_MEASURED");
    // The capture still stands: the page load is spent and the bodies are on disk.
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("warns when the container rendered too little to build a field map from", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.snapshot = {
          html: `<html><body><main>${JOB_ID}</main></body></html>`,
          url: JOB_URL, htmlChars: 50, textChars: 20,
          container: { selector: "main", chars: 30, textChars: 20, sections: 0, sidebars: 0, sidebarsInside: 0 },
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("JOB_CONTAINER_NOT_RENDERED");
    // Archived anyway — a short snapshot is evidence about the page, and
    // discarding it would leave the warning with nothing behind it (D2).
    expect((await archived(receipt.run_id)).snapshots).toHaveLength(1);
  });

  it("does not raise the profile page's section-count expectation on this surface", async () => {
    // The happy-path snapshot has zero <section> elements, which is what the job
    // page has never been measured to have. Requiring them would fail a rendered
    // page (see constants.isJobPageRendered).
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings).toEqual([]);
    expect((receipt.data as { snapshot: { rendered: boolean } }).snapshot.rendered).toBe(true);
  });
});

describe("job.capture — the gates and the spend order", () => {
  it("halts on a challenge after navigation, with a screenshot and a checkpoint, exit 2", async () => {
    const { outcome, session } = invoke({
      tune: (s) => {
        s.tab.probe = { url: "https://www.linkedin.com/checkpoint/challenge/", text: "", captcha: true };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.CHALLENGE);
    if (receipt.ok) throw new Error("expected a challenge halt");
    expect(receipt.error.code).toBe("CHALLENGE_CAPTCHA");
    expect(receipt.error.retryable).toBe(false);
    expect(session.tab.shots).toHaveLength(1);
    expect(existsSync(join(paths.runsDir, receipt.run_id, "checkpoint.json"))).toBe(true);
    // Released even on the halting path.
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("archives what was already on the wire when the run halts mid-read", async () => {
    // The property `finally { drain() }` exists for: a body fetched for a phase
    // that is over must still reach disk, because the page load is spent either
    // way (D2).
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: JOB_BODY },
        { url: UNPREDICTED_GQL, body: JOB_BODY },
      ],
      tune: (s) => {
        // The second body is still being fetched when the pre-success gate
        // fires. Without the drain the tap drops it, and a spent page load ends
        // with an incomplete archive.
        s.page.slowBodies.add(UNPREDICTED_GQL);
        s.tab.probeAfterRead = { url: "https://www.linkedin.com/checkpoint/challenge/", text: "", captcha: true };
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.CHALLENGE);
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("leaves the ledger over-counting, never under-counting, when the navigation throws", async () => {
    const { outcome } = invoke({ tune: (s) => { s.tab.navigateThrows = new Error("nav failed"); } });
    const { receipt, exit } = await outcome;

    expect(exit).not.toBe(EXIT.OK);
    expect(receipt.ok).toBe(false);
    // Spent before the navigation, on purpose: the ledger protects the account,
    // and the direction it errs in is the whole point (§8).
    expect(ledgerLines().map((s) => s.kind)).toEqual(["page_load"]);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("refuses a url that names no posting before anything is opened or spent", async () => {
    const { outcome, session } = invoke({
      args: { url: "https://www.linkedin.com/jobs/collections/recommended/" },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.GENERIC);
    if (receipt.ok) throw new Error("expected a refusal");
    expect(receipt.error.code).toBe("JOB_URL_INVALID");
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toEqual([]);
  });

  it("archives telemetry never, and a lost body as a miss rather than a clean zero", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: JOB_BODY },
        { url: TELEMETRY, body: '{"events":[]}' },
        { url: UNPREDICTED_GQL, body: "{}", failed: true },
      ],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.captured).toBe(1);
    expect(receipt.counts.skipped).toBe(1);
    expect(receipt.warnings.map((w) => w.code)).toContain("CAPTURE_MISSES");
  });
});

describe("job.capture — the receipt stays an envelope", () => {
  it("caps the endpoint table and says how many rows it left out", async () => {
    // A stated bound with a test that exceeds it. A job page can issue well over
    // a hundred calls, and stdout is an envelope (§4.1, D3) — the full table is
    // in the archive's sidecars. A row dropped without a count would be silent.
    const many = Array.from({ length: RECEIPT_ENDPOINT_CAP + 5 }, (_, i) => ({
      url: `https://www.linkedin.com/voyager/api/graphql?queryId=voyagerJobsDashUnknown.${i}`,
      body: JSON.stringify({ data: { entityUrn: `urn:li:fsd_jobPosting:${JOB_ID}`, i } }),
    }));
    const { outcome } = invoke({ responses: many });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");

    const data = receipt.data as { capture: { endpoints: unknown[]; endpoints_omitted: number; captured: number } };
    expect(data.capture.captured).toBe(RECEIPT_ENDPOINT_CAP + 5);
    expect(data.capture.endpoints).toHaveLength(RECEIPT_ENDPOINT_CAP);
    expect(data.capture.endpoints_omitted).toBe(5);
  });
});

describe("job.capture — the run directory", () => {
  it("writes a run.json whose url the promoter can read the subject back from", async () => {
    // `scripts/promote-fixtures.ts` reads `args.url` to learn which posting the
    // fixtures are of. If that round trip breaks, promotion falls back to "any
    // relevant body", which is the D118 failure on a new surface.
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const meta = JSON.parse(
      readFileSync(join(paths.runsDir, receipt.run_id, "run.json"), "utf8"),
    ) as { capability: string; args: Record<string, unknown> };
    expect(meta.capability).toBe("job.capture");
    expect(meta.args["url"]).toBe(JOB_URL);
    expect(readdirSync(join(paths.runsDir, receipt.run_id))).toContain("raw");
  });
});
