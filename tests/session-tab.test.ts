import { describe, expect, it } from "vitest";
import type { CdpEvent } from "../src/core/cdp/client.js";
import { CapabilityError } from "../src/core/run/receipt.js";
import { WorkerTab, type CdpTransport } from "../src/core/session/tab.js";

/**
 * Task 4 states no unit tests, and for the browser orchestration itself that is
 * right — there is nothing to assert offline about whether a real page loaded.
 * Two properties here are not orchestration though, they are the safety model:
 * the attach surface enables `Network` and only `Network` (D8), and foregrounding
 * escalates to `Target.activateTarget` — the one step that yanks the operator's
 * window — strictly last. Both are invisible in a live check that passes, and
 * both would stay passing while silently regressing. A recording double pins them.
 */
type Call = { method: string; params: Record<string, unknown>; sessionId?: string };

class FakeCdp implements CdpTransport {
  readonly calls: Call[] = [];
  readonly #replies: Map<string, () => unknown>;
  readonly #listeners = new Set<(e: CdpEvent) => void>();

  constructor(replies: Record<string, () => unknown> = {}) {
    this.#replies = new Map(Object.entries(replies));
  }

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) });
    const reply = this.#replies.get(method);
    return (reply ? reply() : {}) as T;
  }

  on(listener: (e: CdpEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: CdpEvent): void {
    for (const l of this.#listeners) l(event);
  }
}

const ATTACH = { "Target.attachToTarget": () => ({ sessionId: "S1" }) };

/** `document.hidden` answers, consumed one per call. */
function visibility(...hidden: boolean[]) {
  const queue = [...hidden];
  return () => {
    const h = queue.length > 1 ? queue.shift()! : queue[0]!;
    return { result: { value: { hidden: h, focused: !h, visibility: h ? "hidden" : "visible" } } };
  };
}

describe("WorkerTab.attach", () => {
  it("enables Network and nothing else, and never enables Runtime or Page", async () => {
    const cdp = new FakeCdp(ATTACH);
    await WorkerTab.attach(cdp, "T1");

    expect(cdp.methods.filter((m) => m.endsWith(".enable"))).toEqual(["Network.enable"]);
    expect(cdp.methods).not.toContain("Runtime.enable");
    expect(cdp.methods).not.toContain("Page.enable");
  });

  it("asserts focus emulation at creation, before anything can render", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");

    expect(cdp.methods).toEqual([
      "Target.attachToTarget",
      "Network.enable",
      "Emulation.setFocusEmulationEnabled",
    ]);
    expect(cdp.calls[2]!.params["enabled"]).toBe(true);
    expect(tab.focusEmulated).toBe(true);
  });

  it("scopes every tab command to the attached session", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");
    await tab.send("Anything");

    expect(cdp.calls[0]!.sessionId).toBeUndefined(); // attach is browser-scoped
    expect(cdp.calls.slice(1).every((c) => c.sessionId === "S1")).toBe(true);
  });
});

describe("WorkerTab.ensureForeground", () => {
  it("does nothing when the page already reports itself visible", async () => {
    const cdp = new FakeCdp({ ...ATTACH, "Runtime.evaluate": visibility(false) });
    const tab = await WorkerTab.attach(cdp, "T1");
    const before = cdp.calls.length;

    const r = await tab.ensureForeground();

    expect(r).toMatchObject({ ok: true, via: "already" });
    expect(cdp.methods.slice(before)).toEqual(["Runtime.evaluate"]);
  });

  it("escalates least-intrusive first and reaches activateTarget only last", async () => {
    // Hidden through every check but the one after activate-target.
    const cdp = new FakeCdp({
      ...ATTACH,
      "Runtime.evaluate": visibility(true, true, true, false),
    });
    const tab = await WorkerTab.attach(cdp, "T1");
    const before = cdp.calls.length;

    const r = await tab.ensureForeground();

    expect(r.ok).toBe(true);
    expect(r.via).toBe("activate-target");
    expect(cdp.methods.slice(before)).toEqual([
      "Runtime.evaluate",
      "Emulation.setFocusEmulationEnabled",
      "Runtime.evaluate",
      "Page.setWebLifecycleState",
      "Runtime.evaluate",
      "Target.activateTarget",
      "Runtime.evaluate",
    ]);
  });

  it("stops at emulation when emulation is enough — the operator's window stays put", async () => {
    const cdp = new FakeCdp({ ...ATTACH, "Runtime.evaluate": visibility(true, false) });
    const tab = await WorkerTab.attach(cdp, "T1");

    const r = await tab.ensureForeground();

    expect(r.via).toBe("focus-emulation");
    expect(cdp.methods).not.toContain("Target.activateTarget");
  });

  it("reports failure rather than pretending, when nothing makes the page visible", async () => {
    const cdp = new FakeCdp({ ...ATTACH, "Runtime.evaluate": visibility(true) });
    const tab = await WorkerTab.attach(cdp, "T1");

    expect(await tab.ensureForeground()).toMatchObject({ ok: false, via: null });
  });
});

describe("WorkerTab.evaluate", () => {
  it("returns the value", async () => {
    const cdp = new FakeCdp({ ...ATTACH, "Runtime.evaluate": () => ({ result: { value: "complete" } }) });
    const tab = await WorkerTab.attach(cdp, "T1");

    expect(await tab.evaluate("document.readyState")).toBe("complete");
  });

  it("throws on a page-side exception instead of resolving undefined", async () => {
    const cdp = new FakeCdp({
      ...ATTACH,
      "Runtime.evaluate": () => ({
        result: {},
        exceptionDetails: { exception: { description: "TypeError: x is not a function" } },
      }),
    });
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.evaluate("x()")).rejects.toMatchObject({
      code: "TAB_EVAL_FAILED",
      retryable: true,
    });
  });
});

describe("WorkerTab teardown", () => {
  it("drops focus emulation before closing the target", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");
    await tab.close();

    const tail = cdp.calls.slice(-2);
    expect(tail[0]!.method).toBe("Emulation.setFocusEmulationEnabled");
    expect(tail[0]!.params["enabled"]).toBe(false);
    expect(tail[1]!.method).toBe("Target.closeTarget");
  });

  it("does not throw past teardown when the browser is already gone", async () => {
    const cdp = new FakeCdp({
      ...ATTACH,
      "Emulation.setFocusEmulationEnabled": () => {
        throw new Error("socket is dead");
      },
      "Target.closeTarget": () => {
        throw new Error("socket is dead");
      },
    });
    // The failing emulation call is at attach time too, so attach must survive it.
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.close()).resolves.toBeUndefined();
  });

  it("refuses further commands once the tab detaches underneath it, retryably", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");

    cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });

    await expect(tab.send("Runtime.evaluate")).rejects.toBeInstanceOf(CapabilityError);
    // A tab that crashed or navigated away from us can come back on a fresh attach.
    await expect(tab.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "TAB_DETACHED",
      retryable: true,
    });
  });

  it("refuses further commands after its own close, and not retryably", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");
    await tab.close();

    // The tab we closed ourselves is the one death this layer is certain about;
    // retryable here would put a back-off loop into a permanent spin.
    await expect(tab.send("Runtime.evaluate")).rejects.toMatchObject({
      code: "TAB_CLOSED",
      retryable: false,
      action: "HALT_AND_NOTIFY",
      exit: 1,
    });
  });

  it("keeps the first cause when a detached tab is then closed", async () => {
    const cdp = new FakeCdp(ATTACH);
    const tab = await WorkerTab.attach(cdp, "T1");

    cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } });
    await tab.close();

    await expect(tab.send("Runtime.evaluate")).rejects.toMatchObject({ code: "TAB_DETACHED" });
  });

});

/**
 * The other property that is safety rather than orchestration: a page that never
 * fires its load event must not burn a metered page load (D302). LinkedIn's
 * activity feed is exactly that page, and a live check cannot pin the boundary —
 * it either loads or it does not.
 *
 * `readyState` answers come from a scripted queue, so each test states the exact
 * sequence Chrome reports and asserts what the wait did with it.
 */
function readyStates(...states: string[]) {
  const queue = [...states];
  return () => ({ result: { value: queue.length > 1 ? queue.shift()! : queue[0]! } });
}

const NAV = { ...ATTACH, "Page.navigate": () => ({}) };

describe("WorkerTab.navigate", () => {
  it("settles on complete immediately, without waiting out the interactive grace", async () => {
    const cdp = new FakeCdp({ ...NAV, "Runtime.evaluate": readyStates("complete") });
    const tab = await WorkerTab.attach(cdp, "T1");

    const started = Date.now();
    const nav = await tab.navigate("https://www.linkedin.com/in/x/");

    expect(nav.settledOn).toBe("complete");
    // The grace period is 10s; a complete page must not have paid any of it.
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("settles on interactive once it has held, instead of timing out", async () => {
    const cdp = new FakeCdp({ ...NAV, "Runtime.evaluate": readyStates("loading", "interactive") });
    const tab = await WorkerTab.attach(cdp, "T1");

    // A short grace so the test is fast; the boundary is the same one production
    // uses, just parameterised through the timeout.
    const nav = await tab.navigate("https://www.linkedin.com/in/x/recent-activity/all/", 60_000);

    expect(nav.settledOn).toBe("interactive");
    expect(nav.readyState).toBe("interactive");
    expect(nav.waitedMs).toBeGreaterThanOrEqual(0);
  }, 30_000);

  it("still times out when the page never leaves loading", async () => {
    const cdp = new FakeCdp({ ...NAV, "Runtime.evaluate": readyStates("loading") });
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.navigate("https://www.linkedin.com/in/x/", 400)).rejects.toMatchObject({
      code: "TAB_NAVIGATE_TIMEOUT",
    });
  });

  it("restarts the interactive clock when the document goes back to loading", async () => {
    // interactive, then a client-side navigation drops it back to loading and it
    // never returns: the earlier interactive run must not be credited.
    const cdp = new FakeCdp({
      ...NAV,
      "Runtime.evaluate": readyStates("interactive", "interactive", "loading"),
    });
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.navigate("https://www.linkedin.com/in/x/", 1_500)).rejects.toMatchObject({
      code: "TAB_NAVIGATE_TIMEOUT",
    });
  });

  it("fails immediately on a dead tab instead of waiting out the deadline", async () => {
    // The permalink run's real failure: the CDP socket died, every readyState
    // poll threw, and the wait reported TAB_NAVIGATE_TIMEOUT 45s later for a
    // problem that had nothing to do with the page.
    // The tab has to die *after* `Page.navigate` is accepted, or the send itself
    // refuses and the polling loop — the thing under test — is never entered.
    const cdp: FakeCdp = new FakeCdp({
      ...NAV,
      "Page.navigate": () => {
        setTimeout(
          () => cdp.emit({ method: "Target.detachedFromTarget", params: { sessionId: "S1" } }),
          0,
        );
        return {};
      },
    });
    const tab = await WorkerTab.attach(cdp, "T1");

    const started = Date.now();
    await expect(tab.navigate("https://www.linkedin.com/in/x/", 30_000)).rejects.toMatchObject({
      code: "TAB_DETACHED",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("keeps waiting through an ordinary mid-navigation context swap", async () => {
    // The other side of the same rule: a throwing evaluate that is *not* one of
    // the unrecoverable codes must still be treated as "not ready yet".
    let calls = 0;
    const cdp = new FakeCdp({
      ...NAV,
      "Runtime.evaluate": () => {
        calls += 1;
        if (calls < 3) throw new Error("Cannot find context with specified id");
        return { result: { value: "complete" } };
      },
    });
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.navigate("https://www.linkedin.com/in/x/", 10_000)).resolves.toMatchObject({
      settledOn: "complete",
    });
  });

  it("reports a navigation Chrome refused rather than waiting on it", async () => {
    const cdp = new FakeCdp({ ...ATTACH, "Page.navigate": () => ({ errorText: "net::ERR_ABORTED" }) });
    const tab = await WorkerTab.attach(cdp, "T1");

    await expect(tab.navigate("https://www.linkedin.com/in/x/")).rejects.toMatchObject({
      code: "TAB_NAVIGATE_FAILED",
    });
  });
});
