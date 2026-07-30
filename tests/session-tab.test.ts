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
