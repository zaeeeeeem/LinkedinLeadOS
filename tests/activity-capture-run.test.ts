import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capability as activityCapture } from "../src/capabilities/activity.capture/index.js";
import { VIEWPORT_EXPRESSION } from "../src/capabilities/profile.capture/read.js";
import { SNAPSHOT_EXPRESSION, isDomSnapshotEntry } from "../src/capabilities/profile.capture/snapshot.js";
import { RawArchive } from "../src/core/archive/raw.js";
import type { ReadCursor } from "../src/capabilities/profile.capture/read.js";
import { PROBE_EXPRESSION } from "../src/core/challenge/detect.js";
import type { ChallengeProbe } from "../src/core/challenge/detect.js";
import type { CdpEvent } from "../src/core/cdp/client.js";
import type { HumanCursor } from "../src/core/input/cursor.js";
import { EXIT } from "../src/core/run/receipt.js";
import { inspectLease } from "../src/core/lease/tab-lease.js";
import type { SpendRecord } from "../src/core/budget/ledger.js";
import { subCapsFor } from "../src/core/budget/constants.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute } from "../src/cli/run.js";
import type { AnyCapability, SessionLike, TabLike, UniversalFlags } from "../src/cli/types.js";
import type { TapTransport } from "../src/core/tap/network-tap.js";

// ── compile-time: this capability is the first place these modules meet ──────
// `activity.capture` is the first caller of `profile.capture`'s reader, snapshot
// and identity modules together with `core/fixtures`' activity map. A mismatch
// between any two of them would otherwise survive until the live run (m1-m3
// CONTEXT, review shape 4). Verified to fail when a member is renamed.
import { captureDomSnapshot } from "../src/capabilities/profile.capture/snapshot.js";
import type { SnapshotArchive, SnapshotTab } from "../src/capabilities/profile.capture/snapshot.js";
import { sessionUrnsOf } from "../src/capabilities/profile.capture/identity.js";
import { buildActivityDomMap } from "../src/core/fixtures/activitymap.js";
import type { ReadTab } from "../src/capabilities/profile.capture/read.js";
import type { WorkerTab } from "../src/core/session/tab.js";

const _tabReads: ReadTab = null as unknown as WorkerTab;
const _tabSnapshots: SnapshotTab = null as unknown as WorkerTab;
const _archiveTakesSnapshots: SnapshotArchive = null as unknown as RawArchive;
// The two halves of the identity check compose: whatever `sessionUrnsOf` reads
// off the tap is exactly what the activity map accepts as the session set.
const _sessionSetComposes: Parameters<typeof buildActivityDomMap>[1] = {
  sessionUrns: sessionUrnsOf([]),
};
void [_tabReads, _tabSnapshots, _archiveTakesSnapshots, _sessionSetComposes, captureDomSnapshot];

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;
const ACTIVITY_URL = "https://www.linkedin.com/in/jane-doe/recent-activity/all/";
const POST_URL = "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/";

const OPERATOR_URN = "urn:li:fsd_profile:ACoAAAoperator00000";
const SUBJECT_URN = "urn:li:fsd_profile:ACoAAAsubject000000";
const STRANGER_URN = "urn:li:fsd_profile:ACoAAAstranger00000";

/** A feed body: two posts, the second by somebody who is not the subject. */
const FEED_BODY = JSON.stringify({
  data: {
    elements: [
      { entityUrn: "urn:li:activity:7000000000000000001", actor: { urn: SUBJECT_URN } },
      { entityUrn: "urn:li:activity:7000000000000000002", actor: { urn: STRANGER_URN } },
    ],
  },
});

/** The `/voyager/api/me` body every LinkedIn page fetches — the only place the
 *  operator's own identity may come from (D133). */
const ME_BODY = JSON.stringify({ data: { entityUrn: OPERATOR_URN } });

const PREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashProfileUpdates.3a&variables=(vanity:jane-doe)";
const UNPREDICTED_GQL =
  "https://www.linkedin.com/voyager/api/graphql?queryId=voyagerFeedDashSomethingNew.9f";
const ME_URL = "https://www.linkedin.com/voyager/api/me";

/** The rendered feed, with the two things this surface is measured for: a post
 *  card bound to an activity urn, and a relative time and nothing else. */
const FEED_HTML =
  `<html><body><nav data-owner="${OPERATOR_URN}">me</nav><main id="workspace">` +
  `<div data-urn="urn:li:activity:7000000000000000001" data-actor="${SUBJECT_URN}">` +
  `<p>We are hiring.</p><span>3d</span></div>` +
  `<div data-urn="urn:li:activity:7000000000000000002" data-actor="${STRANGER_URN}">` +
  `<p>Not the subject.</p><span>2w</span></div>` +
  `</main></body></html>`;

type Response = { url: string; body: string; status?: number; failed?: boolean };

/** Emits the real CDP event sequence, session-scoped, in the real order. */
class FakePage {
  private listeners = new Set<(e: CdpEvent) => void>();
  private nextId = 1;
  responses: Response[] = [];
  navigated = false;
  slowBodies = new Set<string>();
  private bodies = new Map<string, string>();
  private urls = new Map<string, string>();

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
      this.emit(sessionId, "Network.requestWillBeSent", {
        requestId, request: { url: r.url, method: "GET" },
      });
      this.emit(sessionId, "Network.responseReceived", {
        requestId, response: { url: r.url, status: r.status ?? 200, mimeType: "application/json" },
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
  probe: Partial<ChallengeProbe> | Error = { url: ACTIVITY_URL, text: "", captcha: false };
  probeAfterRead: Partial<ChallengeProbe> | Error | null = null;
  private probeCalls = 0;
  foreground = { ok: true, via: "already" as const, hidden: false };
  /** A short, fully-visible feed by default: taller than the viewport, so the
   *  layout settles, with nothing left to scroll, so a fully-read feed is the
   *  default state and `FEED_NOT_EXHAUSTED` means something when it fires. */
  viewport: unknown = {
    width: 1440, height: 900, scrollHeight: 1000,
    innerScroller: true, scrollerHeight: 1000, documentScrollHeight: 900,
    scroller: {
      tag: "div", id: null, role: "feed", componentkey: "feed-container",
      scrollHeight: 1000, clientHeight: 1000,
    },
    scrollers: [{
      tag: "div", id: null, role: "feed", componentkey: "feed-container",
      scrollHeight: 1000, clientHeight: 1000,
    }],
    scrollerCandidates: 1,
  };
  snapshot: unknown = {
    html: FEED_HTML,
    url: ACTIVITY_URL,
    htmlChars: FEED_HTML.length,
    textChars: 12_000,
    container: {
      selector: "main#workspace", chars: 900, textChars: 9_000,
      sections: 4, sidebars: 1, sidebarsInside: 0,
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
      return { url: ACTIVITY_URL, text: "", captcha: false, ...answer } as T;
    }
    if (expression === VIEWPORT_EXPRESSION) return this.viewport as T;
    if (expression === SNAPSHOT_EXPRESSION) {
      if (this.snapshot instanceof Error) throw this.snapshot;
      return this.snapshot as T;
    }
    return "complete" as T;
  }
  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
    this.page.navigated = true;
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
        if (url !== undefined && this.page.slowBodies.has(url)) await new Promise((r) => setTimeout(r, 60));
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
  dir = mkdtempSync(join(tmpdir(), "activity-capture-"));
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
    { url: PREDICTED_GQL, body: FEED_BODY },
    { url: ME_URL, body: ME_BODY },
  ];
  o.tune?.(session);
  const cursor = fakeCursor();
  return {
    session,
    cursor,
    outcome: execute({
      def: activityCapture as unknown as AnyCapability,
      rawArgs: { url: ACTIVITY_URL, scrolls: 2, layoutTimeoutMs: 50, ...o.args },
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

type ProbeData = {
  target: { surface: string; url: string; ref: string };
  probe: {
    session_urns_known: number;
    bodies_inventoried: number;
    bodies_not_inventoried: number;
    body_urns_distinct: Record<string, number>;
    body_session_urn_hits: number;
    dom: null | {
      card_ref_scope_resolved: boolean;
      urn_attributes: Array<{ attribute: string; family: string; elements: number; session_owned: number }>;
      time_leaves: number;
      time_leaves_absolute: number;
      time_leaves_bound_to_a_urn: number;
      session_urns_present: number;
    };
  };
  capture: { activity_ish: number; unmatched_activity_ish: number };
  reading: { scrolled_px: number; scrollable_px: number | null; viewport: Record<string, unknown> };
};

// ─────────────────────────────────────────────────────────────────────────────

describe("activity.capture — the happy path", () => {
  it("opens the activity page itself, archives bodies and the snapshot, and tears down", async () => {
    const { outcome, session } = invoke({});
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;

    // The url this capability exists for — not the profile it collapses to.
    expect(session.tab.navigated).toEqual([ACTIVITY_URL]);
    expect(receipt.counts.captured).toBe(2);
    expect(receipt.counts.usable).toBe(1);

    const files = await archived(receipt.run_id);
    expect(files.network).toHaveLength(2);
    expect(files.snapshots).toHaveLength(1);

    expect(session.closed).toBe(true);
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("spends one page load and one profile open, on profile.capture's own dedupe key", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");

    const spends = ledgerLines();
    expect(spends.map((s) => s.kind).sort()).toEqual(["page_load", "profile_open"]);
    // The same ref `profile.capture` uses, so opening someone's activity after
    // their profile on one day is one distinct person, not two (D223).
    expect(spends.find((s) => s.kind === "profile_open")!.ref).toBe("in:jane-doe");
    expect(spends.every((s) => s.capability === "activity.capture")).toBe(true);
  });

  it("does not spend a profile open on a post permalink", async () => {
    const { outcome } = invoke({ args: { url: POST_URL } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");

    // A permalink is a post, not a person: charging the day's distinct-person
    // budget for it would ration the wrong thing (D222).
    expect(ledgerLines().map((s) => s.kind)).toEqual(["page_load"]);
    expect((receipt.data as ProbeData).target.surface).toBe("post");
  });

  it("is capped by its own daily sub-cap rather than by omission", async () => {
    // A probe that could spend a working reader's budget is the failure D153
    // exists to prevent, so the entry is asserted rather than assumed.
    const caps = subCapsFor("activity.capture");
    expect(caps.searchPagesPerDay).toBe(0);
    expect(caps.pageLoadsPerDay).toBeLessThan(subCapsFor("profile.capture").pageLoadsPerDay);
  });

  it("names the promotion step, with the activity surface, as the next command", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.next).toContain("fixtures:promote");
    expect(receipt.next).toContain("--surface=activity");
    expect(receipt.next).toContain(receipt.run_id);
  });
});

describe("activity.capture — what it measured", () => {
  it("counts a feed body as relevant and the /me body as not", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as ProbeData;

    // `isProfileIsh` would call both relevant — every post names its author —
    // and the pattern-vs-reality answer would be the same on every run.
    expect(data.capture.activity_ish).toBe(1);
    expect(data.probe.bodies_inventoried).toBe(1);
    expect(data.probe.bodies_not_inventoried).toBe(0);
    expect(data.probe.body_urns_distinct["activity"]).toBe(2);
    expect(data.probe.body_urns_distinct["person"]).toBe(2);
  });

  it("reports which element scrolls, so a new surface's scroller is measured not assumed", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const viewport = (receipt.data as ProbeData).reading.viewport;
    expect(viewport["scroller"]).toMatchObject({ role: "feed", componentkey: "feed-container" });
    expect(viewport["scrollerCandidates"]).toBe(1);
  });

  it("reports the DOM's post-card markers, its times, and how many bind to a post", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const dom = (receipt.data as ProbeData).probe.dom!;

    expect(dom.urn_attributes.map((a) => a.attribute).sort()).toEqual(["data-actor", "data-owner", "data-urn"]);
    expect(dom.card_ref_scope_resolved).toBe(false);
    expect(dom.time_leaves).toBe(2);
    expect(dom.time_leaves_absolute).toBe(0);
    expect(dom.time_leaves_bound_to_a_urn).toBe(2);
  });

  it("warns that only relative times are rendered, instead of leaving posted_at to be invented", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const warning = receipt.warnings.find((w) => w.code === "POSTED_AT_RELATIVE_ONLY");
    expect(warning?.n).toBe(2);
  });

  it("does not warn when the page does render an absolute time", async () => {
    const html = `<html><body><main id="workspace"><div data-urn="urn:li:activity:1">` +
      `<time>2026-08-09T12:00:00Z</time></div></main></body></html>`;
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.snapshot = {
          html, url: ACTIVITY_URL, htmlChars: html.length, textChars: 900,
          container: { selector: "main#workspace", chars: 400, textChars: 800, sections: 1, sidebars: 0, sidebarsInside: 0 },
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).not.toContain("POSTED_AT_RELATIVE_ONLY");
    expect((receipt.data as ProbeData).probe.dom!.time_leaves_absolute).toBe(1);
  });

  it("puts no captured urn, name or post text on the receipt", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const json = JSON.stringify(receipt);
    for (const urn of [SUBJECT_URN, STRANGER_URN, OPERATOR_URN]) expect(json).not.toContain(urn);
    expect(json).not.toContain("We are hiring");
    // The query string carries `variables=(vanity:jane-doe)` and must not ride
    // along on the endpoint table either.
    expect(json).not.toContain("variables=");
  });
});

describe("activity.capture — the session-identity trap", () => {
  it("counts the operator's own urns rather than trusting the page", async () => {
    const bodyWithOperator = JSON.stringify({
      data: { elements: [{ entityUrn: "urn:li:activity:1", actor: { urn: OPERATOR_URN } }] },
    });
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: bodyWithOperator }, { url: ME_URL, body: ME_BODY }],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as ProbeData;

    expect(data.probe.session_urns_known).toBe(1);
    // The D119/D126 trap, found in a fourth place if it is ever there.
    expect(data.probe.body_session_urn_hits).toBe(1);
  });

  it("warns when there is no session identity to check against at all", async () => {
    // Without `/voyager/api/me` the subject-vs-stranger check cannot be made,
    // and a probe that cannot make it must say so rather than report a clean
    // sweep (D131, one surface on).
    const { outcome } = invoke({ responses: [{ url: PREDICTED_GQL, body: FEED_BODY }] });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("SESSION_IDENTITY_UNAVAILABLE");
    expect((receipt.data as ProbeData).probe.session_urns_known).toBe(0);
  });

  it("does not warn when the session identity was captured", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).not.toContain("SESSION_IDENTITY_UNAVAILABLE");
  });
});

describe("activity.capture — patterns, misses and silent loss", () => {
  it("warns when an activity payload arrives on an endpoint nobody predicted", async () => {
    const { outcome } = invoke({
      responses: [{ url: UNPREDICTED_GQL, body: FEED_BODY }, { url: ME_URL, body: ME_BODY }],
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PATTERN_MISMATCH");
    expect((receipt.data as ProbeData).capture.unmatched_activity_ish).toBe(1);
    // Archived anyway: the finding is a report, not a failure.
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("warns loudly when nothing carrying activity data arrived", async () => {
    const { outcome } = invoke({ responses: [{ url: ME_URL, body: ME_BODY }] });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.usable).toBe(0);
    expect(receipt.warnings.map((w) => w.code)).toContain("NO_ACTIVITY_PAYLOAD");
  });

  it("reports a lost body as a miss rather than as a clean zero", async () => {
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: FEED_BODY },
        { url: UNPREDICTED_GQL, body: "{}", failed: true },
      ],
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.counts.skipped).toBe(1);
    expect(receipt.warnings.map((w) => w.code)).toContain("CAPTURE_MISSES");
  });

  it("says when the feed was only read part of the way down", async () => {
    // A short capture and a short feed must not produce the same receipt: the
    // number of posts would otherwise describe the scroll, not the person.
    const { outcome } = invoke({
      args: { scrolls: 1 },
      tune: (s) => {
        s.tab.viewport = {
          width: 1440, height: 900, scrollHeight: 40_000,
          innerScroller: true, scrollerHeight: 900, documentScrollHeight: 900,
          scroller: { tag: "div", id: null, role: "feed", componentkey: null, scrollHeight: 40_000, clientHeight: 900 },
          scrollers: [], scrollerCandidates: 1,
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const data = receipt.data as ProbeData;
    const warning = receipt.warnings.find((w) => w.code === "FEED_NOT_EXHAUSTED")!;
    expect(warning).toBeDefined();
    expect(warning.n).toBe(data.reading.scrollable_px! - data.reading.scrolled_px);
  });

  it("does not raise it on a feed that was read to the bottom", async () => {
    const { outcome } = invoke({});
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).not.toContain("FEED_NOT_EXHAUSTED");
  });

  it("warns when the page never laid out", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.viewport = {
          width: 1440, height: 900, scrollHeight: 900,
          innerScroller: false, scrollerHeight: 900, documentScrollHeight: 900,
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("PAGE_NOT_LAID_OUT");
  });
});

describe("activity.capture — the snapshot", () => {
  it("warns and reports no dom measurement when the page will not answer", async () => {
    const { outcome } = invoke({ tune: (s) => { s.tab.snapshot = new Error("detached"); } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    if (!receipt.ok) throw new Error("expected ok");
    expect(receipt.warnings.map((w) => w.code)).toContain("DOM_SNAPSHOT_FAILED");
    expect((receipt.data as ProbeData).probe.dom).toBeNull();
    // The network bodies are still on disk: the page load is already spent.
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("warns when the container is a shell, and does not call it a fixture", async () => {
    const { outcome } = invoke({
      tune: (s) => {
        s.tab.snapshot = {
          html: "<html><body><main id='workspace'></main></body></html>",
          url: ACTIVITY_URL, htmlChars: 60, textChars: 10,
          container: { selector: "main#workspace", chars: 40, textChars: 3, sections: 0, sidebars: 0, sidebarsInside: 0 },
        };
      },
    });
    const { receipt } = await outcome;
    if (!receipt.ok) throw new Error("expected ok");
    const warning = receipt.warnings.find((w) => w.code === "ACTIVITY_CONTAINER_NOT_RENDERED");
    expect(warning?.field).toContain("not a fixture");
  });
});

describe("activity.capture — the gates", () => {
  it("halts on a challenge after navigation, exit 2, lease released", async () => {
    const { outcome, session } = invoke({
      tune: (s) => {
        s.tab.probe = { url: "https://www.linkedin.com/checkpoint/challenge/", text: "", captcha: true };
      },
    });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.CHALLENGE);
    if (receipt.ok) throw new Error("expected a halt");
    expect(receipt.error.code).toBe("CHALLENGE_CAPTCHA");
    expect(session.tab.shots).toHaveLength(1);
    expect(existsSync(join(paths.runsDir, receipt.run_id, "checkpoint.json"))).toBe(true);
    expect(session.tab.closed).toBe(true);
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });

  it("archives a body still on the wire when the run halts", async () => {
    // The property `finally { drain() }` exists for. Without it, teardown stops
    // the tap and a body it already fetched is dropped — a spent page load with
    // an incomplete archive (D2).
    const { outcome } = invoke({
      responses: [
        { url: PREDICTED_GQL, body: FEED_BODY },
        { url: UNPREDICTED_GQL, body: FEED_BODY },
      ],
      tune: (s) => {
        s.page.slowBodies.add(UNPREDICTED_GQL);
        s.tab.probeAfterRead = {
          url: ACTIVITY_URL,
          text: "we noticed unusual activity from your account",
          captcha: false,
        };
      },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.CHALLENGE);
    if (receipt.ok) throw new Error("expected a halt");
    expect((await archived(receipt.run_id)).network).toHaveLength(2);
  });

  it("halts on an http 429 in a captured response, exit 3 and retryable", async () => {
    const { outcome } = invoke({
      responses: [{ url: PREDICTED_GQL, body: FEED_BODY, status: 429 }],
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.RATE_LIMITED);
    if (receipt.ok) throw new Error("expected a halt");
    expect(receipt.error.retryable).toBe(true);
  });

  it("refuses an unmeasured tab before opening or spending anything", async () => {
    const { outcome, session } = invoke({
      args: { url: "https://www.linkedin.com/in/jane-doe/recent-activity/documents/" },
    });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.GENERIC);
    if (receipt.ok) throw new Error("expected a refusal");
    expect(receipt.error.code).toBe("ACTIVITY_URL_INVALID");
    expect(session.tab.navigated).toEqual([]);
    expect(ledgerLines()).toEqual([]);
    // Released on the refusing path too.
    expect((await inspectLease(paths.leasePath)).state).toBe("free");
  });
});
