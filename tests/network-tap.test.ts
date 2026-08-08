import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CdpEvent } from "../src/core/cdp/client.js";
import { RawArchive, type ArchivedCapture, type CaptureInput } from "../src/core/archive/raw.js";
import type { EventFields, EventName } from "../src/core/run/events.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import { NetworkTap, type TapTransport } from "../src/core/tap/network-tap.js";

/**
 * Everything here is offline. The tap is driven by synthetic CDP event
 * sequences — which is the only way to test the properties that matter, since
 * the failure modes are all orderings (finish before response, a body evicted
 * between the two, a stop landing mid-fetch) that a live page produces rarely
 * and unrepeatably.
 */

const SESSION = "S1";
const OTHER_SESSION = "S2";

type Call = { method: string; params: Record<string, unknown>; sessionId?: string };

class FakeCdp implements TapTransport {
  readonly calls: Call[] = [];
  readonly #listeners = new Set<(e: CdpEvent) => void>();
  /** Per-requestId body replies; a function may throw to simulate an evicted buffer. */
  bodies = new Map<string, () => { body: string; base64Encoded: boolean }>();

  get methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  async send<T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    this.calls.push({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) });
    if (method === "Network.getResponseBody") {
      const reply = this.bodies.get(String(params["requestId"]));
      if (!reply) throw new Error("No resource with given identifier found");
      return reply() as T;
    }
    return {} as T;
  }

  on(listener: (e: CdpEvent) => void) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** `null` emits a browser-level event with no sessionId at all — passing an
   *  explicit `undefined` would silently fall back to the default parameter. */
  emit(method: string, params: Record<string, unknown>, sessionId: string | null = SESSION): void {
    for (const l of [...this.#listeners]) l({ method, params, ...(sessionId !== null ? { sessionId } : {}) });
  }

  /** The full happy sequence for one response. */
  respond(requestId: string, url: string, body: string, status = 200): void {
    this.bodies.set(requestId, () => ({ body, base64Encoded: false }));
    this.emit("Network.requestWillBeSent", { requestId, request: { url, method: "GET" } });
    this.emit("Network.responseReceived", {
      requestId,
      response: { url, status, mimeType: "application/json" },
    });
    this.emit("Network.loadingFinished", { requestId });
  }
}

class FakeEvents {
  readonly logged: { event: EventName; fields: EventFields }[] = [];
  log(event: EventName, fields: EventFields = {}) {
    this.logged.push({ event, fields });
    return undefined as never;
  }
  named(event: EventName) {
    return this.logged.filter((l) => l.event === event);
  }
}

const dirs: string[] = [];
function tempArchive(): RawArchive {
  const dir = mkdtempSync(join(tmpdir(), "tap-archive-"));
  dirs.push(dir);
  return new RawArchive(dir);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function build(o: { archive?: { archive(i: CaptureInput): Promise<ArchivedCapture> } } = {}) {
  const cdp = new FakeCdp();
  const events = new FakeEvents();
  const archive = o.archive ?? tempArchive();
  const tap = new NetworkTap({ cdp, sessionId: SESSION, archive, events });
  tap.watch({ name: "profile", match: "salesApiProfiles" });
  tap.start();
  return { cdp, events, archive, tap };
}

describe("NetworkTap capture", () => {
  it("captures a watched response and archives it before handing it over", async () => {
    const { cdp, tap, archive } = build();

    cdp.respond("R1", "https://www.linkedin.com/sales-api/salesApiProfiles/123", '{"a":1}');
    await tap.drain();

    const captures = tap.captures();
    expect(captures).toHaveLength(1);
    expect(captures[0]!.pattern).toBe("profile");
    expect(captures[0]!.status).toBe(200);
    expect(captures[0]!.method).toBe("GET");
    expect(captures[0]!.body).toBe('{"a":1}');

    // The body is on disk, not merely promised: the capture is only delivered
    // after the archive write returned (D2).
    const onDisk = await (archive as RawArchive).list();
    expect(onDisk).toHaveLength(1);
    expect(await (archive as RawArchive).readText(onDisk[0]!)).toBe('{"a":1}');
    expect(captures[0]!.archived.path).toBe(onDisk[0]!.path);
  });

  it("logs a capture.hit carrying the shape hash and archive file", async () => {
    const { cdp, tap, events } = build();

    cdp.respond("R1", "https://x/salesApiProfiles/1", '{"a":1}');
    await tap.drain();

    const hits = events.named("capture.hit");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fields.detail).toMatchObject({
      pattern: "profile",
      status: 200,
      request_id: "R1",
      shape_hash: tap.captures()[0]!.archived.shapeHash,
      file: tap.captures()[0]!.archived.file,
    });
  });

  it("ignores an unwatched response and never asks Chrome for its body", async () => {
    const { cdp, tap } = build();

    cdp.respond("R1", "https://www.linkedin.com/static/logo.png", "binary");
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
    expect(cdp.methods).not.toContain("Network.getResponseBody");
  });

  it("never enables a CDP domain — the tab owns the attach surface (D8)", async () => {
    const { cdp, tap } = build();

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(cdp.methods.filter((m) => m.endsWith(".enable"))).toEqual([]);
    expect(new Set(cdp.methods)).toEqual(new Set(["Network.getResponseBody"]));
  });

  it("scopes to the worker tab session — another target's traffic never leaks in", async () => {
    const { cdp, tap } = build();
    const url = "https://x/salesApiProfiles/1";

    cdp.bodies.set("R1", () => ({ body: "{}", base64Encoded: false }));
    cdp.emit("Network.responseReceived", { requestId: "R1", response: { url, status: 200 } }, OTHER_SESSION);
    cdp.emit("Network.loadingFinished", { requestId: "R1" }, OTHER_SESSION);
    // Browser-level events carry no sessionId at all.
    cdp.emit("Network.responseReceived", { requestId: "R2", response: { url, status: 200 } }, null);
    cdp.emit("Network.loadingFinished", { requestId: "R2" }, null);
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
    expect(cdp.methods).not.toContain("Network.getResponseBody");
  });

  it("captures when loadingFinished arrives before responseReceived", async () => {
    const { cdp, tap } = build();
    const url = "https://x/salesApiProfiles/1";

    cdp.bodies.set("R1", () => ({ body: '{"out":"of order"}', base64Encoded: false }));
    cdp.emit("Network.requestWillBeSent", { requestId: "R1", request: { url, method: "GET" } });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    cdp.emit("Network.responseReceived", { requestId: "R1", response: { url, status: 200 } });
    await tap.drain();

    expect(tap.captures()).toHaveLength(1);
    expect(tap.captures()[0]!.body).toBe('{"out":"of order"}');
  });

  it("does not fetch a body twice when finish arrives late as well as early", async () => {
    const { cdp, tap } = build();
    const url = "https://x/salesApiProfiles/1";

    cdp.bodies.set("R1", () => ({ body: "{}", base64Encoded: false }));
    cdp.emit("Network.requestWillBeSent", { requestId: "R1", request: { url, method: "GET" } });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    cdp.emit("Network.responseReceived", { requestId: "R1", response: { url, status: 200 } });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    await tap.drain();

    expect(tap.captures()).toHaveLength(1);
    expect(cdp.methods.filter((m) => m === "Network.getResponseBody")).toHaveLength(1);
  });

  it("decodes a base64 body and archives the exact bytes", async () => {
    const { cdp, tap, archive } = build();
    const text = '{"emoji":"🦷"}';

    cdp.bodies.set("R1", () => ({ body: Buffer.from(text, "utf8").toString("base64"), base64Encoded: true }));
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    await tap.drain();

    expect(tap.captures()[0]!.body).toBe(text);
    const onDisk = await (archive as RawArchive).list();
    expect(await (archive as RawArchive).readText(onDisk[0]!)).toBe(text);
  });

  // D310: `skipUTF8Validation` keeps the connection alive through a body that is
  // not valid UTF-8, but the string Chrome hands back has already had the bad
  // bytes replaced with U+FFFD. Raw-first (D2) then holds a body that is not
  // byte-exact, and the only unacceptable version of that is a silent one.
  it("flags a body that decoded lossily, and never flags a clean one", async () => {
    const { cdp, tap, archive } = build();

    cdp.bodies.set("R1", () => ({ body: `{"name":"caf�"}`, base64Encoded: false }));
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    await tap.drain();

    cdp.respond("R2", "https://x/salesApiProfiles/2", '{"name":"café 🦷"}');
    await tap.drain();

    const [lossy, clean] = tap.captures();
    expect(lossy!.lossyUtf8).toBe(true);
    expect(clean!.lossyUtf8).toBeUndefined();

    // It survives to disk: a parser drift chased months later must be able to
    // tell "LinkedIn changed" from "we lost bytes reading it".
    const onDisk = await (archive as RawArchive).list();
    expect(onDisk[0]!.lossyUtf8).toBe(true);
    expect(onDisk[1]!.lossyUtf8).toBeUndefined();
  });

  it("does not flag a base64 body, whose bytes are exact by construction", async () => {
    const { cdp, tap } = build();
    // A body that legitimately contains U+FFFD: base64 carries the bytes
    // verbatim, so nothing was lost and nothing should be flagged.
    const text = `{"glyph":"�"}`;

    cdp.bodies.set("R1", () => ({ body: Buffer.from(text, "utf8").toString("base64"), base64Encoded: true }));
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    await tap.drain();

    expect(tap.captures()[0]!.body).toBe(text);
    expect(tap.captures()[0]!.lossyUtf8).toBeUndefined();
  });

  it("attributes a response to every pattern that matches it", async () => {
    const { cdp, tap } = build();
    tap.watch({ name: "any-sales-api", match: /sales-api/ });

    cdp.respond("R1", "https://www.linkedin.com/sales-api/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.captures()[0]!.patterns).toEqual(["profile", "any-sales-api"]);
    expect(tap.captures()[0]!.pattern).toBe("profile");
  });

  it("stops matching a pattern once it is unwatched", async () => {
    const { cdp, tap } = build();
    tap.unwatch("profile");

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
  });

  it("refuses a duplicate pattern name rather than silently replacing one", () => {
    const { tap } = build();
    expect(() => tap.watch({ name: "profile", match: "other" })).toThrow(CapabilityError);
  });

  it("filters captures by pattern", async () => {
    const { cdp, tap } = build();
    tap.watch({ name: "search", match: "salesApiLeadSearch" });

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    cdp.respond("R2", "https://x/salesApiLeadSearch?q=1", "{}");
    await tap.drain();

    expect(tap.captures("profile").map((c) => c.requestId)).toEqual(["R1"]);
    expect(tap.captures("search").map((c) => c.requestId)).toEqual(["R2"]);
    expect(tap.captures()).toHaveLength(2);
  });
});

describe("NetworkTap misses", () => {
  it("records a miss, not a crash, when the body is gone from the buffer", async () => {
    const { cdp, tap, events } = build();

    // No entry in `bodies`: getResponseBody rejects the way an evicted buffer does.
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
    expect(tap.misses()).toHaveLength(1);
    expect(tap.misses()[0]!.reason).toBe("body-unavailable");
    expect(tap.misses()[0]!.pattern).toBe("profile");
    expect(events.named("capture.miss")).toHaveLength(1);
    expect(events.named("capture.miss")[0]!.fields.level).toBe("warn");
  });

  it("records a miss when the request itself fails to load", async () => {
    const { cdp, tap } = build();

    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFailed", { requestId: "R1", errorText: "net::ERR_ABORTED" });
    await tap.drain();

    expect(tap.misses()[0]!.reason).toBe("loading-failed");
    expect(tap.misses()[0]!.error).toContain("ERR_ABORTED");
    expect(tap.captures()).toHaveLength(0);
  });

  it("records a miss when loadingFailed arrives before the response", async () => {
    const { cdp, tap } = build();

    cdp.emit("Network.requestWillBeSent", {
      requestId: "R1",
      request: { url: "https://x/salesApiProfiles/1", method: "GET" },
    });
    cdp.emit("Network.loadingFailed", { requestId: "R1", errorText: "net::ERR_ABORTED" });
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    await tap.drain();

    expect(tap.misses()).toHaveLength(1);
    expect(tap.misses()[0]!.reason).toBe("loading-failed");
    expect(tap.captures()).toHaveLength(0);
  });

  it("records a miss, not a crash, when the archive write fails", async () => {
    const archive = {
      archive: async () => {
        throw new CapabilityError({
          code: "ARCHIVE_WRITE_FAILED", exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY",
          retryable: false, message: "disk full",
        });
      },
    };
    const { cdp, tap } = build({ archive });

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
    expect(tap.misses()[0]!.reason).toBe("archive-failed");
    expect(tap.misses()[0]!.error).toContain("disk full");
  });

  it("keeps an archive warning on the capture instead of turning it into a miss", async () => {
    const archive = {
      archive: async (i: CaptureInput): Promise<ArchivedCapture> => ({
        seq: 0, id: "f", file: "f", path: "/tmp/f", shapeHash: "abc",
        url: i.url, status: i.status, capturedAt: "now", bytes: 2,
        warning: { code: "ARCHIVE_SIDECAR_FAILED" as const, message: "sidecar lost" },
      }),
    };
    const { cdp, tap } = build({ archive });

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.captures()).toHaveLength(1);
    expect(tap.captures()[0]!.archived.warning?.code).toBe("ARCHIVE_SIDECAR_FAILED");
    expect(tap.misses()).toHaveLength(0);
  });
});

describe("NetworkTap.waitFor", () => {
  it("resolves on the next matching capture", async () => {
    const { cdp, tap } = build();

    const pending = tap.waitFor("profile", { timeoutMs: 1_000 });
    cdp.respond("R1", "https://x/salesApiProfiles/1", '{"ok":true}');

    const capture = await pending;
    expect(capture.requestId).toBe("R1");
    expect(capture.body).toBe('{"ok":true}');
  });

  it("waits for the next one by default, ignoring what was already captured", async () => {
    const { cdp, tap } = build();

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    const pending = tap.waitFor("profile", { timeoutMs: 1_000 });
    cdp.respond("R2", "https://x/salesApiProfiles/2", "{}");
    expect((await pending).requestId).toBe("R2");
  });

  it("resolves immediately from history when told where to look back to", async () => {
    const { cdp, tap } = build();

    const mark = tap.cursor;
    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    // The real race this exists for: the response lands between the click that
    // caused it and the caller getting around to awaiting it.
    expect((await tap.waitFor("profile", { since: mark, timeoutMs: 1_000 })).requestId).toBe("R1");
  });

  it("fails as a bounded transient wait when nothing matches in time", async () => {
    const { tap } = build();

    const err = await tap.waitFor("profile", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    const e = err as CapabilityError;
    expect(e.code).toBe("CAPTURE_TIMEOUT");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.retryable).toBe(true);
  });

  it("names the misses it saw for that pattern when it times out", async () => {
    const { cdp, tap } = build();

    const pending = tap.waitFor("profile", { timeoutMs: 40 });
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });

    const err = (await pending.catch((e: unknown) => e)) as CapabilityError;
    expect(err.code).toBe("CAPTURE_TIMEOUT");
    expect(err.message).toContain("1 miss");
  });

  it("looks back over history for an inline pattern too", async () => {
    const { cdp, tap } = build();

    const mark = tap.cursor;
    cdp.respond("R1", "https://x/salesApiProfiles/9", "{}");
    await tap.drain();

    // The capture landed (under the "profile" watch) before this pattern
    // existed, so it carries none of this pattern's names — a lookback that
    // matched on recorded names would quietly degrade into "wait for the next
    // one" and time out on a body already sitting in the archive.
    const capture = await tap.waitFor(
      { name: "one-off", match: /salesApiProfiles/ },
      { since: mark, timeoutMs: 1_000 },
    );
    expect(capture.requestId).toBe("R1");
  });

  it("accepts an inline pattern and unregisters it once settled", async () => {
    const { cdp, tap } = build();

    const pending = tap.waitFor({ name: "one-off", match: "salesApiCompany" }, { timeoutMs: 1_000 });
    cdp.respond("R1", "https://x/salesApiCompany/9", "{}");
    expect((await pending).pattern).toBe("one-off");
    expect(tap.watching).toEqual(["profile"]);
  });

  it("unregisters an inline pattern when the wait times out", async () => {
    const { tap } = build();

    await tap.waitFor({ name: "one-off", match: "nope" }, { timeoutMs: 20 }).catch(() => undefined);
    expect(tap.watching).toEqual(["profile"]);
  });

  it("rejects an unregistered pattern name as a usage error", async () => {
    const { tap } = build();

    const err = (await tap.waitFor("nobody", { timeoutMs: 20 }).catch((e: unknown) => e)) as CapabilityError;
    expect(err.code).toBe("TAP_UNKNOWN_PATTERN");
    expect(err.retryable).toBe(false);
  });

  it("wakes every waiter that matches the same capture", async () => {
    const { cdp, tap } = build();
    tap.watch({ name: "any-sales-api", match: /sales-api/ });

    const a = tap.waitFor("profile", { timeoutMs: 1_000 });
    const b = tap.waitFor("any-sales-api", { timeoutMs: 1_000 });
    cdp.respond("R1", "https://www.linkedin.com/sales-api/salesApiProfiles/1", "{}");

    expect((await a).requestId).toBe("R1");
    expect((await b).requestId).toBe("R1");
  });
});

describe("NetworkTap.stop", () => {
  it("stops capturing", async () => {
    const { cdp, tap } = build();

    tap.stop();
    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.running).toBe(false);
    expect(tap.captures()).toHaveLength(0);
    expect(cdp.methods).not.toContain("Network.getResponseBody");
  });

  it("fails pending waiters instead of leaving them hanging", async () => {
    const { tap } = build();

    const pending = tap.waitFor("profile", { timeoutMs: 5_000 });
    tap.stop();

    const err = (await pending.catch((e: unknown) => e)) as CapabilityError;
    expect(err.code).toBe("TAP_STOPPED");
    // We stopped it ourselves, so no back-off can change the outcome — the same
    // reasoning as CDP_CLIENT_CLOSED and TAB_CLOSED.
    expect(err.retryable).toBe(false);
    expect(err.exit).toBe(EXIT.GENERIC);
  });

  it("keeps what it already captured readable after stopping", async () => {
    const { cdp, tap } = build();

    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();
    tap.stop();

    expect(tap.captures()).toHaveLength(1);
  });

  it("can be restarted, and starting twice is a no-op", async () => {
    const { cdp, tap } = build();

    tap.start(); // already running
    tap.stop();
    tap.start();
    cdp.respond("R1", "https://x/salesApiProfiles/1", "{}");
    await tap.drain();

    expect(tap.captures()).toHaveLength(1);
  });

  it("does not deliver a capture whose body was still in flight when it stopped", async () => {
    const { cdp, tap } = build();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    cdp.bodies.set("R1", () => ({ body: "{}", base64Encoded: false }));
    const slow = cdp.send.bind(cdp);
    cdp.send = (async (m: string, p: Record<string, unknown> = {}, s?: string) => {
      if (m === "Network.getResponseBody") await gate;
      return slow(m, p, s);
    }) as typeof cdp.send;

    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    cdp.emit("Network.loadingFinished", { requestId: "R1" });
    tap.stop();
    release();
    await tap.drain();

    expect(tap.captures()).toHaveLength(0);
  });
});

describe("NetworkTap bookkeeping", () => {
  it("remembers no early finish at all for traffic it does not watch", async () => {
    const { cdp, tap } = build();

    // A LinkedIn feed issues thousands of these. None of them are ours, and
    // none of them may take up a slot in the early-finish map.
    for (let i = 0; i < 2_000; i++) cdp.emit("Network.loadingFinished", { requestId: `R${i}` });
    await tap.drain();

    expect(tap.stats().pendingFinish).toBe(0);
  });

  it("keeps our own early finish through a flood of unwatched traffic", async () => {
    const { cdp, tap } = build();
    const url = "https://x/salesApiProfiles/1";

    // The silent-drop regression: our finish arrives first, thousands of
    // unrelated finishes follow, and only then does our response show up. If
    // the flood can evict our entry, this response is lost with no capture, no
    // miss, and a waitFor that times out reporting nothing went wrong.
    cdp.bodies.set("OURS", () => ({ body: '{"kept":true}', base64Encoded: false }));
    cdp.emit("Network.requestWillBeSent", { requestId: "OURS", request: { url, method: "GET" } });
    cdp.emit("Network.loadingFinished", { requestId: "OURS" });
    for (let i = 0; i < 2_000; i++) cdp.emit("Network.loadingFinished", { requestId: `R${i}` });
    cdp.emit("Network.responseReceived", { requestId: "OURS", response: { url, status: 200 } });
    await tap.drain();

    expect(tap.captures()).toHaveLength(1);
    expect(tap.captures()[0]!.body).toBe('{"kept":true}');
    expect(tap.misses()).toHaveLength(0);
  });

  it("accounts for a matched response still in flight when it stops", async () => {
    const { cdp, tap } = build();

    // Also the residual of the early-finish gate: a request with no
    // requestWillBeSent of its own whose finish beat its response parks here.
    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    tap.stop();
    await tap.drain();

    expect(tap.misses()).toHaveLength(1);
    expect(tap.misses()[0]!.reason).toBe("abandoned");
  });

  it("caps matched responses awaiting an outcome, and says so when it drops one", async () => {
    const { cdp, tap } = build();

    // Matched responses that never get a loading outcome — a navigation
    // mid-flight does this. Unbounded, this map grows for the life of the run.
    for (let i = 0; i < 600; i++) {
      cdp.emit("Network.responseReceived", {
        requestId: `R${i}`,
        response: { url: `https://x/salesApiProfiles/${i}`, status: 200 },
      });
    }
    await tap.drain();

    expect(tap.stats().inflight).toBeLessThanOrEqual(500);
    // Dropped, but never silently: an untracked response would otherwise be
    // indistinguishable from one that never arrived.
    expect(tap.misses()).toHaveLength(100);
    expect(tap.misses()[0]!.reason).toBe("abandoned");
    expect(tap.misses()[0]!.requestId).toBe("R0");
  });

  it("reports what it is still waiting on", async () => {
    const { cdp, tap } = build();

    cdp.emit("Network.responseReceived", {
      requestId: "R1",
      response: { url: "https://x/salesApiProfiles/1", status: 200 },
    });
    const pending = tap.waitFor("profile", { timeoutMs: 50 });

    expect(tap.stats()).toMatchObject({ inflight: 1, waiters: 1, captures: 0, misses: 0 });
    await pending.catch(() => undefined);
  });
});
