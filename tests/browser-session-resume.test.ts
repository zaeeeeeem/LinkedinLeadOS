import { describe, expect, it, vi } from "vitest";
import { BrowserSession } from "../src/core/session/session.js";
import type { ChromeEndpoint } from "../src/core/chrome/launcher.js";
import type { CdpEvent } from "../src/core/cdp/client.js";

function session(targets: { targetId: string; type: string; url: string; title: string }[]) {
  const sent: string[] = [];
  const client = {
    send: vi.fn(async (method: string) => {
      sent.push(method);
      if (method === "Target.getTargets") return { targetInfos: targets };
      if (method === "Target.attachToTarget") return { sessionId: "session-resumed" };
      return {};
    }),
    on: (_listener: (event: CdpEvent) => void) => () => {},
    close: vi.fn(),
  };
  const endpoint: ChromeEndpoint = {
    port: 9223,
    wsUrl: "ws://127.0.0.1:9223/devtools/browser/test",
    launched: false,
  };
  const Constructor = BrowserSession as unknown as new (endpoint: ChromeEndpoint, client: object) => BrowserSession;
  return { browser: new Constructor(endpoint, client), client, sent };
}

describe("BrowserSession hard-kill resume", () => {
  it("reattaches the exact recorded page target without creating a replacement", async () => {
    const { browser, sent } = session([{ targetId: "owned", type: "page", url: "about:blank", title: "" }]);
    const tab = await browser.openWorkerTab(undefined, "owned");
    expect(tab.targetId).toBe("owned");
    expect(sent).toContain("Target.attachToTarget");
    expect(sent).not.toContain("Target.createTarget");
  });

  it("refuses when the recorded target is gone instead of reloading a proved page", async () => {
    const { browser, sent } = session([]);
    await expect(browser.openWorkerTab(undefined, "gone")).rejects.toMatchObject({
      code: "RUN_WORKER_TARGET_UNAVAILABLE",
      retryable: false,
    });
    expect(sent).not.toContain("Target.createTarget");
  });
});
