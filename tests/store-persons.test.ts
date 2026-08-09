import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CapabilityError } from "../src/core/run/receipt.js";
import { getStore, resetStore, type StoreClient } from "../src/core/store/client.js";
import { StoreWriteError, upsertPerson } from "../src/core/store/persons.js";
import { upsertJob } from "../src/core/store/jobs.js";

/**
 * Offline, but not faked at the client boundary: this drives the real supabase-js
 * against a stub PostgREST speaking real HTTP on loopback. A hand-written fake of the
 * query builder would let a request shape PostgREST rejects pass as correct — the
 * exact failure mode CONTEXT.md warns about. No Docker, no LinkedIn.
 */

type Recorded = { method: string; url: string; prefer: string; body: unknown };
type Reply = { status: number; body: unknown };

let server: Server;
let baseUrl = "";
let recorded: Recorded[] = [];
let replies: Reply[] = [];

function nextReply(): Reply {
  return replies.shift() ?? { status: 200, body: [] };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      recorded.push({
        method: req.method ?? "",
        url: req.url ?? "",
        prefer: String(req.headers["prefer"] ?? ""),
        body: raw ? JSON.parse(raw) : null,
      });
      const reply = nextReply();
      const wantsObject = String(req.headers["accept"] ?? "").includes("pgrst.object");
      let payload = reply.body;
      if (wantsObject && Array.isArray(payload)) payload = payload[0] ?? null;
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  recorded = [];
  replies = [];
  resetStore();
});

function client(): StoreClient {
  return getStore({ config: { url: baseUrl, serviceRoleKey: "stub-key" } });
}

const URN = "urn:li:fsd_profile:TEST";
const NOW = Date.UTC(2026, 7, 8, 12, 0, 0);
const STAMP = new Date(NOW).toISOString();

function personRow(over: Record<string, unknown> = {}) {
  return {
    urn: URN,
    vanity: "test",
    name: "Test",
    headline: null,
    location: null,
    current_company_urn: null,
    first_seen: STAMP,
    last_seen: STAMP,
    ...over,
  };
}

const at = (n: number) => recorded[n] as Recorded;

describe("upsertJob — list to detail enrichment", () => {
  it("merges detail into the same canonical id with no duplicate row", async () => {
    replies = [
      { status: 200, body: [{ id: "4450930857" }] },
      { status: 200, body: [{ id: "4450930857" }] },
    ];
    const store = client();
    await upsertJob({ id: "4450930857", title: "Full Stack Developer" }, { client: store, now: NOW });
    await upsertJob({ id: "4450930857", description: "Full description" }, { client: store, now: NOW + 1 });

    expect(recorded).toHaveLength(2);
    for (const request of recorded) {
      expect(request.url).toContain("/jobs");
      expect(request.url).toContain("on_conflict=id");
      expect(request.prefer).toContain("resolution=merge-duplicates");
      expect(request.body).toMatchObject({ id: "4450930857" });
    }
    expect(recorded[0]!.body).not.toHaveProperty("description");
    expect(recorded[1]!.body).not.toHaveProperty("title");
    expect(recorded[1]!.body).toHaveProperty("description", "Full description");
  });

  it("drops explicit nulls so a later sparse list observation cannot erase detail", async () => {
    replies = [{ status: 200, body: [{ id: "4450930857" }] }];
    await upsertJob(
      { id: "4450930857", title: "Full Stack Developer", description: null },
      { client: client(), now: NOW },
    );
    expect(recorded[0]!.body).toEqual({ id: "4450930857", title: "Full Stack Developer", last_seen: STAMP });
  });
});

describe("upsertPerson — request shape", () => {
  it("upserts the person on urn and stamps last_seen without touching first_seen", async () => {
    replies = [{ status: 200, body: [personRow()] }];
    const result = await upsertPerson({ person: { urn: URN, name: "Test" } }, { client: client(), now: NOW });

    expect(recorded).toHaveLength(1);
    expect(at(0).method).toBe("POST");
    expect(at(0).url).toContain("/persons");
    expect(at(0).url).toContain("on_conflict=urn");
    expect(at(0).prefer).toContain("resolution=merge-duplicates");
    expect(at(0).body).toEqual({ urn: URN, name: "Test", last_seen: STAMP });
    expect(result).toEqual({ urn: URN, rows: 1, experience: { upserted: 0, removed: 0 } });
  });

  it("omits fields the capture said nothing about, and writes an explicit null", async () => {
    replies = [{ status: 200, body: [personRow()] }];
    await upsertPerson(
      { person: { urn: URN, name: "Test", headline: null } },
      { client: client(), now: NOW },
    );
    const body = at(0).body as Record<string, unknown>;
    expect(body).toHaveProperty("headline", null);
    expect(body).not.toHaveProperty("location");
  });

  it("writes experience rows with uniform keys, on the natural key index", async () => {
    replies = [
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 200, body: [] },
      { status: 200, body: [personRow()] },
    ];
    const result = await upsertPerson(
      {
        person: { urn: URN },
        experience: [
          { company_urn: "1234", title: "Founder", is_current: true, started_on: "2020-01-01" },
          { company_name: "Old Co" },
        ],
      },
      { client: client(), now: NOW },
    );

    expect(at(0).method).toBe("POST");
    expect(at(0).url).toContain("/person_experience");
    expect(decodeURIComponent(at(0).url)).toContain(
      "on_conflict=person_urn,company_urn,company_name,title,started_on",
    );
    const rows = at(0).body as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(2);
    // PostgREST rejects a bulk insert whose objects have different keys, so every
    // row carries every column, explicitly nulled where the capture had nothing.
    expect(Object.keys(rows[0]!).sort()).toEqual(Object.keys(rows[1]!).sort());
    expect(rows[1]).toEqual({
      person_urn: URN,
      company_urn: null,
      company_name: "Old Co",
      title: null,
      started_on: null,
      ended_on: null,
      is_current: false,
      last_seen: STAMP,
    });
    expect(result.experience.upserted).toBe(2);
    expect(result.rows).toBe(3);
  });

  it("deletes stale rows only after the new ones are written, and bumps the person last", async () => {
    replies = [
      { status: 200, body: [{ id: 7 }, { id: 9 }] },
      { status: 200, body: [{ id: 3 }] },
      { status: 200, body: [personRow()] },
    ];
    const result = await upsertPerson(
      { person: { urn: URN }, experience: [{ title: "a" }, { title: "b" }] },
      { client: client(), now: NOW },
    );

    expect(recorded.map((r) => `${r.method} ${r.url.split("?")[0]}`)).toEqual([
      "POST /rest/v1/person_experience",
      "DELETE /rest/v1/person_experience",
      "POST /rest/v1/persons",
    ]);
    const del = decodeURIComponent(at(1).url);
    expect(del).toContain(`person_urn=eq.${URN}`);
    expect(del).toContain("id=not.in.(7,9)");
    expect(result.experience.removed).toBe(1);
  });

  it("clears every experience row when the capture says there are none", async () => {
    replies = [
      { status: 200, body: [{ id: 4 }] },
      { status: 200, body: [personRow()] },
    ];
    const result = await upsertPerson({ person: { urn: URN }, experience: [] }, { client: client(), now: NOW });
    expect(recorded.map((r) => r.method)).toEqual(["DELETE", "POST"]);
    expect(decodeURIComponent(at(0).url)).not.toContain("id=not.in");
    expect(result.experience).toEqual({ upserted: 0, removed: 1 });
  });

  it("touches no experience row at all when the caller omitted experience", async () => {
    replies = [{ status: 200, body: [personRow()] }];
    await upsertPerson({ person: { urn: URN } }, { client: client(), now: NOW });
    expect(recorded).toHaveLength(1);
  });
});

describe("upsertPerson — what is in the store when it fails partway", () => {
  it("stores nothing and reports nothing stored when the person write fails", async () => {
    replies = [{ status: 503, body: { code: "08006", message: "connection failure" } }];
    const err = await upsertPerson({ person: { urn: URN } }, { client: client(), now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as StoreWriteError).stored).toBe(0);
    expect((err as CapabilityError).code).toBe("STORE_UNAVAILABLE");
    expect((err as CapabilityError).retryable).toBe(true);
  });

  it("never touches the person row when the experience write fails", async () => {
    replies = [{ status: 500, body: { code: "", message: "boom" } }];
    const err = await upsertPerson(
      { person: { urn: URN }, experience: [{ title: "a" }] },
      { client: client(), now: NOW },
    ).catch((e) => e);
    expect(err).toBeInstanceOf(StoreWriteError);
    expect((err as StoreWriteError).stored).toBe(0);
    // The regression this ordering exists for: last_seen is the record's claim to be
    // complete, and isFresh reads it. Bumping it here would leave an incomplete record
    // that looks fresh, so the next run serves it and never re-fetches for a whole
    // --max-age window. Nothing reached persons, and no delete was attempted either.
    expect(recorded.map((r) => r.url.split("?")[0])).toEqual(["/rest/v1/person_experience"]);
  });

  it("never touches the person row when only the stale-row delete fails", async () => {
    replies = [
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 500, body: { code: "", message: "boom" } },
    ];
    const err = await upsertPerson(
      { person: { urn: URN }, experience: [{ title: "a" }, { title: "b" }] },
      { client: client(), now: NOW },
    ).catch((e) => e);
    expect((err as StoreWriteError).stored).toBe(2);
    expect(recorded.some((r) => r.url.includes("/persons"))).toBe(false);
  });

  it("reports experience plus person as stored when everything lands", async () => {
    replies = [
      { status: 200, body: [{ id: 1 }, { id: 2 }] },
      { status: 200, body: [] },
      { status: 200, body: [personRow()] },
    ];
    const result = await upsertPerson(
      { person: { urn: URN }, experience: [{ title: "a" }, { title: "b" }] },
      { client: client(), now: NOW },
    );
    expect(result.rows).toBe(3);
  });

  it("re-sends every row on retry — the write is idempotent by construction", async () => {
    // Both attempts must issue byte-identical bodies to the same conflict targets,
    // which is what makes a retry after a half-landed write safe.
    const runOnce = async () => {
      replies = [
        { status: 200, body: [{ id: 1 }] },
        { status: 200, body: [] },
        { status: 200, body: [personRow()] },
      ];
      await upsertPerson(
        { person: { urn: URN, name: "Test" }, experience: [{ title: "a" }] },
        { client: client(), now: NOW },
      );
      const sent = recorded.map((r) => `${r.method} ${r.url} ${JSON.stringify(r.body)}`);
      recorded = [];
      return sent;
    };
    expect(await runOnce()).toEqual(await runOnce());
  });
});
