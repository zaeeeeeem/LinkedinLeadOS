import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createProfileGetCapability,
  type ProfileGetDeps,
} from "../src/capabilities/profile.get/index.js";
import type { CapabilityContext } from "../src/cli/types.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute } from "../src/cli/run.js";
import type { AnyCapability, SessionLike, TabLike } from "../src/cli/types.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import type { StoreClient } from "../src/core/store/client.js";
import type { StoredPerson } from "../src/core/store/types.js";
import type { TapTransport } from "../src/core/tap/network-tap.js";
import type { Navigation } from "../src/core/session/tab.js";
import { DOM_SNAPSHOT_PATTERN, domSnapshotUrl } from "../src/capabilities/profile.capture/snapshot.js";

const FUTURE_COOKIE = Math.floor(Date.now() / 1000) + 86_400;
const PROFILE_URL = "https://www.linkedin.com/in/subject-slug/";
const SUBJECT_ID = "ACsubject0123456789abcdefghijk";
const SUBJECT_URN = `urn:li:fsd_profile:${SUBJECT_ID}`;
const SESSION_URN = "urn:li:fsd_profile:ACsession0123456789abcdefgh";
const CARD_REF = "com.linkedin.sdui.profile.card.ref";

function card(name: string, body: string): string {
  return `<section componentkey="${CARD_REF}${SUBJECT_ID}${name}">${body}</section>`;
}

function snapshot(headline = "Subject headline"): string {
  return `<html><body><main>${card("Topcard", `
    <div componentkey="ProfileVerificationTriggerRef-subject-slug"><h2>Subject Name</h2></div>
    ${headline === "" ? "" : `<p>${headline}</p>`}
    <p>Current Company · School</p><p>Lahore, Punjab, Pakistan</p>
  `)}${card("ExperienceTopLevelSection", `
    <div componentkey="entity-collection-item-one"><a href="/company/123/">
      <p>Founder</p><p>Example · Full-time</p><p>Jan 2020 - Present</p>
    </a></div>
  `)}${card("About", "<p>About</p>")}</main></body></html>`;
}

class FakeTab implements TabLike {
  readonly targetId = "target";
  readonly sessionId = "session";
  navigated: string[] = [];
  async send<T>(): Promise<T> { return {} as T; }
  async evaluate<T>(): Promise<T> { return "complete" as T; }
  async navigate(url: string): Promise<Navigation> {
    this.navigated.push(url);
    return { settledOn: "complete", readyState: "complete", waitedMs: 0 };
  }
  async currentUrl(): Promise<string> { return this.navigated.at(-1) ?? "about:blank"; }
  async screenshot(path: string): Promise<string> { writeFileSync(path, "png"); return path; }
  async foregroundState() { return { hidden: false, focused: true, visibility: "visible" }; }
  async ensureForeground() { return { ok: true, via: "already" as const, state: await this.foregroundState() }; }
  async close(): Promise<void> {}
}

class FakeSession implements SessionLike {
  readonly endpoint = { port: 9223, wsUrl: "ws://fake", launched: false };
  readonly tab = new FakeTab();
  readonly client: TapTransport = {
    send: async <T,>(method: string): Promise<T> => method === "Storage.getCookies"
      ? { cookies: [{ name: "li_at", domain: ".linkedin.com", expires: FUTURE_COOKIE }] } as T
      : {} as T,
    on: () => () => {},
  };
  async openWorkerTab(): Promise<TabLike> { return this.tab; }
  async close(): Promise<void> {}
}

const client = {} as StoreClient;
const fresh: StoredPerson = {
  person: {
    urn: SUBJECT_URN,
    vanity: "subject-slug",
    name: "Subject Name",
    headline: "Cached",
    location: "Lahore",
    current_company_urn: null,
    first_seen: new Date().toISOString(),
    last_seen: new Date().toISOString(),
  },
  experience: [],
  vanityMatches: 1,
};

let root: string;
let paths: { runsDir: string; leasePath: string; budgetPath: string };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "profile-get-"));
  paths = {
    runsDir: join(root, "runs"),
    leasePath: join(root, "runs", "tab.lock"),
    budgetPath: join(root, "runs", "budget.ndjson"),
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function dependencies(o: {
  cached?: StoredPerson | null;
  html?: string;
  driftError?: CapabilityError;
  noSnapshot?: boolean;
  sessionUrns?: string[];
} = {}) {
  const capture = vi.fn(async (ctx: CapabilityContext<Record<string, unknown>, true>) => {
    await ctx.budget.spend({ kind: "page_load", n: 1 });
    await ctx.budget.spend({ kind: "profile_open", ref: "in:subject-slug" });
    const archived = await ctx.browser.archive.archive({
      body: o.html ?? snapshot(),
      url: domSnapshotUrl(PROFILE_URL),
      status: 0,
      method: "DOM",
      pattern: DOM_SNAPSHOT_PATTERN,
      contentType: "text/html",
    });
    return {
      sessionUrns: o.sessionUrns ?? [SESSION_URN],
      result: {
        counts: { requested: 1, captured: 4, usable: 2, skipped: 0 },
        warnings: [{ code: "CAPTURE_NOTE", field: "fixture", n: 1 }],
        data: {
          target: { kind: "profile", url: PROFILE_URL, ref: "in:subject-slug", vanity: "subject-slug" },
          snapshot: {
            archived: o.noSnapshot ? null : archived.file,
            bytes: archived.bytes,
            rendered: true,
            failure: o.noSnapshot ? "archive-failed" : null,
          },
          capture: { captured: 4, misses: 0 },
        },
      },
    };
  });
  const deps: ProfileGetDeps = {
    storeConfigured: () => true,
    store: () => client,
    findByUrn: vi.fn(async () => null),
    findByVanity: vi.fn(async () => o.cached ?? null),
    upsert: vi.fn(async () => ({
      urn: SUBJECT_URN,
      rows: 2,
      experience: { upserted: 1, removed: 0 },
    })),
    recordDrift: vi.fn(async (warnings) => {
      if (o.driftError) throw o.driftError;
      return warnings.length;
    }),
    capture: capture as ProfileGetDeps["capture"],
  };
  return { deps, capture };
}

function invoke(deps: ProfileGetDeps, flags = DEFAULT_FLAGS) {
  const session = new FakeSession();
  return {
    session,
    outcome: execute({
      def: createProfileGetCapability(deps) as unknown as AnyCapability,
      rawArgs: { url: PROFILE_URL, maxAge: "7d" },
      flags,
      ...paths,
      deps: { openSession: async () => session },
    }),
  };
}

describe("profile.get", () => {
  it("returns a fresh unambiguous cached person without capture or budget spend", async () => {
    const { deps, capture } = dependencies({ cached: fresh });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(capture).not.toHaveBeenCalled();
    expect(receipt.cost.page_loads).toBe(0);
    expect(receipt.counts).toEqual({ requested: 1, captured: 0, usable: 1, skipped: 0 });
    expect(receipt.data).toMatchObject({ from_cache: true, source: { identity: "store", content: "store" } });
    expect(receipt.next).toBe("select * from persons where vanity = 'subject-slug' order by last_seen desc limit 2");
  });

  it("does not serve an ambiguous vanity cache hit as identity", async () => {
    const { deps, capture } = dependencies({
      cached: { ...fresh, vanityMatches: 2 },
    });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    expect(capture).toHaveBeenCalledOnce();
    if (receipt.ok) expect(receipt.data).toMatchObject({ from_cache: false });
  });

  it("reuses capture, parses the archived snapshot, stores person plus experience, and reports one DOM source", async () => {
    const { deps, capture } = dependencies();
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(capture).toHaveBeenCalledOnce();
    expect(deps.upsert).toHaveBeenCalledWith(expect.objectContaining({
      person: expect.objectContaining({ urn: SUBJECT_URN, headline: "Subject headline" }),
      experience: [expect.objectContaining({ title: "Founder", company_urn: "urn:li:fsd_company:123" })],
    }), client);
    expect(receipt.cost.page_loads).toBe(1);
    expect(receipt.counts).toEqual({ requested: 1, captured: 4, usable: 1, skipped: 0 });
    expect(receipt.stored).toEqual({ table: "persons", run_ref: receipt.run_id, rows: 2 });
    expect(receipt.data).toMatchObject({
      from_cache: false,
      source: { identity: "dom-snapshot", content: "dom-snapshot" },
      storage: { person_rows: 1, experience_rows: 1, drift_rows: 0 },
    });
    expect(JSON.stringify(receipt.data)).not.toContain(SUBJECT_URN);
  });

  it("logs and stores non-fatal parser warnings while keeping the receipt ok", async () => {
    const { deps } = dependencies({ html: snapshot("") });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.warnings).toContainEqual(expect.objectContaining({ code: "PARSE_FIELD_MISSING", field: "headline" }));
    expect(deps.recordDrift).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ field: "headline" })]),
      expect.objectContaining({ client, shapeHash: expect.any(String) }),
    );
  });

  it("maps an untrusted snapshot identity to exit 5 with the archived snapshot as evidence", async () => {
    const { deps } = dependencies({ html: "<html><body><main><h2>No card refs</h2></main></body></html>" });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.PARSE_DRIFT);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("PROFILE_IDENTITY_UNRESOLVED");
    expect(receipt.error.evidence).toMatch(/raw\/\d{4}-.*\.json\.gz$/);
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("maps a snapshot that resolves to the session account to its distinct exit-5 code", async () => {
    const { deps } = dependencies({ sessionUrns: [SUBJECT_URN] });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.PARSE_DRIFT);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("PROFILE_IDENTITY_IS_SESSION");
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("maps a lost DOM snapshot to exit 5 and points at the raw archive", async () => {
    const { deps } = dependencies({ noSnapshot: true });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.PARSE_DRIFT);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) {
      expect(receipt.error.code).toBe("PROFILE_SNAPSHOT_UNAVAILABLE");
      expect(receipt.error.evidence).toMatch(/raw\/$/);
    }
    expect(deps.upsert).not.toHaveBeenCalled();
  });

  it("reports primary rows already stored when drift persistence fails afterwards", async () => {
    const driftError = new CapabilityError({
      code: "STORE_UNAVAILABLE", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF",
      retryable: true, message: "drift table unavailable",
    });
    const { deps } = dependencies({ html: snapshot(""), driftError });
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.TRANSIENT);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.partial).toEqual({ stored: 2 });
  });

  it("keeps archive and parsing active under --no-store and performs no database write", async () => {
    const { deps, capture } = dependencies();
    deps.storeConfigured = () => false;
    deps.store = vi.fn(() => { throw new Error("no store"); });
    const flags = { ...DEFAULT_FLAGS, noStore: true };
    const { receipt, exit } = await invoke(deps, flags).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(capture).toHaveBeenCalledOnce();
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(deps.recordDrift).not.toHaveBeenCalled();
    expect(receipt.stored).toBeUndefined();
    expect(receipt.data).toMatchObject({ storage: { skipped: true, reason: "--no-store" } });
  });

  it("refuses an unconfigured required store before capture spends a page load", async () => {
    const { deps, capture } = dependencies();
    deps.storeConfigured = () => false;
    deps.store = () => {
      throw new CapabilityError({
        code: "STORE_NOT_CONFIGURED", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
        retryable: false, message: "configure the store",
      });
    };
    const { receipt, exit } = await invoke(deps).outcome;
    expect(exit).toBe(EXIT.GENERIC);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("STORE_NOT_CONFIGURED");
    expect(capture).not.toHaveBeenCalled();
    expect(receipt.cost.page_loads).toBe(0);
  });
});
