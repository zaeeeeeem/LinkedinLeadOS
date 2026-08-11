import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getStore, resetStore } from "../src/core/store/client.js";
import { ensureRunRecord, finishRunRecord } from "../src/core/store/runs.js";

type Request = { method: string; url: string; body: Record<string, unknown> | null };
let server: Server;
let baseUrl = "";
let requests: Request[] = [];
let stored: Record<string, unknown> | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : null;
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      let reply: unknown = [];
      if (req.method === "GET") reply = stored === null ? [] : [stored];
      if (req.method === "POST") { stored = { ...body }; reply = [{ run_id: body?.["run_id"] }]; }
      if (req.method === "PATCH") { stored = { ...(stored ?? {}), ...body }; reply = [{ run_id: stored["run_id"] }]; }
      const wantsObject = String(req.headers["accept"] ?? "").includes("pgrst.object");
      if (wantsObject && Array.isArray(reply)) reply = reply[0] ?? null;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => { requests = []; stored = null; resetStore(); });
const client = () => getStore({ config: { url: baseUrl, serviceRoleKey: "stub" } });

describe("run bookkeeping through real supabase-js", () => {
  it("creates the foreign-key parent, reopens it on resume, and finalizes measured cost", async () => {
    const store = client();
    const input = { run_id: "run-a", capability: "salesnav.leads.list", args: { pages: 2 } };
    await ensureRunRecord(input, { client: store });
    expect(requests.map((request) => request.method)).toEqual(["GET", "POST"]);
    expect(requests[1]!.body).toEqual({ ...input, status: "running" });

    await ensureRunRecord(input, { client: store });
    expect(requests.at(-1)).toMatchObject({ method: "PATCH", body: { status: "running", ended_at: null, exit_code: null } });

    await finishRunRecord("run-a", {
      status: "ok", page_loads: 2, search_credits: 2, elapsed_ms: 500, exit_code: 0,
    }, { client: store });
    expect(requests.at(-1)).toMatchObject({
      method: "PATCH",
      body: expect.objectContaining({ status: "ok", page_loads: 2, search_credits: 2, elapsed_ms: 500, exit_code: 0 }),
    });
    expect(typeof requests.at(-1)!.body?.["ended_at"]).toBe("string");
  });

  it("refuses to adopt a run id owned by another capability before a write", async () => {
    stored = { run_id: "run-a", capability: "salesnav.accounts.list" };
    await expect(ensureRunRecord({
      run_id: "run-a", capability: "salesnav.leads.list", args: {},
    }, { client: client() })).rejects.toMatchObject({ code: "RUN_STORE_IDENTITY_MISMATCH" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
  });
});
