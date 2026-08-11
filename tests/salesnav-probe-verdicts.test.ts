import { describe, expect, it } from "vitest";
import { CapabilityError, EXIT, type Warning } from "../src/core/run/receipt.js";
import {
  awaitFirstApiResponse, mayLoadPageTwo, noSeatError, pushSurfaceWarnings, seatVerdict,
  sourceVerdict, type SurfaceOutcome,
} from "../src/capabilities/salesnav.probe/index.js";
import { emptySurface, type SurfaceReport } from "../src/capabilities/salesnav.probe/surface.js";
import type { SalesNavSurface } from "../src/capabilities/salesnav.probe/url.js";

function report(over: (r: SurfaceReport) => void = () => {}): SurfaceReport {
  const r = emptySurface();
  over(r);
  return r;
}

function outcome(surface: SalesNavSurface, over: Partial<SurfaceOutcome> = {}): SurfaceOutcome {
  return {
    surface,
    requested_url: `https://www.linkedin.com/sales/search/people#${surface}`,
    landed_url: null,
    stage: "done",
    skipped_reason: null,
    page_load_spent: true,
    search_page_spent: surface !== "home",
    api_response: true,
    captured: 3,
    arrival: "navigate",
    click: null,
    paging: null,
    salesnav_ish: 1,
    salesnav_ish_api: 1,
    unmatched_salesnav_ish: 0,
    misses: 0,
    layout_settled: true,
    scroll_passes: 4,
    scrolled_px: 4000,
    snapshot: { archived: "0001.json.gz", bytes: 1024, rendered: true, failure: null, container: null },
    surface_report: report((r) => { r.rows.leadLinks = 25; }),
    pagination: "url",
    endpoints: [],
    ...over,
  };
}

const codes = (w: Warning[]): string[] => w.map((x) => x.code);

describe("seatVerdict — first, cheap and honest", () => {
  it("passes when the app shell rendered", () => {
    const v = seatVerdict(report((r) => { r.seat.appShell = true; }), []);
    expect(v.hasSeat).toBe(true);
  });

  it("fails on a redirect off /sales/", () => {
    const v = seatVerdict(
      report((r) => { r.seat.redirectedOffSales = true; r.url = "https://www.linkedin.com/feed/"; }),
      [],
    );
    expect(v.hasSeat).toBe(false);
    expect(v.evidence).toContain("/feed/");
  });

  it("fails on an in-place upsell, from the dom or from a body", () => {
    expect(seatVerdict(report((r) => { r.seat.upsell = true; r.seat.appShell = true; }), []).hasSeat).toBe(false);
    expect(seatVerdict(report((r) => { r.seat.appShell = true; }), ['{"x":"/sales/gold/"}']).hasSeat).toBe(false);
  });

  // The one direction this must not guess. An unmeasurable page is a different
  // failure, and calling it seatless would send the operator to buy something
  // they may already own.
  it("returns null rather than a verdict when it could not tell", () => {
    expect(seatVerdict(null, []).hasSeat).toBeNull();
    expect(seatVerdict(report(), []).hasSeat).toBeNull();
  });

  it("a redirect outranks an app shell, because the shell may be the page it landed on", () => {
    const v = seatVerdict(report((r) => { r.seat.appShell = true; r.seat.redirectedOffSales = true; }), []);
    expect(v.hasSeat).toBe(false);
  });
});

describe("noSeatError", () => {
  it("halts and notifies; it is not a challenge and never retries", () => {
    const e = noSeatError("upsell markers present");
    expect(e.code).toBe("SALESNAV_NO_SEAT");
    expect(e.exit).toBe(EXIT.GENERIC);
    expect(e.exit).not.toBe(EXIT.CHALLENGE);
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("HALT_AND_NOTIFY");
    expect(e.message).toContain("[DECISION NEEDED]");
  });
});

describe("mayLoadPageTwo — page 2 is not spent on an assumption", () => {
  // The page decides how it is reached, never the flag.
  it("navigates when page 1's own pager offered a page url", () => {
    const gate = mayLoadPageTwo(outcome("leads", { pagination: "url" }));
    expect(gate.ok).toBe(true);
    expect(gate.mode).toBe("navigate");
  });

  // Before D400 this was the refusal branch; the refusal is what produced the
  // grant. It must not silently become a navigation to a synthesized page=2 url
  // — that is the "teleporting" form the reference worker refused.
  it("clicks when the pager is buttons only, per the D400 grant", () => {
    const gate = mayLoadPageTwo(outcome("leads", { pagination: "click-only" }));
    expect(gate.ok).toBe(true);
    expect(gate.mode).toBe("click");
    expect(gate.reason).toContain("D400");
  });

  it("refuses when no pager rendered — there is no page 2 to reach", () => {
    const gate = mayLoadPageTwo(outcome("leads", { pagination: "none" }));
    expect(gate.ok).toBe(false);
    expect(gate.mode).toBeNull();
  });

  it("refuses when page 1 never completed, or was never attempted", () => {
    expect(mayLoadPageTwo(undefined).ok).toBe(false);
    expect(mayLoadPageTwo(outcome("leads", { stage: "read", pagination: "url" })).ok).toBe(false);
    // Including the click branch: a click needs a rendered pager to click in.
    expect(mayLoadPageTwo(outcome("leads", { stage: "measure", pagination: "click-only" })).ok).toBe(false);
  });
});

describe("sourceVerdict — the milestone's fork, per surface", () => {
  it("is true when rows rendered and a body carried them", () => {
    expect(sourceVerdict([outcome("leads", { salesnav_ish: 4, salesnav_ish_api: 4 })])).toEqual({ leads: true });
  });

  it("is false when rows rendered and no body carried them", () => {
    expect(sourceVerdict([outcome("leads", { salesnav_ish: 0, salesnav_ish_api: 0 })])).toEqual({ leads: false });
  });

  // The one way this verdict could be wrong in the unsafe direction. The
  // surface's own document response is `isSalesNavIsh` the moment it
  // server-renders a `/sales/lead/` link into its markup — counting it would
  // answer "the rows are in a labeled body" for a page whose rows are markup,
  // and skip the `[DECISION NEEDED]` that grows CLAUDE.md's exception list.
  it("does not count the surface's own document response as a labeled body", () => {
    const documentOnly = outcome("leads", { salesnav_ish: 1, salesnav_ish_api: 0 });
    expect(sourceVerdict([documentOnly])).toEqual({ leads: false });
  });

  // A page with no rows says nothing about where rows live. Recording it as
  // "not in a body" would be a verdict the run did not earn.
  it("is null when nothing rendered", () => {
    const empty = outcome("leads", { salesnav_ish: 0, salesnav_ish_api: 0, surface_report: report() });
    expect(sourceVerdict([empty])).toEqual({ leads: null });
  });

  it("ignores the app root and any surface that did not finish", () => {
    expect(sourceVerdict([outcome("home"), outcome("leads2", { stage: "skipped" })])).toEqual({});
  });
});

describe("pushSurfaceWarnings", () => {
  it("says nothing about a clean run", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(w, [outcome("home"), outcome("leads")], { hasSeat: true, evidence: "shell" });
    expect(w).toEqual([]);
  });

  it("flags an undetermined seat as making every later verdict provisional", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(w, [outcome("home")], { hasSeat: null, evidence: "unrecognised" });
    expect(codes(w)).toContain("SALESNAV_SEAT_UNDETERMINED");
    expect(w[0]!.field).toContain("provisional");
  });

  it("raises the DOM-only decision when rows rendered but no body carried them", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(w, [outcome("leads", { salesnav_ish: 0, salesnav_ish_api: 0 })], { hasSeat: true, evidence: "" });
    const found = w.find((x) => x.code === "ROWS_DOM_ONLY")!;
    expect(found.field).toContain("[DECISION NEEDED]");
    expect(found.field).toContain("exception");
  });

  // Same trap as the verdict's: a document response carrying markup rows must
  // not silence the DOM-only finding.
  it("still raises DOM-only when only the document response carried rows", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(w, [outcome("leads", { salesnav_ish: 2, salesnav_ish_api: 0 })], { hasSeat: true, evidence: "" });
    expect(codes(w)).toContain("ROWS_DOM_ONLY");
  });

  // No longer a blocking decision (D400), and still reported: a build that
  // started serving hrefs again would page by navigation, and this line is how
  // that change shows up on a receipt.
  it("records a click-only pager as measured, not as a blocked decision", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(w, [outcome("leads", { pagination: "click-only" })], { hasSeat: true, evidence: "" });
    const found = w.find((x) => x.code === "PAGINATION_CLICK_ONLY")!;
    expect(found.field).toContain("D400");
    expect(found.field).not.toContain("[DECISION NEEDED]");
  });

  describe("the arrival check for a clicked page (D400 clause 6)", () => {
    it("says nothing when the body reports an advanced offset", () => {
      const w: Warning[] = [];
      pushSurfaceWarnings(
        w,
        [outcome("leads2", { arrival: "click", paging: { start: 25, count: 25, from: "search-body" as const } })],
        { hasSeat: true, evidence: "" },
      );
      expect(codes(w)).not.toContain("PAGE_DID_NOT_ADVANCE");
    });

    it("warns when the click produced no paging evidence at all", () => {
      const w: Warning[] = [];
      pushSurfaceWarnings(w, [outcome("leads2", { arrival: "click", paging: null })], { hasSeat: true, evidence: "" });
      expect(w.find((x) => x.code === "PAGE_DID_NOT_ADVANCE")!.field).toContain("page 2");
    });

    // The failure this exists for: the click landed on something that
    // re-rendered page 1. A fixture promoted from it would be page 1 filed as
    // page 2, and nothing downstream could tell.
    it("warns when the body still reports offset zero", () => {
      const w: Warning[] = [];
      pushSurfaceWarnings(
        w,
        [outcome("leads2", { arrival: "click", paging: { start: 0, count: 25, from: "search-body" as const } })],
        { hasSeat: true, evidence: "" },
      );
      expect(codes(w)).toContain("PAGE_DID_NOT_ADVANCE");
    });

    // A navigated page is checked by its url, not by this.
    it("does not apply to a surface that was navigated to", () => {
      const w: Warning[] = [];
      pushSurfaceWarnings(w, [outcome("leads", { arrival: "navigate", paging: null })], { hasSeat: true, evidence: "" });
      expect(codes(w)).not.toContain("PAGE_DID_NOT_ADVANCE");
    });
  });

  // A page that rendered nothing must not also be reported as DOM-only: that
  // would be two findings from one absent measurement.
  it("reports an empty results page as empty and not as DOM-only", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(
      w,
      [outcome("leads", { salesnav_ish: 0, surface_report: report(), pagination: "none" })],
      { hasSeat: true, evidence: "" },
    );
    expect(codes(w)).toContain("NO_RESULT_ROWS");
    expect(codes(w)).not.toContain("ROWS_DOM_ONLY");
  });

  it("names the skipped surface and why it was skipped", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(
      w,
      [outcome("leads2", { stage: "skipped", skipped_reason: "pager is click-only", page_load_spent: false })],
      { hasSeat: true, evidence: "" },
    );
    expect(w.find((x) => x.code === "SURFACE_NOT_LOADED")!.field).toContain("leads2: pager is click-only");
  });

  it("aggregates one warning per finding, naming every surface it covers", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(
      w,
      [outcome("leads", { layout_settled: false }), outcome("accounts", { layout_settled: false })],
      { hasSeat: true, evidence: "" },
    );
    const found = w.filter((x) => x.code === "SURFACE_NOT_LAID_OUT");
    expect(found).toHaveLength(1);
    expect(found[0]!.n).toBe(2);
    expect(found[0]!.field).toContain("leads, accounts");
  });

  it("sums the pattern mismatches rather than counting the surfaces", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(
      w,
      [outcome("leads", { unmatched_salesnav_ish: 3 }), outcome("accounts", { unmatched_salesnav_ish: 4 })],
      { hasSeat: true, evidence: "" },
    );
    expect(w.find((x) => x.code === "PATTERN_MISMATCH")!.n).toBe(7);
  });

  it("describes a shell snapshot even though the surface never finished", () => {
    const w: Warning[] = [];
    pushSurfaceWarnings(
      w,
      [outcome("leads", { stage: "measure", snapshot: { archived: "x.gz", bytes: 10, rendered: false, failure: null, container: null } })],
      { hasSeat: true, evidence: "" },
    );
    expect(codes(w)).toContain("SUBJECT_CONTAINER_NOT_RENDERED");
  });
});

describe("awaitFirstApiResponse", () => {
  const timeout = new CapabilityError({
    code: "CAPTURE_TIMEOUT", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true,
    message: "nothing matched",
  });

  it("reports true when a body landed", async () => {
    expect(await awaitFirstApiResponse({ waitFor: async () => ({}) }, { since: 0, timeoutMs: 1 })).toBe(true);
  });

  // "This surface fetches nothing" is the finding this probe exists to return,
  // not a failure — on this surface it is the answer the milestone forks on.
  it("reports false on a capture timeout", async () => {
    const tap = { waitFor: async () => { throw timeout; } };
    expect(await awaitFirstApiResponse(tap, { since: 0, timeoutMs: 1 })).toBe(false);
  });

  // Swallowing one of these would put "this surface issues no api calls" on the
  // receipt and send an operator to LinkedIn over a defect in here (D17).
  it("re-throws a repo defect unchanged", async () => {
    const fatal = new CapabilityError({
      code: "TAP_UNKNOWN_PATTERN", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false,
      message: "bug",
    });
    await expect(awaitFirstApiResponse({ waitFor: async () => { throw fatal; } }, { since: 0, timeoutMs: 1 }))
      .rejects.toThrow("bug");
    await expect(awaitFirstApiResponse({ waitFor: async () => { throw new Error("boom"); } }, { since: 0, timeoutMs: 1 }))
      .rejects.toThrow("boom");
  });
});
