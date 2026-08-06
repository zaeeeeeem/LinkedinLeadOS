import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import { CdpClient } from "../src/core/cdp/client.js";
import { HumanCursor, type InputTarget } from "../src/core/input/cursor.js";
import { inspectLease } from "../src/core/lease/tab-lease.js";
import { RunContext } from "../src/core/run/context.js";
import { CapabilityError, EXIT, type ExitCode } from "../src/core/run/receipt.js";
import { StoreWriteError } from "../src/core/store/persons.js";
import { BrowserSession } from "../src/core/session/session.js";
import { WorkerTab } from "../src/core/session/tab.js";
import type { TapTransport } from "../src/core/tap/network-tap.js";
import { checkLogin, type CookieReader, type EventSink } from "../src/cli/preflight.js";
import { DEFAULT_FLAGS } from "../src/cli/flags.js";
import { execute, project, NO_RUN } from "../src/cli/run.js";
import { defineCapability, type AnyCapability, type SessionLike, type TabLike, type UniversalFlags } from "../src/cli/types.js";

const run = promisify(execFile);

// ── composition, at compile time ─────────────────────────────────────────────
// This task is the first place these modules meet in one file. A structural
// mismatch between any two of them is invisible until something needs both, so
// each pairing is asserted here rather than discovered later (CONTEXT §4).
const _tabIsTabLike: TabLike = null as unknown as WorkerTab;
const _sessionIsSessionLike: SessionLike = null as unknown as BrowserSession;
const _clientIsTapTransport: TapTransport = null as unknown as CdpClient;
const _clientReadsCookies: CookieReader = null as unknown as CdpClient;
const _tabDrivesCursor: InputTarget = null as unknown as WorkerTab;
const _runIsEventSink: EventSink = null as unknown as RunContext;
void [_tabIsTabLike, _sessionIsSessionLike, _clientIsTapTransport, _clientReadsCookies, _tabDrivesCursor, _runIsEventSink];

// ── fakes: only Chrome is faked; lease, budget, run context, tap, cursor and
//    archive are the real modules, over temp paths ─────────────────────────────

const FUTURE = Math.floor(Date.now() / 1000) + 86_400;

class FakeTab implements TabLike {
  readonly targetId = "target-1";
  readonly sessionId = "session-1";
  closed = false;
  navigated: string[] = [];
  readonly sent: string[] = [];

  async send<T>(method: string): Promise<T> {
    this.sent.push(method);
    return {} as T;
  }
  async evaluate<T>(): Promise<T> {
    return "complete" as T;
  }
  async navigate(url: string): Promise<void> {
    this.navigated.push(url);
  }
  async currentUrl(): Promise<string> {
    return this.navigated.at(-1) ?? "about:blank";
  }
  async screenshot(path: string): Promise<string> {
    writeFileSync(path, "png");
    return path;
  }
  async foregroundState() {
    return { hidden: false, focused: true, visibility: "visible" };
  }
  async ensureForeground() {
    return { ok: true, via: "already" as const, state: await this.foregroundState() };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSession implements SessionLike {
  readonly endpoint = { port: 9223, wsUrl: "ws://127.0.0.1:9223/devtools/browser/fake", launched: true };
  readonly tab = new FakeTab();
  closed = false;
  tabsOpened = 0;
  cookies: { name: string; domain: string; expires?: number; session?: boolean }[] = [
    { name: "li_at", domain: ".www.linkedin.com", expires: FUTURE },
    { name: "sessionid", domain: ".example.com", expires: FUTURE },
  ];
  cookieError: Error | null = null;

  readonly client: TapTransport = {
    send: async <T,>(method: string): Promise<T> => {
      if (method === "Storage.getCookies") {
        if (this.cookieError) throw this.cookieError;
        return { cookies: this.cookies } as T;
      }
      if (method === "Browser.getVersion") {
        return { product: "Chrome/151.0.7922.76", protocolVersion: "1.3" } as T;
      }
      return {} as T;
    },
    on: () => () => {},
  };

  async openWorkerTab(): Promise<TabLike> {
    this.tabsOpened += 1;
    return this.tab;
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tab.close();
  }
}

let dir: string;
let paths: { runsDir: string; leasePath: string; budgetPath: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-run-"));
  paths = {
    runsDir: join(dir, "runs"),
    leasePath: join(dir, "runs", "tab.lock"),
    budgetPath: join(dir, "runs", "budget.ndjson"),
  };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function invoke(o: {
  def: AnyCapability;
  args?: Record<string, unknown>;
  flags?: Partial<UniversalFlags>;
  session?: FakeSession;
  openSession?: () => Promise<SessionLike>;
}) {
  const session = o.session ?? new FakeSession();
  const openSession = o.openSession ?? (async () => session);
  const opened = vi.fn(openSession);
  return {
    session,
    opened,
    outcome: execute({
      def: o.def,
      rawArgs: o.args ?? {},
      flags: { ...DEFAULT_FLAGS, ...o.flags },
      ...paths,
      deps: { openSession: opened },
    }),
  };
}

const okCapability = (over: Partial<AnyCapability> = {}): AnyCapability =>
  ({
    name: "test.ok",
    risk: "local",
    summary: "a test capability",
    args: z.object({ note: z.string().optional() }).strict(),
    needsBrowser: true,
    needsAuth: false,
    cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
    run: async () => ({ counts: { usable: 1 }, data: { a: 1, b: 2 } }),
    ...over,
  }) as AnyCapability;

// ─────────────────────────────────────────────────────────────────────────────

describe("args validation happens before anything runs", () => {
  it("rejects an unknown argument with exit 1, without opening a run or a browser", async () => {
    const { outcome, opened } = invoke({ def: okCapability(), args: { nope: "x" } });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.GENERIC);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("ARGS_INVALID");
    expect(receipt.run_id).toBe(NO_RUN);
    expect(opened).not.toHaveBeenCalled();
    expect(existsSync(paths.runsDir)).toBe(false);
  });
});

describe("dry run", () => {
  it("returns a plan and an estimate and makes zero browser calls", async () => {
    const def = okCapability({
      cost: () => ({ page_loads: 4, search_pages: 1, profile_opens: 0 }),
      run: async () => {
        throw new Error("a dry run must never reach the capability body");
      },
    });
    const { outcome, opened, session } = invoke({ def, flags: { dryRun: true } });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(opened).not.toHaveBeenCalled();
    expect(session.tabsOpened).toBe(0);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const data = receipt.data as { dry_run: boolean; estimate: unknown; budget: { ok: boolean }; lease: unknown };
    expect(data.dry_run).toBe(true);
    expect(data.estimate).toEqual({ page_loads: 4, search_pages: 1, profile_opens: 0 });
    expect(data.budget.ok).toBe(true);
    expect(data.lease).toEqual({ state: "free" });
    expect(receipt.cost.page_loads).toBe(0);
    // No lease is taken by a plan, so a dry run never blocks a real one.
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("reports a budget that would refuse the estimate instead of pretending", async () => {
    const def = okCapability({ cost: () => ({ page_loads: 10_000, search_pages: 0, profile_opens: 0 }) });
    const { receipt } = await invoke({ def, flags: { dryRun: true } }).outcome;
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.warnings.map((w) => w.code)).toContain("BUDGET_WOULD_EXCEED");
    expect((receipt.data as { budget: { ok: boolean } }).budget.ok).toBe(false);
  });
});

describe("the happy path", () => {
  it("runs, receipts, and leaves nothing behind", async () => {
    const { outcome, session } = invoke({ def: okCapability() });
    const { receipt, exit } = await outcome;

    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    expect(receipt.capability).toBe("test.ok");
    expect(receipt.counts).toEqual({ requested: 0, captured: 0, usable: 1, skipped: 0 });
    expect(session.tabsOpened).toBe(1);
    expect(session.closed).toBe(true);
    expect(session.tab.closed).toBe(true);
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
    // summary.json is the persisted receipt (§5).
    const summary = JSON.parse(readFileSync(join(paths.runsDir, receipt.run_id, "summary.json"), "utf8"));
    expect(summary.run_id).toBe(receipt.run_id);
  });

  it("projects the receipt's data down to --fields", async () => {
    const { receipt } = await invoke({ def: okCapability(), flags: { fields: ["a"] } }).outcome;
    expect(receipt.ok && receipt.data).toEqual({ a: 1 });
  });

  it("resumes an existing run id instead of minting a new one", async () => {
    const first = await invoke({ def: okCapability() }).outcome;
    const second = await invoke({ def: okCapability(), flags: { runId: first.receipt.run_id } }).outcome;
    expect(second.receipt.run_id).toBe(first.receipt.run_id);
    const meta = JSON.parse(readFileSync(join(paths.runsDir, first.receipt.run_id, "run.json"), "utf8"));
    expect(meta.resumed_at).toHaveLength(1);
  });
});

describe("failure classes reach the exit code their receipt names", () => {
  const classes: { code: string; exit: ExitCode; action: "HALT_AND_NOTIFY" | "RETRY_BACKOFF" | "REAUTH"; retryable: boolean }[] = [
    { code: "CHALLENGE_CAPTCHA", exit: EXIT.CHALLENGE, action: "HALT_AND_NOTIFY", retryable: false },
    { code: "RATE_LIMITED", exit: EXIT.RATE_LIMITED, action: "RETRY_BACKOFF", retryable: true },
    { code: "SESSION_DEAD", exit: EXIT.AUTH, action: "REAUTH", retryable: false },
    { code: "PARSE_DRIFT", exit: EXIT.PARSE_DRIFT, action: "HALT_AND_NOTIFY", retryable: false },
    { code: "CDP_SOCKET_ERROR", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true },
    { code: "BUDGET_EXCEEDED", exit: EXIT.BUDGET, action: "HALT_AND_NOTIFY", retryable: false },
  ];

  for (const cls of classes) {
    it(`${cls.code} → exit ${cls.exit}, lease released, tab closed`, async () => {
      const def = okCapability({
        run: async () => {
          throw new CapabilityError({ ...cls, message: `${cls.code} from a capability` });
        },
      });
      const { outcome, session } = invoke({ def });
      const { receipt, exit } = await outcome;

      expect(exit).toBe(cls.exit);
      expect(receipt.ok).toBe(false);
      if (receipt.ok) return;
      expect(receipt.error.code).toBe(cls.code);
      expect(receipt.error.exit).toBe(cls.exit);
      expect(receipt.error.retryable).toBe(cls.retryable);
      // The thing this whole gate is about: a capability that threw mid-run
      // still gives the tab back.
      expect(session.closed).toBe(true);
      expect(session.tab.closed).toBe(true);
      expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
    });
  }

  it("an unclassified throw becomes exit 1, and still releases everything", async () => {
    const def = okCapability({
      run: async () => {
        throw new TypeError("undefined is not a function");
      },
    });
    const { outcome, session } = invoke({ def });
    const { receipt, exit } = await outcome;
    expect(exit).toBe(EXIT.GENERIC);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("CAPABILITY_FAILED");
    expect(receipt.error.message).toContain("undefined is not a function");
    expect(session.closed).toBe(true);
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("logs an error event for the failure it reports", async () => {
    const def = okCapability({
      run: async () => {
        throw new CapabilityError({
          code: "RATE_LIMITED", exit: EXIT.RATE_LIMITED, action: "RETRY_BACKOFF",
          retryable: true, message: "slow down",
        });
      },
    });
    const { receipt } = await invoke({ def }).outcome;
    const events = readFileSync(join(paths.runsDir, receipt.run_id, "events.ndjson"), "utf8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(events.some((e) => e.event === "error" && e.detail.code === "RATE_LIMITED")).toBe(true);
  });

  it("puts a store writer's exact partial row count on the failure receipt", async () => {
    const def = okCapability({
      run: async () => {
        throw new StoreWriteError(new CapabilityError({
          code: "STORE_UNAVAILABLE", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF",
          retryable: true, message: "store stopped after the experience write",
        }), 2);
      },
    });
    const { receipt, exit } = await invoke({ def }).outcome;
    expect(exit).toBe(EXIT.TRANSIENT);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.partial).toEqual({ stored: 2 });
  });
});

describe("preflight order (§8)", () => {
  it("stops at the login check with exit 4, before taking the lease or a tab", async () => {
    const session = new FakeSession();
    session.cookies = [{ name: "sessionid", domain: ".example.com", expires: FUTURE }];
    const def = okCapability({ needsAuth: true, run: async () => { throw new Error("must not run"); } });
    const { receipt, exit } = await invoke({ def, session }).outcome;

    expect(exit).toBe(EXIT.AUTH);
    expect(receipt.ok).toBe(false);
    if (receipt.ok) return;
    expect(receipt.error.code).toBe("SESSION_NOT_LOGGED_IN");
    expect(receipt.error.action).toBe("REAUTH");
    expect(session.tabsOpened).toBe(0);
    expect(session.closed).toBe(true);
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("does not prescribe a re-login when the probe itself failed — that is transient", async () => {
    const session = new FakeSession();
    session.cookieError = new Error("socket hung up");
    const def = okCapability({ needsAuth: true });
    const { receipt, exit } = await invoke({ def, session }).outcome;
    expect(exit).toBe(EXIT.TRANSIENT);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("LOGIN_PROBE_FAILED");
  });

  it("stops at the budget with exit 7, before taking the lease or a tab", async () => {
    const session = new FakeSession();
    const def = okCapability({
      cost: () => ({ page_loads: 10_000, search_pages: 0, profile_opens: 0 }),
      run: async () => { throw new Error("must not run"); },
    });
    const { receipt, exit } = await invoke({ def, session }).outcome;

    expect(exit).toBe(EXIT.BUDGET);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("BUDGET_EXCEEDED");
    expect(session.tabsOpened).toBe(0);
    expect(session.closed).toBe(true);
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("refuses a lease another live run holds, with exit 6 and no tab", async () => {
    const session = new FakeSession();
    mkdirSync(paths.runsDir, { recursive: true });
    writeFileSync(
      paths.leasePath,
      JSON.stringify({
        run_id: "someone-else", pid: process.pid, host: (await import("node:os")).hostname(),
        capability: "profile.get", acquired_at: new Date().toISOString(),
      }) + "\n",
      { flag: "w" },
    );
    const { receipt, exit } = await invoke({ def: okCapability(), session }).outcome;
    expect(exit).toBe(EXIT.TRANSIENT);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("TAB_LEASE_HELD");
    expect(session.tabsOpened).toBe(0);
    // Someone else's lease survives our refusal.
    expect((await inspectLease(paths.leasePath)).state).toBe("held");
  });

  it("a capability that wants no browser never opens one", async () => {
    const def = okCapability({ needsBrowser: false, run: async () => ({ counts: { usable: 1 } }) });
    const { outcome, opened } = invoke({ def });
    const { exit } = await outcome;
    expect(exit).toBe(EXIT.OK);
    expect(opened).not.toHaveBeenCalled();
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });
});

describe("--force-release", () => {
  it("drops a wedged lease and names its holder on the receipt", async () => {
    const { hostname } = await import("node:os");
    mkdirSync(paths.runsDir, { recursive: true });
    writeFileSync(
      paths.leasePath,
      JSON.stringify({
        run_id: "wedged-run", pid: process.pid, host: hostname(),
        capability: "salesnav.leads.list", acquired_at: "2026-08-08T00:00:00.000Z",
      }) + "\n",
      { flag: "w" },
    );
    const { receipt, exit } = await invoke({ def: okCapability(), flags: { forceRelease: true } }).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.ok).toBe(true);
    if (!receipt.ok) return;
    const forced = receipt.warnings.find((w) => w.code === "TAB_LEASE_FORCE_RELEASED");
    expect(forced?.field).toContain("wedged-run");
    expect(forced?.field).toContain("salesnav.leads.list");
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("is a no-op on a free lease", async () => {
    const { receipt } = await invoke({ def: okCapability(), flags: { forceRelease: true } }).outcome;
    expect(receipt.ok && receipt.warnings).toEqual([]);
  });
});

describe("--budget only ever lowers", () => {
  it("refuses the page load past the invocation cap, with its own code", async () => {
    const def = okCapability({
      run: async ({ budget }) => {
        await budget.spend({ kind: "page_load" });
        await budget.spend({ kind: "page_load" });
        return {};
      },
    });
    const { receipt, exit } = await invoke({ def, flags: { budget: 1 } }).outcome;
    expect(exit).toBe(EXIT.BUDGET);
    expect(receipt.ok).toBe(false);
    if (!receipt.ok) expect(receipt.error.code).toBe("BUDGET_INVOCATION_CAP");
    // The one spend that did happen is on the receipt, measured not estimated.
    expect(receipt.cost.page_loads).toBe(1);
  });

  it("does not measure the invocation cap against other runs' spend", async () => {
    // The bug this pins: --budget also lowered the ledger's rolling hourly
    // limit, which counts every run. With 40 page loads already spent in the
    // hour, `--budget=5` was refused with "limit is 5, already at 40" — a limit
    // nobody hit, on a run well inside its own cap.
    mkdirSync(paths.runsDir, { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      paths.budgetPath,
      Array.from({ length: 40 }, (_, i) =>
        JSON.stringify({ ts: now, run_id: `earlier-${i}`, capability: "profile.get", kind: "page_load", n: 1 }),
      ).join("\n") + "\n",
    );
    const def = okCapability({
      run: async ({ budget }) => {
        await budget.spend({ kind: "page_load" });
        await budget.spend({ kind: "page_load" });
        return {};
      },
    });
    const { receipt, exit } = await invoke({ def, flags: { budget: 5 } }).outcome;
    expect(exit).toBe(EXIT.OK);
    expect(receipt.cost.page_loads).toBe(2);
  });

  it("cannot raise a default limit", async () => {
    const def = okCapability({
      run: async ({ budget }) => {
        // 61 page loads is over the §8 hourly default of 60. The effective
        // ceiling is min(invocation cap, ledger limit), so a large --budget
        // buys no headroom the ledger itself refuses.
        await budget.check({ kind: "page_load", n: 61 });
        return {};
      },
    });
    const { exit, receipt } = await invoke({ def, flags: { budget: 10_000 } }).outcome;
    expect(exit).toBe(EXIT.BUDGET);
    if (!receipt.ok) expect(receipt.error.code).toBe("BUDGET_EXCEEDED");
  });

  it("records real spends on the receipt's cost", async () => {
    const def = okCapability({
      run: async ({ budget }) => {
        await budget.spend({ kind: "page_load", n: 2 });
        await budget.spend({ kind: "search_page" });
        await budget.spend({ kind: "profile_open", ref: "urn:li:person:abc" });
        await budget.spend({ kind: "profile_open", ref: "urn:li:person:abc" });
        return {};
      },
    });
    const { receipt } = await invoke({ def }).outcome;
    expect(receipt.cost.page_loads).toBe(2);
    expect(receipt.cost.search_credits).toBe(1);
    const spends = readFileSync(paths.budgetPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(spends).toHaveLength(4);
    expect(new Set(spends.map((s) => s.run_id))).toEqual(new Set([receipt.run_id]));
  });
});

describe("crash cleanup", () => {
  it("can release the lease from the window between taking it and opening the tab", async () => {
    let cleanup: (() => Promise<void>) | null = null;
    let freedMidPreflight = false;
    const session = new FakeSession();
    // Stand exactly where a throw from a CDP listener would land: the lease is
    // held, the worker tab is not open yet, and nothing else knows.
    session.openWorkerTab = async () => {
      expect((await inspectLease(paths.leasePath)).state).toBe("held");
      await cleanup!();
      freedMidPreflight = (await inspectLease(paths.leasePath)).state === "free";
      return session.tab;
    };
    await execute({
      def: okCapability(), rawArgs: {}, flags: { ...DEFAULT_FLAGS }, ...paths,
      deps: { openSession: async () => session },
      onCleanup: (fn) => { cleanup = fn; },
    });
    expect(freedMidPreflight).toBe(true);
  });

  it("stops the tap even when starting it is what threw", async () => {
    let stopped = false;
    const tap = {
      start: () => { throw new Error("listener attach failed"); },
      stop: () => { stopped = true; },
      running: false,
      watching: [],
    };
    const { receipt, exit } = await execute({
      def: okCapability(), rawArgs: {}, flags: { ...DEFAULT_FLAGS }, ...paths,
      deps: { openSession: async () => new FakeSession(), makeTap: () => tap as never },
    });
    expect(exit).toBe(EXIT.GENERIC);
    expect(receipt.ok).toBe(false);
    expect(stopped).toBe(true);
    expect(await inspectLease(paths.leasePath)).toEqual({ state: "free" });
  });

  it("hands out a teardown thunk that releases the tab and the lease", async () => {
    let cleanup: (() => Promise<void>) | null = null;
    const session = new FakeSession();
    let released = false;
    const def = okCapability({
      run: async () => {
        // Stand where an uncaughtException would leave the process: mid-run,
        // holding the tab and the lease.
        expect((await inspectLease(paths.leasePath)).state).toBe("held");
        await cleanup!();
        released = (await inspectLease(paths.leasePath)).state === "free";
        return {};
      },
    });
    await execute({
      def, rawArgs: {}, flags: { ...DEFAULT_FLAGS }, ...paths,
      deps: { openSession: async () => session },
      onCleanup: (fn) => { cleanup = fn; },
    });
    expect(released).toBe(true);
    expect(session.closed).toBe(true);
  });
});

describe("checkLogin", () => {
  const reader = (cookies: unknown[]): CookieReader => ({ send: async <T,>() => ({ cookies }) as T });

  it("reads li_at without issuing a LinkedIn request, and never returns its value", async () => {
    const state = await checkLogin(reader([{ name: "li_at", domain: ".www.linkedin.com", expires: FUTURE, value: "SECRET" }]));
    expect(state).toEqual({ logged_in: true, cookie: "present", expires_at: new Date(FUTURE * 1000).toISOString() });
    expect(JSON.stringify(state)).not.toContain("SECRET");
  });

  it("reports a missing cookie, an expired one, and a session cookie distinctly", async () => {
    expect(await checkLogin(reader([]))).toEqual({ logged_in: false, cookie: "missing" });
    const past = Math.floor(Date.now() / 1000) - 10;
    expect((await checkLogin(reader([{ name: "li_at", domain: ".linkedin.com", expires: past }]))).cookie).toBe("expired");
    expect(await checkLogin(reader([{ name: "li_at", domain: ".linkedin.com", session: true, expires: -1 }])))
      .toEqual({ logged_in: true, cookie: "present" });
  });

  it("ignores an li_at belonging to some other domain", async () => {
    expect((await checkLogin(reader([{ name: "li_at", domain: ".evil.example", expires: FUTURE }]))).cookie).toBe("missing");
  });
});

describe("project", () => {
  it("projects objects, arrays of objects, and leaves scalars and null alone", () => {
    expect(project({ a: 1, b: 2 }, ["a"])).toEqual({ a: 1 });
    expect(project([{ a: 1, b: 2 }, { a: 3, b: 4 }], ["a"])).toEqual([{ a: 1 }, { a: 3 }]);
    expect(project({ a: 1 }, null)).toEqual({ a: 1 });
    expect(project(null, ["a"])).toBeNull();
    expect(project("x", ["a"])).toBe("x");
    expect(project({ a: 1 }, ["missing"])).toEqual({});
  });
});

describe("the real CLI process", () => {
  it("cap list returns the manifest, the lease and the exit-code table", async () => {
    const { stdout } = await run("npx", ["tsx", "src/cli/index.ts", "list"], { cwd: process.cwd() });
    const manifest = JSON.parse(stdout);
    expect(manifest.capabilities.map((c: { name: string }) => c.name)).toContain("health.check");
    expect(manifest.exit_codes).toMatchObject({ OK: 0, CHALLENGE: 2, BUDGET: 7 });
    expect(manifest.lease).toHaveProperty("state");
  }, 60_000);

  it("exits with the code the receipt names, for every failure class", async () => {
    const script = join(dir, "emit.ts");
    const codes: [string, number][] = [
      ["CHALLENGE", 2], ["RATE_LIMITED", 3], ["AUTH", 4],
      ["PARSE_DRIFT", 5], ["TRANSIENT", 6], ["BUDGET", 7], ["GENERIC", 1],
    ];
    for (const [name, expected] of codes) {
      writeFileSync(
        script,
        `import { buildErr, CapabilityError, emitReceipt, EXIT } from ${JSON.stringify(join(process.cwd(), "src/core/run/receipt.ts"))};\n` +
          `emitReceipt(buildErr({ run_id: "r", capability: "c", cost: { search_credits: 0, page_loads: 0, elapsed_ms: 0 },\n` +
          `  err: new CapabilityError({ code: "X", exit: EXIT.${name}, action: "HALT_AND_NOTIFY", retryable: false, message: "m" }) }));\n`,
      );
      const result = await run("npx", ["tsx", script], { cwd: process.cwd() }).catch((e: { code: number; stdout: string }) => e);
      const code = "code" in result ? result.code : 0;
      expect([name, code]).toEqual([name, expected]);
      expect(JSON.parse((result as { stdout: string }).stdout).error.exit).toBe(expected);
    }
  }, 120_000);
});
