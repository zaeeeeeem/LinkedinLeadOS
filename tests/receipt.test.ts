import { describe, it, expect } from "vitest";
import { EXIT, CapabilityError, buildOk, buildErr } from "../src/core/run/receipt.js";

describe("receipt", () => {
  it("builds an ok receipt with counts and cost", () => {
    const r = buildOk({
      run_id: "01JQ", capability: "health.check",
      counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
      cost: { search_credits: 0, page_loads: 1, elapsed_ms: 120 },
      artifacts: { events: "runs/01JQ/events.ndjson", raw: "runs/01JQ/raw/" },
    });
    expect(r.ok).toBe(true);
    expect(r.counts.usable).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("maps a CapabilityError onto an error receipt preserving exit and action", () => {
    const err = new CapabilityError({
      code: "CHALLENGE_PRESENTED", exit: EXIT.CHALLENGE,
      action: "HALT_AND_NOTIFY", retryable: false,
      message: "verification interstitial",
      evidence: "runs/01JQ/shots/challenge.png",
    });
    const r = buildErr({
      run_id: "01JQ", capability: "profile.get", err,
      cost: { search_credits: 0, page_loads: 1, elapsed_ms: 900 },
    });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("CHALLENGE_PRESENTED");
    expect(r.error.action).toBe("HALT_AND_NOTIFY");
    expect(r.error.retryable).toBe(false);
    expect(r.error.exit).toBe(EXIT.CHALLENGE);
  });

  it("carries the failure class onto the receipt for every exit code", () => {
    for (const exit of [EXIT.CHALLENGE, EXIT.RATE_LIMITED, EXIT.AUTH,
                        EXIT.PARSE_DRIFT, EXIT.TRANSIENT, EXIT.BUDGET] as const) {
      const r = buildErr({
        run_id: "01JQ", capability: "profile.get",
        err: new CapabilityError({
          code: "X", exit, action: "SKIP_ITEM", retryable: false, message: "m",
        }),
        cost: { search_credits: 0, page_loads: 0, elapsed_ms: 0 },
      });
      expect(r.error.exit).toBe(exit);
    }
  });

  it("exposes every exit code from the spec", () => {
    expect(EXIT).toEqual({
      OK: 0, GENERIC: 1, CHALLENGE: 2, RATE_LIMITED: 3,
      AUTH: 4, PARSE_DRIFT: 5, TRANSIENT: 6, BUDGET: 7,
    });
  });
});
