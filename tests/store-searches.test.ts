import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getStore, resetStore } from "../src/core/store/client.js";
import { ensureSearch, insertSearch, insertSearchResults, MAX_SEARCH_RESULTS_PER_WRITE } from "../src/core/store/searches.js";
import { StoreWriteError } from "../src/core/store/persons.js";

type Request = { method: string; url: string; prefer: string; body: unknown };
let server: Server;
let baseUrl = "";
let requests: Request[] = [];
let stored: Array<Record<string, unknown>> = [];
let storedSearches: Array<Record<string, unknown>> = [];
let failNextWrite = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method ?? "", url: req.url ?? "", prefer: String(req.headers["prefer"] ?? ""), body });
      const decoded = decodeURIComponent(req.url ?? "");
      let status = 200;
      let reply: unknown = [];
      if (req.method === "GET" && decoded.startsWith("/rest/v1/searches")) {
        const searchId = /search_id=eq\.([^&]+)/.exec(decoded)?.[1];
        reply = storedSearches.filter((row) => row["search_id"] === searchId);
      } else if (req.method === "GET" && decoded.startsWith("/rest/v1/search_results")) {
        const searchId = /search_id=eq\.([^&]+)/.exec(decoded)?.[1];
        const page = Number(/page=eq\.(\d+)/.exec(decoded)?.[1]);
        reply = stored.filter((row) => row["search_id"] === searchId && row["page"] === page)
          .map((row) => ({ search_id: row["search_id"], page: row["page"], position: row["position"], person_urn: row["person_urn"] ?? null, company_urn: row["company_urn"] ?? null }));
      } else if (req.method === "POST" && decoded.startsWith("/rest/v1/search_results")) {
        if (failNextWrite) {
          failNextWrite = false;
          status = 409;
          reply = { code: "23505", message: "database wrote urn:li:member:private into its error" };
        } else {
          const rows = Array.isArray(body) ? body as Array<Record<string, unknown>> : [body as Record<string, unknown>];
          const duplicate = rows.some((row) => stored.some((old) => old["search_id"] === row["search_id"] && old["page"] === row["page"] && old["position"] === row["position"]));
          if (duplicate) { status = 409; reply = { code: "23505", message: "duplicate private database value" }; }
          else { stored.push(...rows); reply = rows.map((_, index) => ({ id: stored.length - rows.length + index + 1 })); }
        }
      } else if (req.method === "POST" && decoded.startsWith("/rest/v1/searches")) {
        storedSearches.push(body as Record<string, unknown>);
        reply = [{ search_id: (body as Record<string, unknown>)["search_id"] }];
      }
      const wantsObject = String(req.headers["accept"] ?? "").includes("pgrst.object");
      if (wantsObject && Array.isArray(reply)) reply = reply[0] ?? null;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => new Promise<void>((resolve) => server.close(() => resolve())));
afterEach(() => { requests = []; stored = []; storedSearches = []; failNextWrite = false; resetStore(); });
const client = () => getStore({ config: { url: baseUrl, serviceRoleKey: "stub" } });
const lead = (search_id: string, position = 1) => ({ search_id, page: 1, position, person_urn: "urn:li:member:42", run_ref: null } as const);

describe("search store through real supabase-js", () => {
  it("inserts an immutable search definition without database-owned created_at", async () => {
    expect(await insertSearch({ search_id: "search-a", kind: "sn_leads", filter_url: "https://www.linkedin.com/sales/search/people", filter_json: null }, { client: client() }))
      .toEqual({ search_id: "search-a", rows: 1 });
    const request = requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.url).toContain("/searches");
    expect(request.url).not.toContain("on_conflict");
    expect(request.prefer).not.toContain("resolution=merge-duplicates");
    expect(request.body).not.toHaveProperty("created_at");
  });

  it("adopts an identical search definition on resume and refuses a changed one", async () => {
    const store = client();
    const original = { search_id: "run-a", kind: "sn_leads" as const, filter_url: "https://www.linkedin.com/sales/search/people", filter_json: null };
    expect(await ensureSearch(original, { client: store })).toMatchObject({ inserted: true });
    expect(await ensureSearch(original, { client: store })).toMatchObject({ inserted: false });
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/searches"))).toHaveLength(1);
    await expect(ensureSearch({ ...original, filter_url: "https://www.linkedin.com/sales/search/people?changed=1" }, { client: store }))
      .rejects.toMatchObject({ code: "SEARCH_RESULT_INVALID" });
  });

  it("keeps the same lead as two append-only observations in two searches", async () => {
    const store = client();
    expect(await insertSearchResults([lead("search-a")], { client: store })).toEqual({ rows: 1, skipped: 0 });
    expect(await insertSearchResults([lead("search-b")], { client: store })).toEqual({ rows: 1, skipped: 0 });
    expect(stored).toHaveLength(2);
    expect(new Set(stored.map((row) => row["search_id"]))).toEqual(new Set(["search-a", "search-b"]));
    expect(new Set(stored.map((row) => row["person_urn"]))).toEqual(new Set(["urn:li:member:42"]));
    const writes = requests.filter((request) => request.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes.every((request) => !request.url.includes("on_conflict") && !request.prefer.includes("resolution=merge-duplicates"))).toBe(true);
  });

  it("skips a re-insert of the same search page position", async () => {
    const store = client();
    await insertSearchResults([lead("search-a")], { client: store });
    const second = await insertSearchResults([lead("search-a")], { client: store });
    expect(second).toEqual({ rows: 0, skipped: 1 });
    expect(stored).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  it("never touches persons or companies while writing search provenance", async () => {
    await insertSearchResults([lead("search-a")], { client: client() });
    expect(requests[0]!.url).toContain("/search_results?select=search_id%2Cpage%2Cposition%2Cperson_urn%2Ccompany_urn");
    expect(requests[1]!.url).toContain("/search_results?");
    expect(requests[1]!.url).toContain("select=id");
    expect(requests.some((request) => /\/(persons|companies)(?:\?|$)/.test(request.url))).toBe(false);
  });

  it("keeps database-written values out of errors", async () => {
    failNextWrite = true;
    const error = await insertSearchResults([lead("search-a")], { client: client() }).catch((cause) => cause);
    expect(error).toBeInstanceOf(StoreWriteError);
    expect((error as StoreWriteError).stored).toBe(0);
    expect(JSON.stringify(error)).not.toContain("urn:li:member:private");
    expect((error as Error).message).not.toContain("private");
  });

  it("refuses when a stored page position belongs to a different entity", async () => {
    const store = client();
    await insertSearchResults([lead("search-a")], { client: store });
    const error = await insertSearchResults([{ ...lead("search-a"), person_urn: "urn:li:member:99" }], { client: store }).catch((cause) => cause);
    expect(error).toMatchObject({ code: "SEARCH_RESULT_INVALID", retryable: false });
    expect(stored).toHaveLength(1);
    expect(stored[0]!["person_urn"]).toBe("urn:li:member:42");
  });

  it("refuses conflicting duplicates and batches beyond one page before HTTP", async () => {
    const store = client();
    const conflict = await insertSearchResults([lead("search-a"), { ...lead("search-a"), person_urn: "urn:li:member:99" }], { client: store }).catch((cause) => cause);
    expect(conflict).toMatchObject({ code: "SEARCH_RESULT_INVALID", retryable: false });
    expect(requests).toHaveLength(0);
    const tooMany = Array.from({ length: MAX_SEARCH_RESULTS_PER_WRITE + 1 }, (_, index) => lead("search-a", index + 1));
    await expect(insertSearchResults(tooMany, { client: store })).rejects.toMatchObject({ code: "SEARCH_RESULT_INVALID" });
    expect(requests).toHaveLength(0);
  });
});
