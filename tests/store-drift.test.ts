import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { getStore, resetStore, type StoreClient } from "../src/core/store/client.js";
import { MAX_DRIFT_ROWS_PER_WRITE, recordParseDrift } from "../src/core/store/drift.js";
import { CapabilityError } from "../src/core/run/receipt.js";

type Recorded = { method: string; url: string; body: unknown };
type Reply = { status: number; body: unknown };

let server: Server;
let baseUrl = "";
let recorded: Recorded[] = [];
let reply: Reply = { status: 201, body: [] };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      recorded.push({ method: req.method ?? "", url: req.url ?? "", body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => {
  recorded = [];
  reply = { status: 201, body: [] };
  resetStore();
});

function client(): StoreClient {
  return getStore({ config: { url: baseUrl, serviceRoleKey: "stub-key" } });
}

describe("recordParseDrift", () => {
  it("inserts one bounded row per parser warning without asking PostgREST to return captured data", async () => {
    const rows = await recordParseDrift([
      { field: "headline", n: 1 },
      { field: "experience[0].date", n: 2 },
    ], { client: client(), capability: "profile.get", shapeHash: "shape-1" });

    expect(rows).toBe(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ method: "POST" });
    expect(recorded[0]!.url).toContain("/rest/v1/parse_drift");
    expect(recorded[0]!.url).not.toContain("select=");
    expect(recorded[0]!.body).toEqual([
      { capability: "profile.get", field: "headline", shape_hash: "shape-1", n: 1 },
      { capability: "profile.get", field: "experience[0].date", shape_hash: "shape-1", n: 2 },
    ]);
  });

  it("does no request for no warnings", async () => {
    expect(await recordParseDrift([], { client: client(), capability: "profile.get", shapeHash: null })).toBe(0);
    expect(recorded).toEqual([]);
  });

  it("classifies a failed insert with the store layer's existing mapping", async () => {
    reply = { status: 503, body: { code: "08006", message: "private database text" } };
    const err = await recordParseDrift([{ field: "headline", n: 1 }], {
      client: client(), capability: "profile.get", shapeHash: null,
    }).catch((cause) => cause);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("STORE_UNAVAILABLE");
    expect(JSON.stringify(err)).not.toContain("private database text");
  });

  it("refuses an unbounded caller before building or sending the payload", async () => {
    const warnings = Array.from({ length: MAX_DRIFT_ROWS_PER_WRITE + 1 }, (_, i) => ({ field: `f${i}`, n: 1 }));
    const err = await recordParseDrift(warnings, {
      client: client(), capability: "profile.get", shapeHash: null,
    }).catch((cause) => cause);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("STORE_WRITE_REJECTED");
    expect(recorded).toEqual([]);
  });
});
