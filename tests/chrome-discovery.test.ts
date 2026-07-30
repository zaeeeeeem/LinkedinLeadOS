import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  AUTOMATION_PORT,
  PERSONAL_CHROME_PORT,
  CHROME_PROFILE_DIR,
} from "../src/core/chrome/constants.js";
import { discoverBrowserWsUrl, isChromeUp } from "../src/core/chrome/discovery.js";
import { ensureChrome } from "../src/core/chrome/launcher.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

let server: Server | undefined;

/** Serves one canned reply on 127.0.0.1 and returns its ephemeral port. */
async function fake(handler: (path: string) => { status: number; body: string }): Promise<number> {
  server = createServer((req, res) => {
    const r = handler(req.url ?? "");
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(r.body);
  });
  await new Promise<void>((ok) => server!.listen(0, "127.0.0.1", ok));
  return (server!.address() as AddressInfo).port;
}

/** A port nothing is listening on: bind one, read it, close it. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

const versionBody = (ws: string) =>
  JSON.stringify({ Browser: "Chrome/151.0.0.0", webSocketDebuggerUrl: ws });

afterEach(async () => {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  server = undefined;
});

describe("chrome constants", () => {
  it("pins the automation port to 9223 and never the personal one", () => {
    expect(AUTOMATION_PORT).toBe(9223);
    expect(PERSONAL_CHROME_PORT).toBe(9222);
    expect(AUTOMATION_PORT).not.toBe(PERSONAL_CHROME_PORT);
  });

  it("pins the dedicated profile directory", () => {
    expect(CHROME_PROFILE_DIR.endsWith("/.linkedin-os/chrome-profile")).toBe(true);
  });
});

describe("discoverBrowserWsUrl", () => {
  it("returns webSocketDebuggerUrl from /json/version", async () => {
    const ws = "ws://127.0.0.1:9223/devtools/browser/abc-123";
    const port = await fake((path) => {
      expect(path).toBe("/json/version");
      return { status: 200, body: versionBody(ws) };
    });
    expect(await discoverBrowserWsUrl(port)).toBe(ws);
  });

  it("throws a retryable transient CapabilityError on a dead port", async () => {
    const port = await deadPort();
    const err = await discoverBrowserWsUrl(port).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    const e = err as CapabilityError;
    expect(e.code).toBe("CHROME_UNREACHABLE");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.retryable).toBe(true);
    expect(e.action).toBe("RETRY_BACKOFF");
  });

  it("throws when the body is valid JSON without webSocketDebuggerUrl", async () => {
    const port = await fake(() => ({ status: 200, body: JSON.stringify({ Browser: "x" }) }));
    const e = (await discoverBrowserWsUrl(port).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_DISCOVERY_MALFORMED");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.retryable).toBe(true);
  });

  it("throws when the body is not JSON at all", async () => {
    const port = await fake(() => ({ status: 200, body: "<html>nope</html>" }));
    const e = (await discoverBrowserWsUrl(port).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_DISCOVERY_MALFORMED");
  });

  it("throws when the endpoint answers non-200 (the chrome://inspect profile 404s)", async () => {
    const port = await fake(() => ({ status: 404, body: "" }));
    const e = (await discoverBrowserWsUrl(port).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_DISCOVERY_MALFORMED");
    expect(e.message).toContain("404");
  });

  it("rejects a non-ws:// debugger URL", async () => {
    const port = await fake(() => ({ status: 200, body: versionBody("http://127.0.0.1/x") }));
    const e = (await discoverBrowserWsUrl(port).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_DISCOVERY_MALFORMED");
  });

  it("refuses port 9222 outright — that is the operator's personal Chrome", async () => {
    const e = (await discoverBrowserWsUrl(PERSONAL_CHROME_PORT).catch(
      (x: unknown) => x,
    )) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_FORBIDDEN_PORT");
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("HALT_AND_NOTIFY");
  });
});

describe("isChromeUp", () => {
  it("is true when /json/version answers with a browser URL", async () => {
    const port = await fake(() => ({
      status: 200,
      body: versionBody("ws://127.0.0.1:9223/devtools/browser/x"),
    }));
    expect(await isChromeUp(port)).toBe(true);
  });

  it("is false on a dead port and never throws", async () => {
    expect(await isChromeUp(await deadPort())).toBe(false);
  });

  it("is false on a malformed reply and never throws", async () => {
    const port = await fake(() => ({ status: 200, body: "garbage" }));
    expect(await isChromeUp(port)).toBe(false);
  });

  it("still throws for port 9222 — the guard is not a probe result", async () => {
    const e = (await isChromeUp(PERSONAL_CHROME_PORT).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_FORBIDDEN_PORT");
  });
});

describe("ensureChrome", () => {
  it("reuses an already-listening endpoint without spawning", async () => {
    const ws = "ws://127.0.0.1:9223/devtools/browser/reused";
    const port = await fake(() => ({ status: 200, body: versionBody(ws) }));
    const ep = await ensureChrome({ port });
    expect(ep).toEqual({ port, wsUrl: ws, launched: false });
  });

  it("refuses to ever target port 9222", async () => {
    const e = (await ensureChrome({ port: PERSONAL_CHROME_PORT }).catch(
      (x: unknown) => x,
    )) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_FORBIDDEN_PORT");
    expect(e.retryable).toBe(false);
  });

  it("fails transiently when the binary is missing rather than hanging", async () => {
    const e = (await ensureChrome({
      port: await deadPort(),
      binary: "/nonexistent/Google Chrome",
    }).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_BINARY_MISSING");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.action).toBe("RETRY_BACKOFF");
  });
});
