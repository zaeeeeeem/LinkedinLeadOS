import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTOMATION_PORT,
  PERSONAL_CHROME_PORT,
  CHROME_PROFILE_DIR,
} from "../src/core/chrome/constants.js";
import { discoverBrowserWsUrl, hasLiveTarget, isChromeUp } from "../src/core/chrome/discovery.js";
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

/**
 * What a windowless Chrome really serves: `/json/list` is *not* empty, it just
 * has no `page` in it. Copied from the shapes the live automation Chrome
 * returned on 2026-08-11.
 */
const windowlessListBody = JSON.stringify([
  { id: "IFRAME0", type: "iframe", url: "chrome-untrusted://new-tab-page/one-google-bar" },
  { id: "UI0", type: "browser_ui", url: "chrome://omnibox-popup.top-chrome/" },
  { id: "SW0", type: "service_worker", url: "chrome-extension://abc/sw.js" },
]);

/** One page target, shaped as Chrome's real `/json/list` element. */
const listBody = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: `TARGET${i}`,
      type: "page",
      title: "LinkedIn",
      url: "https://www.linkedin.com/feed/",
      webSocketDebuggerUrl: `ws://127.0.0.1:9223/devtools/page/TARGET${i}`,
    })),
  );

/**
 * A Chrome that answers both discovery endpoints. `targets: 0` is the B5
 * condition (D122): every window closed, `/json/version` still fine,
 * `/json/list` empty, every browser-level command on it broken.
 */
const chromeServing = (ws: string, targets: number) => (path: string) => {
  if (path === "/json/version") return { status: 200, body: versionBody(ws) };
  if (path === "/json/list") return { status: 200, body: listBody(targets) };
  return { status: 404, body: "" };
};

/**
 * A binary path that cannot exist, so any fall-through to the launch path
 * fails loudly at `CHROME_BINARY_MISSING` instead of spawning a real Chrome
 * onto the operator's automation profile mid-test.
 */
const NO_BINARY = "/nonexistent/Google Chrome";

/** A throwaway user-data-dir, so a launch-path test never touches the real
 *  automation profile at ~/.linkedin-os/chrome-profile. */
const profileDirs: string[] = [];
async function tempProfile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "linkedin-os-launch-"));
  profileDirs.push(dir);
  return dir;
}

/**
 * A stand-in for the Chrome binary: a script that ignores the launch args and
 * stays alive. It must not exit, or the launcher's `exit` branch reports a
 * dead process instead of exercising the wait loop under test.
 */
async function fakeBrowserBinary(): Promise<string> {
  const dir = await tempProfile();
  const path = join(dir, "fake-chrome.sh");
  await writeFile(path, "#!/bin/sh\nsleep 30\n");
  await chmod(path, 0o755);
  return path;
}

afterEach(async () => {
  if (server) await new Promise<void>((ok) => server!.close(() => ok()));
  server = undefined;
  while (profileDirs.length > 0) await rm(profileDirs.pop()!, { recursive: true, force: true });
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

describe("hasLiveTarget", () => {
  it("is true when /json/list returns at least one target", async () => {
    const port = await fake(chromeServing("ws://127.0.0.1:9223/devtools/browser/x", 2));
    expect(await hasLiveTarget(port)).toBe(true);
  });

  it("is false for the B5 condition: /json/version fine, /json/list empty", async () => {
    const port = await fake(chromeServing("ws://127.0.0.1:9223/devtools/browser/x", 0));
    expect(await hasLiveTarget(port)).toBe(false);
  });

  // D410, and the reason the guard existed yet did not fire: a windowless
  // Chrome serves iframes, browser_ui and service workers. "Non-empty" was
  // never the question; "is there a browser context to manage" was.
  it("is false when /json/list has targets but none of them is a page", async () => {
    const port = await fake((path) =>
      path === "/json/version"
        ? { status: 200, body: versionBody("ws://127.0.0.1:9223/devtools/browser/x") }
        : { status: 200, body: windowlessListBody },
    );
    expect(await hasLiveTarget(port)).toBe(false);
  });

  it("is false, never a throw, on a dead port or a non-array body", async () => {
    expect(await hasLiveTarget(await deadPort())).toBe(false);
    if (server) await new Promise<void>((ok) => server!.close(() => ok()));
    const port = await fake(() => ({ status: 200, body: JSON.stringify({ not: "an array" }) }));
    expect(await hasLiveTarget(port)).toBe(false);
  });

  it("still refuses port 9222 — the guard is not a probe result", async () => {
    const e = (await hasLiveTarget(PERSONAL_CHROME_PORT).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_FORBIDDEN_PORT");
  });
});

describe("ensureChrome", () => {
  it("reuses an already-listening endpoint that still has a target, without spawning", async () => {
    const ws = "ws://127.0.0.1:9223/devtools/browser/reused";
    const port = await fake(chromeServing(ws, 1));
    // A binary that cannot exist: if this took the launch path at all it would
    // throw CHROME_BINARY_MISSING rather than quietly reusing.
    const ep = await ensureChrome({ port, binary: NO_BINARY });
    expect(ep).toEqual({ port, wsUrl: ws, launched: false });
  });

  it("refuses to reuse a Chrome with an empty /json/list and falls through to launch (B5)", async () => {
    // The whole B5 bug: /json/version answers, so the old code reused this
    // endpoint and every browser-level command then failed with a retryable
    // code no retry could fix. Reaching CHROME_BINARY_MISSING proves the
    // launch path was entered — reverting the guard returns launched:false
    // here instead, and this assertion fails.
    const port = await fake(chromeServing("ws://127.0.0.1:9223/devtools/browser/ghost", 0));
    const e = (await ensureChrome({ port, binary: NO_BINARY }).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_BINARY_MISSING");
  });

  it("refuses to reuse a windowless Chrome whose only targets are iframes and UI (D410)", async () => {
    // The measured production failure: this endpoint was reused and then died
    // at Storage.getCookies with "Browser context management is not supported".
    // Reaching CHROME_BINARY_MISSING proves it now falls through to launch.
    const port = await fake((path) =>
      path === "/json/version"
        ? { status: 200, body: versionBody("ws://127.0.0.1:9223/devtools/browser/ghost") }
        : { status: 200, body: windowlessListBody },
    );
    const e = (await ensureChrome({ port, binary: NO_BINARY }).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_BINARY_MISSING");
  });

  it("also falls through when /json/list itself cannot be read — 'cannot tell' is not 'healthy'", async () => {
    const port = await fake((path) =>
      path === "/json/version"
        ? { status: 200, body: versionBody("ws://127.0.0.1:9223/devtools/browser/x") }
        : { status: 500, body: "" },
    );
    const e = (await ensureChrome({ port, binary: NO_BINARY }).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_BINARY_MISSING");
  });

  // D410. The launch path is the only one that can watch a Chrome mid-start,
  // and it used to return the instant `/json/version` answered — a few hundred
  // ms before the first target exists. In that window every browser-level
  // command fails the B5 way, which is how preflight died at
  // `Storage.getCookies` with a retryable code no in-process retry could fix.
  it("waits, after launching, for a target to exist and not merely for the port", async () => {
    const ws = "ws://127.0.0.1:9223/devtools/browser/started";
    let listCalls = 0;
    // Answers /json/version immediately; the first two /json/list polls are the
    // startup window, then a target appears.
    const port = await fake((path) => {
      if (path === "/json/version") return { status: 200, body: versionBody(ws) };
      if (path === "/json/list") {
        listCalls += 1;
        return { status: 200, body: listBody(listCalls > 2 ? 1 : 0) };
      }
      return { status: 404, body: "" };
    });
    // `sleep` stands in for Chrome: it exists, spawns, and does not exit while
    // the wait loop runs, so nothing here depends on a real browser.
    const ep = await ensureChrome({ port, binary: await fakeBrowserBinary(), profileDir: await tempProfile(), launchTimeoutMs: 5_000 });
    expect(ep).toEqual({ port, wsUrl: ws, launched: true });
    // Returning on the first poll is the bug: it means the port alone decided.
    expect(listCalls).toBeGreaterThan(2);
  });

  it("times out with the real reason when a launched Chrome never gets a target", async () => {
    const port = await fake(chromeServing("ws://127.0.0.1:9223/devtools/browser/never", 0));
    const e = (await ensureChrome({
      port, binary: await fakeBrowserBinary(), profileDir: await tempProfile(), launchTimeoutMs: 800,
    }).catch((x: unknown) => x)) as CapabilityError;
    expect(e.code).toBe("CHROME_LAUNCH_TIMEOUT");
    // Not "endpoint never answered" — it did answer, and that was the trap.
    expect(e.message).toContain("before Chrome had a single target");
  });

  it("refuses to ever target port 9222", async () => {
    const e = (await ensureChrome({ port: PERSONAL_CHROME_PORT }).catch(
      (x: unknown) => x,
    )) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_FORBIDDEN_PORT");
    expect(e.retryable).toBe(false);
  });

  it("halts rather than backs off when the binary is missing — a retry cannot fix a path", async () => {
    const e = (await ensureChrome({
      port: await deadPort(),
      binary: "/nonexistent/Google Chrome",
    }).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_BINARY_MISSING");
    expect(e.retryable).toBe(false);
    expect(e.action).toBe("HALT_AND_NOTIFY");
  });

  it("fails fast when the browser exits without opening the port, not after the timeout", async () => {
    // /usr/bin/true stands in for the real failure: Chrome handing off to an
    // instance already holding the profile and exiting 0. No Chrome involved.
    const profileDir = await mkdtemp(join(tmpdir(), "linkedin-os-test-"));
    const started = Date.now();
    const e = (await ensureChrome({
      port: await deadPort(),
      binary: "/usr/bin/true",
      profileDir,
      launchTimeoutMs: 10_000,
    }).catch((x: unknown) => x)) as CapabilityError;
    expect(e).toBeInstanceOf(CapabilityError);
    expect(e.code).toBe("CHROME_LAUNCH_FAILED");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain(profileDir);
    expect(Date.now() - started).toBeLessThan(5_000);
    await rm(profileDir, { recursive: true, force: true });
  });
});
