import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  awaitFirstApiResponse, capability as companyProbe, pushSurfaceWarnings, samePage,
} from "../src/capabilities/company.probe/index.js";
import type { SubPageOutcome } from "../src/capabilities/company.probe/index.js";
import { RECEIPT_ENDPOINTS_PER_SUBPAGE } from "../src/capabilities/company.probe/constants.js";
import { VIEWPORT_EXPRESSION } from "../src/capabilities/profile.capture/read.js";
import type { ReadCursor, ReadTab } from "../src/capabilities/profile.capture/read.js";
import type { SnapshotArchive, SnapshotTab } from "../src/capabilities/profile.capture/snapshot.js";
import { documentPattern } from "../src/capabilities/profile.capture/patterns.js";
import { documentPatternName } from "../src/capabilities/company.probe/patterns.js";
import { companySubPageUrl, normalizeCompanyUrl } from "../src/capabilities/company.probe/url.js";
import { SNAPSHOT_EXPRESSION, isDomSnapshotEntry } from "../src/capabilities/profile.capture/snapshot.js";
import { PROBE_EXPRESSION } from "../src/core/challenge/detect.js";
import type { ChallengeProbe } from "../src/core/challenge/detect.js";
import { RawArchive } from "../src/core/archive/raw.js";
import type { CdpEvent } from "../src/core/cdp/client.js";
import type { HumanCursor } from "../src/core/input/cursor.js";
import type { SpendRecord } from "../src/core/budget/ledger.js";
import { CapabilityError, EXIT, type Warning } from "../src/core/run/receipt.js";
import { inspectLease } from "../src/core/lease/tab-lease.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute } from "../src/cli/run.js";
import type { AnyCapability, SessionLike, TabLike, UniversalFlags } from "../src/cli/types.js";
import type { TapTransport } from "../src/core/tap/network-tap.js";

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
const COMPANY_URL = "https://www.linkedin.com/company/acme-robotics/";
const SUBS = ["main", "about", "posts", "people", "jobs"] as const;

/** A body carrying company-family data, per `isCompanyIsh`. */
const COMPANY_BODY = JSON.stringify({
  data: { company: { entityUrn: "urn:li:fsd_company:1441", name: "Acme Robotics" } },
});
/** A body carrying *person* data and no company marker — the people surface's
 *  shape, and the reason the receipt has a second column for it. */
const PERSON_BODY = JSON.stringify({ data: { elements: [{ entityUrn: "urn:li:fsd_profile:ACoAAsomeone" }] } });
/** LinkedIn's own telemetry: api-shaped, high volume, never company data. */
const TELEMETRY = "https://www.linkedin.com/li/track";

const gql = (queryId: string) =>
  `https://www.linkedin.com/voyager/api/graphql?queryId=${queryId}&variables=(universalName:acme-robotics)`;

type Response = { url: string; body: string; status?: number; failed?: boolean };

/** Emits the real CDP event sequence, session-scoped, because the tap's whole
 *  design is about that ordering (CONTEXT §3). Responses are keyed by which
 *  sub-page url was navigated to, so attribution can be asserted. */
class FakePage {
  private listeners = new Set<(e: CdpEvent) => void>();
  private nextId = 1;
  private bodies = new Map<string, string>();
  private urls = new Map<string, string>();
  /** Bodies for these urls take their time coming back off the wire, so a run
   *  that throws with a fetch still in flight can be told apart from one that
   *  waited for it. */
  slowBodies = new Set<string>();
  /** url substring → responses that page "fetches". */
  responsesFor: (navigatedUrl: string) => Response[] = () => [{ url: gql("voyagerOrganizationDashCompanies.aa"), body: COMPANY_BODY }];

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

  emitFor(sessionId: string, navigatedUrl: string): void {
    for (const r of this.responsesFor(navigatedUrl)) {
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

const snapshotHtml = (sub: string) =>
  `<html><body><main id="workspace"><section>${sub} content for Acme Robotics</section></main></body></html>`;

class FakeTab implements TabLike {
  readonly targetId = "target-1";
  readonly sessionId = "session-1";
  navigated: string[] = [];
  shots: string[] = [];
  /** Thrown from `navigate` when the navigated url contains this. */
  navFailsOn: string | null = null;
  /** The navigated url reports itself as this instead (a redirect). */
  landsOn: ((url: string) => string) | null = null;
  /** Sub-page name → a challenge answer for the probe once that page is open.
   *  Fires on the post-navigation gate, before any work is done. */
  challengeOn: string | null = null;
  /** Same, but only from the *second* probe of that sub-page — the pre-success
   *  gate, after the page has been read and its fetches are on the wire. */
  challengeAfterRead: string | null = null;
  private probeCalls = new Map<string, number>();
  /** Sub-pages whose snapshot read throws. */
  snapshotFailsOn = new Set<string>();
  /** Sub-pages whose surface measurement throws. */
  surfaceFailsOn = new Set<string>();
  foreground = { ok: true, via: "already" as const, hidden: false };

  constructor(private readonly page: FakePage) {}

  private get current(): string {
    return this.navigated.at(-1) ?? "about:blank";
  }
  private subOf(url: string): string {
    for (const sub of SUBS) if (sub !== "main" && url.includes(`/${sub}/`)) return sub;
    return "main";
  }

  async send<T>(): Promise<T> {
    return {} as T;
  }
  async evaluate<T>(expression: string): Promise<T> {
    const sub = this.subOf(this.current);
    if (expression === PROBE_EXPRESSION) {
      const seen = (this.probeCalls.get(sub) ?? 0) + 1;
      this.probeCalls.set(sub, seen);
      const challenged =
        this.challengeOn === sub || (this.challengeAfterRead === sub && seen > 1);
      const probe: ChallengeProbe = {
        url: this.current,
        text: challenged ? "Let's do a quick security check" : "",
        captcha: false,
      };
      return probe as T;
    }
    if (expression === VIEWPORT_EXPRESSION) {
      return {
        width: 1440, height: 900, scrollHeight: 5000,
        innerScroller: true, scrollerHeight: 860, documentScrollHeight: 900,
      } as T;
    }
    if (expression === SNAPSHOT_EXPRESSION) {
      if (this.snapshotFailsOn.has(sub)) throw new Error(`snapshot refused on ${sub}`);
      const html = snapshotHtml(sub);
      return {
        html, url: this.current, htmlChars: html.length, textChars: 9_000,
        container: { selector: "main#workspace", chars: 800, textChars: 9_000, sections: 4, sidebars: 0, sidebarsInside: 0 },
      } as T;
    }
    if (expression.includes("var SUBS =")) {
      if (this.surfaceFailsOn.has(sub)) throw new Error(`surface refused on ${sub}`);
      return {
        url: this.landsOn === null ? this.current : this.landsOn(this.current),
        scroller: { tag: "main", id: "workspace", hasComponentKey: false, scrollHeight: 5000, clientHeight: 860, isDocument: false },
        tabs: SUBS.map((s) => ({ sub: s, linked: true, tag: "a", links: 1 })),
        embedded: { ldJson: 1, ldJsonChars: 120, applicationJson: 0, applicationJsonChars: 0, globals: [] },
        namespaces: [{ prefix: "com.linkedin.sdui.organization.card", n: 9 }],
        componentKeys: 9,
        render: { sections: 4, articles: 2, listItems: 12, anchors: 80 },
      } as T;
    }
    return "complete" as T;
  }
  async navigate(url: string): Promise<void> {
    if (this.navFailsOn !== null && url.includes(this.navFailsOn)) {
      this.navigated.push(url);
      throw new Error(`navigation refused for ${url}`);
    }
    this.navigated.push(url);
    setTimeout(() => this.page.emitFor(this.sessionId, url), 0);
  }
  async currentUrl(): Promise<string> {
    return this.current;
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
  async close(): Promise<void> {}
}

class FakeSession implements SessionLike {
  readonly endpoint = { port: 9223, wsUrl: "ws://127.0.0.1:9223/devtools/browser/fake", launched: false };
  readonly page = new FakePage();
  readonly tab: FakeTab;
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
  async close(): Promise<void> {}
}

function fakeCursor(): ReadCursor {
  return {
    async wheel(_x: number, _y: number, deltaY: number) {
      return { requested: deltaY, scrolled: deltaY, notches: 1 };
    },
    async pause() {
      return 0;
    },
  };
}

let dir: string;
let paths: { runsDir: string; leasePath: string; budgetPath: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "company-probe-"));
  paths = {
    runsDir: join(dir, "runs"),
    leasePath: join(dir, "runs", "tab.lock"),
    budgetPath: join(dir, "runs", "budget.ndjson"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function invoke(o: { args?: Record<string, unknown>; flags?: Partial<UniversalFlags>; tune?: (s: FakeSession) => void } = {}) {
  const session = new FakeSession();
  o.tune?.(session);
  return {
    session,
    outcome: execute({
      def: companyProbe as unknown as AnyCapability,
      rawArgs: { url: COMPANY_URL, scrolls: 1, layoutTimeoutMs: 30, captureTimeoutMs: 300, ...o.args },
      flags: { ...DEFAULT_FLAGS, ...o.flags },
      ...paths,
      deps: {
        openSession: async () => session,
        makeCursor: () => fakeCursor() as unknown as HumanCursor,
      },
    }),
  };
}

function ledgerLines(): SpendRecord[] {
  if (!existsSync(paths.budgetPath)) return [];
  return readFileSync(paths.budgetPath, "utf8").split("\n").filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as SpendRecord);
}

async function archived(runId: string): Promise<{ network: string[]; snapshots: string[] }> {
  const raw = join(paths.runsDir, runId, "raw");
  if (!existsSync(raw)) return { network: [], snapshots: [] };
  const entries = await new RawArchive(raw).list();
  return {
    network: entries.filter((e) => !isDomSnapshotEntry(e)).map((e) => e.url),
    snapshots: entries.filter(isDomSnapshotEntry).map((e) => e.url),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("company.probe — the happy path", () => {
  it("loads all five sub-pages, archives each, and spends exactly one page load each", async () => {
    const { outcome, session } = invoke();
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    expect(session.tab.navigated).toEqual([
      COMPANY_URL,
      `${COMPANY_URL}about/`,
      `${COMPANY_URL}posts/`,
      `${COMPANY_URL}people/`,
      `${COMPANY_URL}jobs/`,
    ]);

    const spends = ledgerLines();
    expect(spends).toHaveLength(5);
    expect(spends.every((s) => s.capability === "company.probe")).toBe(true);
    expect(spends.every((s) => s.kind === "page_load")).toBe(true);
    // A company page is not a profile view, and the ledger must not record one.
    expect(spends.some((s) => s.kind === "profile_open")).toBe(false);
    expect(receipt.cost).toMatchObject({ page_loads: 5, search_credits: 0 });

    const { snapshots } = await archived(receipt.run_id);
    expect(snapshots).toHaveLength(5);
    expect(new Set(snapshots).size).toBe(5);

    const data = receipt.data as { subpages: SubPageOutcome[]; snapshots: number };
    expect(data.subpages.map((s) => s.sub)).toEqual([...SUBS]);
    expect(data.subpages.every((s) => s.stage === "done")).toBe(true);
    expect(data.subpages.every((s) => s.page_load_spent)).toBe(true);
    expect(data.snapshots).toBe(5);
  });

  it("releases the tab lease", async () => {
    const { receipt } = await invoke().outcome;
    expect(receipt.ok).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("attributes captures to the sub-page that was open when they landed", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.page.responsesFor = (url) =>
          url.includes("/people/")
            ? [{ url: gql("voyagerOrganizationDashPeople.bb"), body: PERSON_BODY }]
            : [{ url: gql("voyagerOrganizationDashCompanies.aa"), body: COMPANY_BODY }];
      },
    });
    const { receipt } = await outcome;
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const subs = (receipt.data as { subpages: SubPageOutcome[] }).subpages;
    const by = Object.fromEntries(subs.map((s) => [s.sub, s]));

    expect(by["main"]!.company_ish).toBe(1);
    expect(by["main"]!.person_ish).toBe(0);
    // The people surface carries person urns and no company marker. A probe that
    // reported only company markers would call the highest-identity-risk surface
    // empty (Task 24).
    expect(by["people"]!.company_ish).toBe(0);
    expect(by["people"]!.person_ish).toBe(1);
    expect(subs.every((s) => s.captured === 1)).toBe(true);
  });

  it("honours --subpages, spending only what was asked for", async () => {
    const { outcome, session } = invoke({ args: { subpages: "jobs,main" } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(session.tab.navigated).toEqual([COMPANY_URL, `${COMPANY_URL}jobs/`]);
    expect(ledgerLines()).toHaveLength(2);
    expect(receipt.ok && receipt.cost.page_loads).toBe(2);
  });

  it("puts no captured LinkedIn data on the receipt", async () => {
    const { receipt } = await invoke().outcome;
    const printed = JSON.stringify(receipt);
    // The company's name and its urn are in the archived bodies and in the
    // snapshot; neither may be on stdout (§4.1, D3).
    expect(printed).not.toContain("Acme Robotics");
    expect(printed).not.toContain("urn:li:fsd_company:1441");
    // The vanity the operator typed is theirs already, so the target url may
    // appear — but nothing read off the page may.
    expect(printed).toContain("company:acme-robotics");
  });
});

describe("company.probe — findings it exists to record", () => {
  it("records a sub-page that issued no api response, without failing the run", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.page.responsesFor = (url) =>
          url.includes("/jobs/") ? [] : [{ url: gql("voyagerOrganizationDashCompanies.aa"), body: COMPANY_BODY }];
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const jobs = (receipt.data as { subpages: SubPageOutcome[] }).subpages.find((s) => s.sub === "jobs")!;
    expect(jobs.api_response).toBe(false);
    expect(jobs.stage).toBe("done");
    expect(jobs.snapshot.archived).not.toBeNull();
    expect(receipt.warnings.map((w) => w.code)).toContain("SUBPAGE_NO_API_RESPONSE");
  });

  it("bounds the endpoint rows each sub-page puts on the receipt", async () => {
    const many = Array.from({ length: RECEIPT_ENDPOINTS_PER_SUBPAGE + 6 }, (_, i) => ({
      url: gql(`voyagerSomethingUnpredicted.${i}`),
      body: COMPANY_BODY,
    }));
    const { outcome } = invoke({ args: { subpages: "main" }, tune: (s) => { s.page.responsesFor = () => many; } });
    const { receipt } = await outcome;
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const main = (receipt.data as { subpages: SubPageOutcome[] }).subpages[0]!;
    expect(main.captured).toBe(many.length);
    expect(main.endpoints).toHaveLength(RECEIPT_ENDPOINTS_PER_SUBPAGE);
  });

  it("records a sub-page that redirected away from the url that was asked for", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.landsOn = (url) => (url.includes("/posts/") ? `${COMPANY_URL}` : url);
      },
    });
    const { receipt } = await outcome;
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const warning = receipt.warnings.find((w) => w.code === "SUBPAGE_REDIRECTED");
    expect(warning).toBeDefined();
    expect(warning!.field).toMatch(/posts/);
    const posts = (receipt.data as { subpages: SubPageOutcome[] }).subpages.find((s) => s.sub === "posts")!;
    expect(posts.landed_url).toBe(COMPANY_URL);
  });

  it("records a sub-page whose snapshot could not be read, and still finishes it", async () => {
    const { outcome } = invoke({ tune: (s) => s.tab.snapshotFailsOn.add("about") });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const warning = receipt.warnings.find((w) => w.code === "DOM_SNAPSHOT_MISSING")!;
    expect(warning.n).toBe(1);
    expect(warning.field).toMatch(/about/);
    expect((await archived(receipt.run_id)).snapshots).toHaveLength(4);
  });

  it("records a sub-page whose structural measurement failed, and still finishes it", async () => {
    const { outcome } = invoke({ tune: (s) => s.tab.surfaceFailsOn.add("people") });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.warnings.map((w) => w.code)).toContain("SURFACE_UNMEASURED");
    const people = (receipt.data as { subpages: SubPageOutcome[] }).subpages.find((s) => s.sub === "people")!;
    expect(people.surface).toBeNull();
    expect(people.stage).toBe("done");
    // The snapshot is what a parser needs and it landed regardless.
    expect(people.snapshot.archived).not.toBeNull();
  });

  it("fails transient rather than reporting ok when nothing at all was archived", async () => {
    const { outcome } = invoke({ tune: (s) => { s.page.responsesFor = () => []; } });
    const { receipt, exit } = await outcome;
    expect(receipt.ok).toBe(false);
    expect(exit).toBe(EXIT.TRANSIENT);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("PROBE_NO_CAPTURE");
    expect(receipt.error.retryable).toBe(true);
  });

  it("counts telemetry as captured but never as company data", async () => {
    const { outcome } = invoke({
      tune: (s) => { s.page.responsesFor = () => [{ url: TELEMETRY, body: COMPANY_BODY }]; },
    });
    const { receipt } = await outcome;
    // The broad net excludes `/li/track`, so nothing is captured at all and the
    // run says so loudly rather than reporting a company payload.
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("PROBE_NO_CAPTURE");
  });
});

describe("company.probe — what is left behind when a sub-page throws", () => {
  it("keeps every earlier sub-page's bodies and snapshots when navigation fails midway", async () => {
    const { outcome, session } = invoke({ tune: (s) => { s.tab.navFailsOn = "/posts/"; } });
    const { receipt, exit } = await outcome;

    expect(receipt.ok).toBe(false);
    expect(exit).not.toBe(EXIT.OK);
    if (receipt.ok) return;

    // Two sub-pages completed; the third died on navigation. Raw-first is not
    // conditional (D2) — the drain runs on the throwing path too.
    const { network, snapshots } = await archived(receipt.run_id);
    expect(snapshots).toHaveLength(2);
    expect(network.length).toBeGreaterThanOrEqual(2);
    // Three loads were spent, because the third was spent before the navigation
    // that failed: the ledger must over-count, never under-count (§8).
    expect(ledgerLines()).toHaveLength(3);
    expect(session.tab.navigated.at(-1)).toBe(`${COMPANY_URL}posts/`);
  });

  it("halts on a challenge, screenshots it, and leaves the earlier sub-pages archived", async () => {
    const { outcome, session } = invoke({ tune: (s) => { s.tab.challengeOn = "about"; } });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.CHALLENGE);
    expect(receipt.ok).toBe(false);
    expect(session.tab.shots.length).toBeGreaterThan(0);
    if (receipt.ok) return;
    expect((await archived(receipt.run_id)).snapshots).toHaveLength(1);
    // The remaining three sub-pages were never opened. A challenge is never
    // pushed past.
    expect(session.tab.navigated).toEqual([COMPANY_URL, `${COMPANY_URL}about/`]);
    expect(ledgerLines()).toHaveLength(2);
  });

  it("archives a body still in flight when the run halts (raw-first is not conditional, D2)", async () => {
    const slow = gql("voyagerOrganizationDashCompanies.slow");
    const { outcome } = invoke({
      tune: (s) => {
        s.page.responsesFor = (url) =>
          url.includes("/about/")
            ? [{ url: slow, body: COMPANY_BODY }]
            : [{ url: gql("voyagerOrganizationDashCompanies.aa"), body: COMPANY_BODY }];
        s.page.slowBodies.add(slow);
        // The challenge fires on the *pre-success* gate of the same sub-page
        // whose body is still coming off the wire — the post-navigation gate
        // would throw before the page had fetched anything, which proves
        // nothing about the drain.
        s.tab.challengeAfterRead = "about";
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.CHALLENGE);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    // Two sub-pages opened, two bodies on the wire, both on disk.
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("releases the lease on the throwing path", async () => {
    await invoke({ tune: (s) => { s.tab.navFailsOn = "/about/"; } }).outcome;
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });
});

describe("company.probe — the budget is checked before anything is spent", () => {
  it("refuses the whole invocation before the first navigation when the cap cannot cover it", async () => {
    const { outcome, session } = invoke({ flags: { budget: 2 } });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.BUDGET);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("BUDGET_INVOCATION_CAP");
    // Nothing opened, nothing spent. A probe refused halfway through has spent
    // account activity for a measurement nobody can use.
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toEqual([]);
  });

  it("declares the whole invocation's cost up front, which is what preflight gates on", () => {
    // The refusal above happens before the capability's own `run` is entered,
    // and this is the value that makes it happen: a cost function that reported
    // one load would let a five-load probe past a two-load cap.
    expect(companyProbe.cost({ url: COMPANY_URL })).toEqual({
      page_loads: 5, search_pages: 0, profile_opens: 0,
    });
    expect(companyProbe.cost({ url: COMPANY_URL, subpages: "main,jobs" })).toMatchObject({ page_loads: 2 });
  });

  it("stops mid-probe when the shared ledger runs out, having spent only what it recorded", async () => {
    // The probe's own daily sub-cap is 12 page loads (D153/D162). Pre-fill the
    // ledger so only three remain and the fourth sub-page trips it.
    mkdirSync(join(dir, "runs"), { recursive: true });
    const lines = Array.from({ length: 9 }, (_, i) =>
      JSON.stringify({
        ts: new Date().toISOString(), run_id: `prior-${i}`, capability: "company.probe",
        kind: "page_load", n: 1,
      }),
    );
    writeFileSync(paths.budgetPath, `${lines.join("\n")}\n`);

    const { outcome, session } = invoke();
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.BUDGET);
    expect(receipt.ok).toBe(false);
    // The batch check refuses before the first load, because five will not fit
    // in three — the whole point of checking the total up front.
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toHaveLength(9);
  });
});

describe("pushSurfaceWarnings — one row per finding, naming which sub-pages", () => {
  const outcome = (o: Partial<SubPageOutcome> & { sub: SubPageOutcome["sub"] }): SubPageOutcome => ({
    requested_url: `${COMPANY_URL}${o.sub === "main" ? "" : `${o.sub}/`}`,
    landed_url: null, stage: "done", page_load_spent: true, api_response: true,
    captured: 1, company_ish: 1, person_ish: 0, unmatched_company_ish: 0, misses: 0,
    layout_settled: true, scroll_passes: 1, scrolled_px: 100,
    snapshot: { archived: "f", bytes: 1, rendered: true, failure: null, container: null },
    surface: {
      url: "", scroller: { tag: "main", id: "workspace", hasComponentKey: false, scrollHeight: 1, clientHeight: 1, isDocument: false },
      tabs: [], embedded: { ldJson: 0, ldJsonChars: 0, applicationJson: 0, applicationJsonChars: 0, globals: [] },
      namespaces: [], componentKeys: 0, render: { sections: 1, articles: 0, listItems: 0, anchors: 0 },
    },
    endpoints: [], ...o,
  });

  it("aggregates rather than repeating the same code five times", () => {
    const warnings: Warning[] = [];
    pushSurfaceWarnings(warnings, [
      outcome({ sub: "main", layout_settled: false }),
      outcome({ sub: "about", layout_settled: false }),
    ]);
    const unsettled = warnings.filter((w) => w.code === "SUBPAGE_NOT_LAID_OUT");
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.n).toBe(2);
    expect(unsettled[0]!.field).toMatch(/main, about/);
  });

  it("names the stage an unfinished sub-page died at", () => {
    const warnings: Warning[] = [];
    pushSurfaceWarnings(warnings, [outcome({ sub: "posts", stage: "snapshot" })]);
    const incomplete = warnings.find((w) => w.code === "SUBPAGE_INCOMPLETE")!;
    expect(incomplete.field).toMatch(/posts \(stopped at snapshot\)/);
  });

  it("does not report an unfinished sub-page as one that answered nothing", () => {
    // A sub-page that never reached the wait has `api_response: false` because
    // nothing set it, and reporting that as "this tab fetches nothing" would be
    // a measurement claim about a page that was never measured.
    const warnings: Warning[] = [];
    pushSurfaceWarnings(warnings, [outcome({ sub: "jobs", stage: "navigate", api_response: false, layout_settled: false })]);
    expect(warnings.map((w) => w.code)).toEqual(["SUBPAGE_INCOMPLETE"]);
  });

  it("is silent when every sub-page finished cleanly", () => {
    const warnings: Warning[] = [];
    pushSurfaceWarnings(warnings, SUBS.map((sub) => outcome({ sub })));
    expect(warnings).toEqual([]);
  });
});

describe("the modules company.probe is the first to compose", () => {
  /**
   * Review shape 4: this capability is the first place `readLikeAHuman`,
   * `captureDomSnapshot` and the runner's `TabLike` meet outside
   * `profile.capture`. A mismatch between them would otherwise survive until
   * some later task happened to need all three — which is how Task 10 found
   * `Screenshotter` by accident. These cost a line each and fail at compile.
   */
  it("accepts the runner's tab everywhere the reused modules ask for one", () => {
    const asReadTab: ReadTab = null as unknown as TabLike;
    const asSnapshotTab: SnapshotTab = null as unknown as TabLike;
    const asArchive: SnapshotArchive = null as unknown as RawArchive;
    void asReadTab;
    void asSnapshotTab;
    void asArchive;
    expect(true).toBe(true);
  });

  it("watches one document pattern per sub-page, all distinctly named", () => {
    const target = normalizeCompanyUrl(COMPANY_URL);
    const names = SUBS.map((sub) => documentPattern(companySubPageUrl(target, sub), documentPatternName(sub)).name);
    expect(new Set(names).size).toBe(SUBS.length);
    // Each matches its own sub-page and no other.
    for (const sub of SUBS) {
      const pattern = documentPattern(companySubPageUrl(target, sub), documentPatternName(sub));
      const match = pattern.match as (url: string) => boolean;
      expect(match(companySubPageUrl(target, sub)), sub).toBe(true);
      for (const other of SUBS.filter((s) => s !== sub)) {
        expect(match(companySubPageUrl(target, other)), `${sub} vs ${other}`).toBe(false);
      }
    }
  });
});

describe("awaitFirstApiResponse — a timeout is data, every other tap failure is not", () => {
  const rejecting = (err: unknown) => ({ waitFor: () => Promise.reject(err) });

  it("reports false for the tap's timeout, which is the finding (D172)", async () => {
    const timeout = new CapabilityError({
      code: "CAPTURE_TIMEOUT", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF",
      retryable: true, message: "no response matching \"linkedin-api\" was captured within 15000ms",
    });
    await expect(awaitFirstApiResponse(rejecting(timeout), { since: 0, timeoutMs: 1 })).resolves.toBe(false);
  });

  it("re-throws TAP_STOPPED and TAP_UNKNOWN_PATTERN unchanged, rather than calling the page quiet", async () => {
    for (const code of ["TAP_STOPPED", "TAP_UNKNOWN_PATTERN"]) {
      const err = new CapabilityError({
        code, exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false, message: code,
      });
      await expect(awaitFirstApiResponse(rejecting(err), { since: 0, timeoutMs: 1 })).rejects.toBe(err);
    }
  });

  it("re-throws a plain Error, which is never a measurement", async () => {
    const err = new Error("transport died");
    await expect(awaitFirstApiResponse(rejecting(err), { since: 0, timeoutMs: 1 })).rejects.toBe(err);
  });

  it("reports true when a capture arrives", async () => {
    await expect(
      awaitFirstApiResponse({ waitFor: () => Promise.resolve({}) }, { since: 0, timeoutMs: 1 }),
    ).resolves.toBe(true);
  });
});

describe("samePage", () => {
  it("ignores query, fragment, trailing slash, subdomain case and path case", () => {
    expect(samePage(`${COMPANY_URL}posts/`, "https://ca.linkedin.com/company/Acme-Robotics/Posts?trk=x#y")).toBe(true);
  });
  it("tells two different sub-pages apart", () => {
    expect(samePage(`${COMPANY_URL}posts/`, `${COMPANY_URL}people/`)).toBe(false);
  });
  it("is false rather than throwing on an unparseable url", () => {
    expect(samePage("not a url", COMPANY_URL)).toBe(false);
  });
});
