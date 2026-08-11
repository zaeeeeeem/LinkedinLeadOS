import type { ArchivedCapture } from "../src/core/archive/raw.js";
import type { Capture } from "../src/core/tap/network-tap.js";
import type { CompletedPage, PagedRunOutcome } from "../src/core/paged/types.js";
import type { BrowserBundle, CapabilityContext } from "../src/cli/types.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import type { StoreClient } from "../src/core/store/client.js";
import {
  createSalesNavLeadsCapability,
  projectProvedPages,
  type SalesNavLeadsDeps,
} from "../src/capabilities/salesnav.leads.list/index.js";
import {
  createLeadsSource,
  selectLeadPage,
  type LeadsCursor,
  type LeadsSourceRuntime,
} from "../src/capabilities/salesnav.leads.list/source.js";
import { describe, expect, it, vi } from "vitest";

function body(page: number, member = page): string {
  const count = 25;
  return JSON.stringify({
    paging: { total: 75, count, start: (page - 1) * count },
    elements: [{
      objectUrn: `urn:li:member:${member}`,
      entityUrn: `urn:li:fs_salesProfile:(profile${member},ctx${member},token${member})`,
      fullName: `Person ${member}`,
      firstName: "Person",
      lastName: String(member),
      geoRegion: "Region",
      degree: 1,
      trackingId: `tracking-${member}`,
      listCount: 0,
      saved: false,
      viewed: false,
      premium: false,
      openLink: false,
      memorialized: false,
      pendingInvitation: false,
      blockThirdPartyDataSharing: false,
      currentPositions: [],
      spotlightBadges: [],
      profilePictureDisplayImage: { artifacts: [] },
    }],
  });
}

function archived(file: string, seq = 0): ArchivedCapture {
  return {
    seq, id: file, file, path: `/tmp/${file}`, shapeHash: "shape", url: "https://www.linkedin.com/sales-api/salesApiLeadSearch",
    status: 200, capturedAt: "2026-08-11T00:00:00.000Z", bytes: 1,
  };
}

function capture(page: number, member = page, seq = page): Capture {
  const entry = archived(`${page}.json.gz`, seq);
  const text = body(page, member);
  return {
    seq,
    pattern: "salesapi-lead-search",
    patterns: ["salesapi-lead-search", "linkedin-data"],
    requestId: String(page),
    url: `https://www.linkedin.com/sales-api/salesApiLeadSearch?sessionId=session-a&page=${page}`,
    status: 200,
    body: text,
    bytes: text.length,
    archived: entry,
    capturedAt: entry.capturedAt,
  };
}

function pageRecord(page: number): CompletedPage {
  return {
    page,
    archive_ids: [`${page}.json.gz`],
    items: 1,
    has_more: true,
    spent: { page_loads: 1, search_pages: 1 },
    cursor: {
      kind: "salesnav-leads/v1", session_id: "session-a", page,
      start: (page - 1) * 25, count: 25,
      arrival: page === 1 ? "navigate" : "click",
      ...(page === 1 ? {} : { click: { control: "Next", reveal_passes: 1 } }),
    } satisfies LeadsCursor,
    completed_at: "2026-08-11T00:00:00.000Z",
  };
}

describe("Sales Navigator lead page evidence", () => {
  it("selects the named endpoint by the body's page offset", () => {
    const got = selectLeadPage([capture(1), capture(2)], 2, []);
    expect(got.captures.map((item) => item.archived.file)).toEqual(["2.json.gz"]);
    expect(got.parsed.paging).toMatchObject({ page: 2, start: 25, count: 25 });
    expect(got.parsed.rows[0]).toMatchObject({ page: 2, position: 1, person_urn: "urn:li:member:2" });
  });

  it("fails a clicked page whose body offset did not advance", () => {
    expect(() => selectLeadPage([capture(1)], 2, [])).toThrowError(expect.objectContaining({ code: "PAGE_DID_NOT_ADVANCE" }));
  });

  it("classifies a changed paging shape as parse drift", () => {
    const changed = capture(1);
    changed.body = JSON.stringify({ elements: [] });
    expect(() => selectLeadPage([changed], 1, [])).toThrowError(expect.objectContaining({
      code: "SALESNAV_PAGING_PARSE_DRIFT",
      exit: EXIT.PARSE_DRIFT,
    }));
  });

  it("refuses two bodies at one offset when their stable identities disagree", () => {
    expect(() => selectLeadPage([capture(2, 20, 1), capture(2, 21, 2)], 2, []))
      .toThrowError(expect.objectContaining({ code: "SALESNAV_PAGE_AMBIGUOUS" }));
  });

  it("returns the tap's exact archive ids to the paged loop", async () => {
    const hit = capture(1);
    let currentUrl = "about:blank";
    const tap = {
      cursor: 0,
      watch: vi.fn(),
      waitFor: vi.fn(async () => hit),
      drain: vi.fn(async () => {}),
      captures: vi.fn(() => [hit]),
    };
    const tab = {
      ensureForeground: vi.fn(async () => ({ ok: true, via: "already", state: null })),
      navigate: vi.fn(async (url: string) => { currentUrl = `${url}?sessionId=session-a`; return { settledOn: "complete", readyState: "complete", waitedMs: 1 }; }),
      currentUrl: vi.fn(async () => currentUrl),
    };
    const browser = { tab, tap, cursor: { pause: vi.fn(async () => 1) } } as unknown as BrowserBundle;
    const runtime = {
      gate: vi.fn(async () => ({ kind: "clean", clean: true, signal: "none", detail: "clean" })),
      read: vi.fn(async () => ({ passes: 3, scrolled: 300, layout: { settled: true } })),
      click: vi.fn(),
    } as unknown as LeadsSourceRuntime;
    const source = createLeadsSource({
      browser,
      run: { runId: "run", log: vi.fn(), checkpoint: vi.fn(), lastCheckpoint: <T,>() => ({ paged: { preserved: true } }) as T },
      target: {
        kind: "salesnav-search", url: "https://www.linkedin.com/sales/search/people", ref: "salesnav:people",
        vertical: "people", sessionId: null, savedSearchId: null, page: null,
      },
      sessionUrns: () => [],
    }, runtime);

    const loaded = await source.loadPage({ page: 1, pagesDone: 0, cursor: undefined, respent: false });
    expect(loaded.archived?.map((item) => item.file)).toEqual(["1.json.gz"]);
    expect(loaded.captures).toBeUndefined();
    expect((loaded.cursor as LeadsCursor).session_id).toBe("session-a");
    expect(runtime.gate).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ paged: { preserved: true }, salesnav_leads: expect.any(Object) }),
    }));
  });

  it("checks the prior session before clicking and trusts the arrived body offset", async () => {
    const hit = capture(2);
    let currentUrl = "https://www.linkedin.com/sales/search/people?sessionId=session-a&page=1";
    const tap = {
      cursor: 0, watch: vi.fn(), waitFor: vi.fn(async () => hit), drain: vi.fn(async () => {}), captures: vi.fn(() => [hit]),
    };
    const runtime = {
      gate: vi.fn(async () => ({ kind: "clean", clean: true, signal: "none", detail: "clean" })),
      read: vi.fn(async () => ({ passes: 3, scrolled: 300, layout: { settled: true } })),
      click: vi.fn(async () => {
        currentUrl = "https://www.linkedin.com/sales/search/people?sessionId=session-a&page=2";
        return { direction: "next", control: "Next", tag: "button", revealPasses: 1, x: 10, y: 10 };
      }),
    } as unknown as LeadsSourceRuntime;
    const browser = {
      tap,
      tab: { ensureForeground: async () => ({ ok: true, via: "already", state: null }), currentUrl: async () => currentUrl },
      cursor: { pause: async () => 1 },
    } as unknown as BrowserBundle;
    const source = createLeadsSource({
      browser,
      run: { runId: "run", log: vi.fn(), checkpoint: vi.fn(), lastCheckpoint: <T,>() => ({}) as T },
      target: {
        kind: "salesnav-search", url: "https://www.linkedin.com/sales/search/people", ref: "salesnav:people",
        vertical: "people", sessionId: null, savedSearchId: null, page: null,
      },
      sessionUrns: () => [],
    }, runtime);
    const prior: LeadsCursor = { kind: "salesnav-leads/v1", session_id: "session-a", page: 1, start: 0, count: 25, arrival: "navigate" };
    const loaded = await source.loadPage({ page: 2, pagesDone: 1, cursor: prior, respent: false });
    expect(runtime.click).toHaveBeenCalledOnce();
    expect(loaded.archived?.map((item) => item.file)).toEqual(["2.json.gz"]);
    expect((loaded.cursor as LeadsCursor)).toMatchObject({ page: 2, start: 25, session_id: "session-a", arrival: "click" });
  });

  it("refuses a changed session before any pager click", async () => {
    const click = vi.fn();
    const browser = {
      tap: { cursor: 0, watch: vi.fn() },
      tab: {
        ensureForeground: async () => ({ ok: true, via: "already", state: null }),
        currentUrl: async () => "https://www.linkedin.com/sales/search/people?sessionId=session-b&page=1",
      },
      cursor: {},
    } as unknown as BrowserBundle;
    const source = createLeadsSource({
      browser,
      run: { runId: "run", log: vi.fn(), checkpoint: vi.fn(), lastCheckpoint: <T,>() => ({}) as T },
      target: {
        kind: "salesnav-search", url: "https://www.linkedin.com/sales/search/people", ref: "salesnav:people",
        vertical: "people", sessionId: null, savedSearchId: null, page: null,
      },
      sessionUrns: () => [],
    }, { click } as unknown as LeadsSourceRuntime);
    const prior: LeadsCursor = { kind: "salesnav-leads/v1", session_id: "session-a", page: 1, start: 0, count: 25, arrival: "navigate" };
    await expect(source.loadPage({ page: 2, pagesDone: 1, cursor: prior, respent: false }))
      .rejects.toMatchObject({ code: "SALESNAV_SESSION_CHANGED" });
    expect(click).not.toHaveBeenCalled();
  });
});

describe("archive-proved storage projection", () => {
  it("re-reads every proved page, including pages absent from this session's loaded list", async () => {
    const got = await projectProvedPages({
      pages: [pageRecord(1), pageRecord(2)],
      readText: async (id) => body(Number(id.split(".")[0])),
      searchId: "run-a",
      runRef: "run-a",
      sessionUrns: [],
    });
    expect(got.rows).toEqual([
      { search_id: "run-a", page: 1, position: 1, person_urn: "urn:li:member:1", run_ref: "run-a" },
      { search_id: "run-a", page: 2, position: 1, person_urn: "urn:li:member:2", run_ref: "run-a" },
    ]);
  });

  it("refuses a checkpoint claim whose archived body no longer proves that page", async () => {
    await expect(projectProvedPages({
      pages: [pageRecord(2)],
      readText: async () => body(1),
      searchId: "run-a",
      runRef: "run-a",
      sessionUrns: [],
    })).rejects.toMatchObject({ code: "SALESNAV_PROVED_PAGE_UNREADABLE" });
  });

  it("refuses a proved page whose archived identities no longer match its fingerprint", async () => {
    const page = { ...pageRecord(1), fingerprint: "not-the-archived-page" };
    await expect(projectProvedPages({
      pages: [page],
      readText: async () => body(1),
      searchId: "run-a",
      runRef: "run-a",
      sessionUrns: [],
    })).rejects.toMatchObject({ code: "SALESNAV_PROVED_PAGE_IDENTITY_CHANGED" });
  });
});

function outcome(): PagedRunOutcome {
  return {
    stop: "page-limit", warnings: [], complete: false, pages: [pageRecord(1), pageRecord(2)], loaded: [], items: 2,
    spent: { page_loads: 2, search_pages: 2 }, wasted: { page_loads: 0, search_pages: 0 },
    unconfirmed: { page_loads: 0, search_pages: 0 }, orphans: [], respentPages: [], dwellMs: 1, resumeToken: "run-a",
  };
}

function composition(failSecond = false) {
  const insertResults = vi.fn(async (rows: readonly unknown[]) => {
    if (failSecond && insertResults.mock.calls.length === 2) {
      throw new CapabilityError({ code: "STORE_WRITE_FAILED", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false, message: "failed" });
    }
    return { rows: rows.length, skipped: 0 };
  });
  const deps: SalesNavLeadsDeps = {
    store: vi.fn(() => ({} as StoreClient)),
    ensureRun: vi.fn(async () => {}),
    finishRun: vi.fn(async () => {}),
    ensureSearch: vi.fn(async (input) => ({ search_id: input.search_id, rows: 1 as const, inserted: true })),
    insertResults,
    paged: vi.fn(async () => outcome()),
    source: vi.fn(() => ({ loadPage: vi.fn() })),
  };
  const tap = { captures: vi.fn(() => []), drain: vi.fn(async () => {}) };
  const ctx = {
    run: {
      runId: "run-a", resumed: false, args: { url: "https://www.linkedin.com/sales/search/people" }, dir: "/tmp/run-a",
      log: vi.fn(), elapsedMs: () => 10, artifacts: () => ({ events: "runs/a/events.ndjson", raw: "runs/a/raw/" }),
      lastCheckpoint: () => null, checkpoint: vi.fn(),
    },
    args: { url: "https://www.linkedin.com/sales/search/people", pages: 2, limit: 50 },
    flags: { runId: null, dryRun: false, fields: null, noStore: false, budget: null, forceRelease: false },
    budget: { spent: { page_loads: 2, search_pages: 2, profile_opens: 0 } },
    estimate: { page_loads: 2, search_pages: 2, profile_opens: 0 },
    login: { logged_in: true, cookie: "present" },
    browser: { tap, archive: { readText: async (id: string) => body(Number(id.split(".")[0])) } },
  } as unknown as CapabilityContext<{ url?: string; pages: number; limit: number }, true>;
  return { capability: createSalesNavLeadsCapability(deps), deps, ctx, insertResults };
}

describe("salesnav.leads.list composition", () => {
  it("writes each proved page as its own bounded store batch", async () => {
    const { capability, ctx, insertResults, deps } = composition();
    const result = await capability.run(ctx as never);
    expect(insertResults).toHaveBeenCalledTimes(2);
    expect(insertResults.mock.calls.map(([rows]) => rows)).toEqual([
      [{ search_id: "run-a", page: 1, position: 1, person_urn: "urn:li:member:1", run_ref: "run-a" }],
      [{ search_id: "run-a", page: 2, position: 1, person_urn: "urn:li:member:2", run_ref: "run-a" }],
    ]);
    expect(result.data).toMatchObject({ pages: [1, 2], clicks: [{ page: 2, control: "Next", reveal_passes: 1 }] });
    expect(result.counts).toEqual({ requested: 50, captured: 2, usable: 2, skipped: 0 });
    expect(deps.finishRun).toHaveBeenCalledWith("run-a", expect.objectContaining({ status: "ok", exit_code: 0 }), expect.anything());
  });

  it("reports prior page writes when a later page store batch fails", async () => {
    const { capability, ctx } = composition(true);
    const error = await capability.run(ctx as never).catch((cause) => cause);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: "StoreWriteError", code: "STORE_WRITE_FAILED", stored: 1 });
  });

  it("honors --no-store even when a store client would otherwise be available", async () => {
    const { capability, ctx, deps } = composition();
    ctx.flags.noStore = true;
    await capability.run(ctx as never);
    expect(deps.store).not.toHaveBeenCalled();
    expect(deps.ensureRun).not.toHaveBeenCalled();
    expect(deps.ensureSearch).not.toHaveBeenCalled();
    expect(deps.insertResults).not.toHaveBeenCalled();
  });
});
