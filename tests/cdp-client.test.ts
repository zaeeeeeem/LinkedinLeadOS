import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { CdpClient } from "../src/core/cdp/client.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

type Incoming = { id?: number; method: string; params?: unknown; sessionId?: string };

type Fake = {
  url: string;
  /** Every frame the client sent, in arrival order. */
  seen: Incoming[];
  /** Push a raw frame to every connected client. */
  push(frame: unknown): void;
  /** Drop the connection the way a dying Chrome does. */
  drop(): void;
  stop(): Promise<void>;
};

let cleanups: Array<() => Promise<void>> = [];

/**
 * A CDP server that is only a WebSocket endpoint speaking the wire format.
 * `reply` decides what (if anything) comes back for each command frame, so a
 * test can answer out of order, answer with a protocol error, or stay silent.
 */
async function fakeCdp(
  reply: (msg: Incoming, sock: WsSocket) => void = (msg, sock) =>
    sock.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } })),
): Promise<Fake> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http });
  const sockets = new Set<WsSocket>();
  const seen: Incoming[] = [];

  wss.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as Incoming;
      seen.push(msg);
      reply(msg, sock);
    });
  });

  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const { port } = http.address() as AddressInfo;

  const fake: Fake = {
    url: `ws://127.0.0.1:${port}/devtools/browser/fake`,
    seen,
    push: (frame) => {
      for (const s of sockets) s.send(JSON.stringify(frame));
    },
    drop: () => {
      for (const s of sockets) s.terminate();
    },
    stop: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.terminate();
        wss.close(() => http.close(() => ok()));
      }),
  };
  cleanups.push(fake.stop);
  return fake;
}

/** A port nothing is listening on: bind one, read it, close it. */
async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

/** Listens but never completes a WebSocket upgrade — the connect timeout case. */
async function blackHole(): Promise<{ url: string }> {
  const http = createServer();
  const hung: Duplex[] = [];
  http.on("upgrade", (_req, sock) => {
    hung.push(sock); // swallow: never respond to the handshake
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  const { port } = http.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((ok) => {
        for (const s of hung) s.destroy();
        http.closeAllConnections();
        http.close(() => ok());
      }),
  );
  return { url: `ws://127.0.0.1:${port}/devtools/browser/blackhole` };
}

const asCapabilityError = (e: unknown): CapabilityError => {
  expect(e).toBeInstanceOf(CapabilityError);
  return e as CapabilityError;
};

afterEach(async () => {
  const pending = cleanups;
  cleanups = [];
  for (const c of pending) await c();
});

describe("CdpClient.connect", () => {
  it("connects to a live endpoint and reports itself alive", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);
    expect(cdp.dead).toBe(false);
    cdp.close();
  });

  it("fails transiently against a dead port", async () => {
    const port = await deadPort();
    const err = await CdpClient.connect(`ws://127.0.0.1:${port}/devtools/browser/x`).catch(
      (e: unknown) => e,
    );
    const e = asCapabilityError(err);
    expect(e.code).toBe("CDP_CONNECT_FAILED");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.retryable).toBe(true);
    expect(e.action).toBe("RETRY_BACKOFF");
  });

  it("gives up on a handshake that never completes, within the connect timeout", async () => {
    const { url } = await blackHole();
    const started = Date.now();
    const err = await CdpClient.connect(url, { connectTimeoutMs: 200 }).catch((e: unknown) => e);
    const e = asCapabilityError(err);
    expect(e.code).toBe("CDP_CONNECT_TIMEOUT");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("CdpClient.send", () => {
  it("matches each reply to its own command, even answered out of order", async () => {
    const held: Array<{ id?: number; method: string }> = [];
    const fake = await fakeCdp((msg, sock) => {
      held.push(msg);
      if (held.length < 2) return; // answer nothing until both are in flight
      for (const m of [...held].reverse()) {
        sock.send(JSON.stringify({ id: m.id, result: { method: m.method } }));
      }
    });
    const cdp = await CdpClient.connect(fake.url);

    const [a, b] = await Promise.all([
      cdp.send<{ method: string }>("First.one"),
      cdp.send<{ method: string }>("Second.two"),
    ]);
    expect(a.method).toBe("First.one");
    expect(b.method).toBe("Second.two");
    cdp.close();
  });

  it("carries sessionId only when one is given", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);

    await cdp.send("Browser.getVersion");
    await cdp.send("Network.enable", {}, "SESSION-1");

    expect(fake.seen[0]?.sessionId).toBeUndefined();
    expect(fake.seen[1]?.sessionId).toBe("SESSION-1");
    expect(fake.seen[1]?.method).toBe("Network.enable");
    cdp.close();
  });

  it("rejects on a protocol error reply and keeps the CDP error as evidence", async () => {
    const fake = await fakeCdp((msg, sock) =>
      sock.send(
        JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: "'Nope.method' wasn't found" },
        }),
      ),
    );
    const cdp = await CdpClient.connect(fake.url);

    const e = asCapabilityError(await cdp.send("Nope.method").catch((x: unknown) => x));
    expect(e.code).toBe("CDP_PROTOCOL_ERROR");
    expect(e.message).toContain("Nope.method");
    expect(e.evidence).toContain("-32601");
    expect(cdp.dead).toBe(false); // one bad command does not kill the connection
    cdp.close();
  });

  it("times out a command the server never answers, and ignores a late reply", async () => {
    let late: (() => void) | undefined;
    const fake = await fakeCdp((msg, sock) => {
      late = () => sock.send(JSON.stringify({ id: msg.id, result: { tooLate: true } }));
    });
    const cdp = await CdpClient.connect(fake.url);

    const e = asCapabilityError(
      await cdp.send("Slow.command", {}, undefined, 100).catch((x: unknown) => x),
    );
    expect(e.code).toBe("CDP_TIMEOUT");
    expect(e.exit).toBe(EXIT.TRANSIENT);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("Slow.command");

    late?.(); // the answer that arrives after we gave up must be dropped silently
    await new Promise((r) => setTimeout(r, 50));
    expect(cdp.dead).toBe(false);
    cdp.close();
  });

  it("rejects a send issued after close", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);
    cdp.close();
    const e = asCapabilityError(await cdp.send("Browser.getVersion").catch((x: unknown) => x));
    expect(e.code).toBe("CDP_CONNECTION_CLOSED");
  });
});

describe("CdpClient events", () => {
  it("delivers events with their sessionId and stops after unsubscribe", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);

    const seen: Array<{ method: string; sessionId?: string }> = [];
    const off = cdp.on((e) => seen.push({ method: e.method, sessionId: e.sessionId }));

    fake.push({
      method: "Network.responseReceived",
      params: { requestId: "R1" },
      sessionId: "SESSION-1",
    });
    await new Promise((r) => setTimeout(r, 50));

    off();
    fake.push({ method: "Network.responseReceived", params: { requestId: "R2" } });
    await new Promise((r) => setTimeout(r, 50));

    expect(seen).toEqual([{ method: "Network.responseReceived", sessionId: "SESSION-1" }]);
    cdp.close();
  });

  it("fans out to every subscriber and isolates one that throws", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);

    const good: string[] = [];
    const listenerErrors: unknown[] = [];
    cdp.onListenerError((e) => listenerErrors.push(e));
    cdp.on(() => {
      throw new Error("bad listener");
    });
    cdp.on((e) => good.push(e.method));

    fake.push({ method: "Network.requestWillBeSent", params: {} });
    await new Promise((r) => setTimeout(r, 50));

    expect(good).toEqual(["Network.requestWillBeSent"]);
    expect(listenerErrors).toHaveLength(1);
    cdp.close();
  });

  it("never delivers command replies as events", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url);
    const seen: string[] = [];
    cdp.on((e) => seen.push(e.method));

    await cdp.send("Browser.getVersion");
    expect(seen).toEqual([]);
    cdp.close();
  });
});

describe("CdpClient connection death", () => {
  it("rejects every pending send and sets the dead flag when the server drops", async () => {
    const fake = await fakeCdp(() => {
      /* never answers */
    });
    const cdp = await CdpClient.connect(fake.url);

    const a = cdp.send("Never.one", {}, undefined, 10_000).catch((e: unknown) => e);
    const b = cdp.send("Never.two", {}, undefined, 10_000).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    fake.drop();

    for (const e of [asCapabilityError(await a), asCapabilityError(await b)]) {
      expect(e.code).toBe("CDP_CONNECTION_CLOSED");
      expect(e.exit).toBe(EXIT.TRANSIENT);
      expect(e.retryable).toBe(true);
    }
    expect(cdp.dead).toBe(true);
  });

  it("dies when the keepalive goes unanswered", async () => {
    const fake = await fakeCdp(() => {
      /* never answers, including the keepalive */
    });
    const cdp = await CdpClient.connect(fake.url, {
      keepaliveIntervalMs: 60,
      keepaliveTimeoutMs: 60,
    });

    await new Promise((r) => setTimeout(r, 400));
    expect(cdp.dead).toBe(true);
    const e = asCapabilityError(await cdp.send("Anything.now").catch((x: unknown) => x));
    expect(e.code).toBe("CDP_CONNECTION_DEAD");
    expect(e.retryable).toBe(true);
    cdp.close();
  });

  it("stays quiet while traffic is flowing", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url, {
      keepaliveIntervalMs: 80,
      keepaliveTimeoutMs: 500,
    });

    for (let i = 0; i < 8; i++) {
      await cdp.send("Some.work");
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(fake.seen.some((m) => m.method !== "Some.work")).toBe(false);

    await new Promise((r) => setTimeout(r, 200)); // now go idle past the interval
    expect(fake.seen.some((m) => m.method !== "Some.work")).toBe(true);
    cdp.close();
  });
});

describe("CdpClient.close", () => {
  it("is idempotent, stops its timers and rejects nothing spuriously", async () => {
    const fake = await fakeCdp();
    const cdp = await CdpClient.connect(fake.url, { keepaliveIntervalMs: 30 });
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);

    await cdp.send("Browser.getVersion");
    cdp.close();
    cdp.close();
    await new Promise((r) => setTimeout(r, 150));

    process.off("unhandledRejection", onRejection);
    expect(rejections).toEqual([]);
    expect(cdp.dead).toBe(true);
    expect(fake.seen.map((m) => m.method)).toEqual(["Browser.getVersion"]);
  });
});
