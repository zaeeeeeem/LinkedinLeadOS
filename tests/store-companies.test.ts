import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getStore, resetStore } from "../src/core/store/client.js";
import { StoreWriteError } from "../src/core/store/persons.js";
import { upsertCompany } from "../src/core/store/companies.js";

let server: Server;
let baseUrl = "";
let status = 200;
let recorded: { url: string; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      recorded.push({ url: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify([{ urn: "urn:li:fsd_company:42" }]) : JSON.stringify({ code: "PGRST000", message: "database value must not escape" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => { recorded = []; status = 200; resetStore(); });

const client = () => getStore({ config: { url: baseUrl, serviceRoleKey: "stub" } });

describe("upsertCompany", () => {
  it("normalizes the one atomic write shape: no first_seen and last_seen last", async () => {
    const result = await upsertCompany({ urn: "urn:li:fsd_company:42", name: "Acme", website: undefined, hq: null }, { client: client(), now: 0 });
    expect(result).toEqual({ urn: "urn:li:fsd_company:42", rows: 1 });
    expect(recorded[0]!.url).toContain("/companies?on_conflict=urn");
    expect(Object.keys(recorded[0]!.body).at(-1)).toBe("last_seen");
    expect(recorded[0]!.body).not.toHaveProperty("first_seen");
    expect(recorded[0]!.body).not.toHaveProperty("website");
    expect(recorded[0]!.body).toHaveProperty("hq", null);
  });

  it("reports zero landed rows and keeps database-written strings off the error", async () => {
    status = 503;
    let caught: unknown;
    try { await upsertCompany({ urn: "urn:li:fsd_company:42" }, { client: client() }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StoreWriteError);
    expect((caught as StoreWriteError).stored).toBe(0);
    expect(JSON.stringify(caught)).not.toContain("database value must not escape");
  });
});
