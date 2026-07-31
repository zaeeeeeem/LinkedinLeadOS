import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RawArchive } from "../src/core/archive/raw.js";
import { shapeHashOfBody } from "../src/core/archive/shape.js";
import { CapabilityError } from "../src/core/run/receipt.js";

let dirs: string[] = [];

/** A fresh temp directory this test owns; cleaned up in `afterEach`. */
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "linkedin-os-archive-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  const pending = dirs;
  dirs = [];
  for (const d of pending) await rm(d, { recursive: true, force: true });
});

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);

describe("RawArchive.archive", () => {
  it("writes a path that exists, gzipped, and not the plaintext body", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const body = JSON.stringify({ name: "Alice", age: 30 });

    const entry = await archive.archive({ body, url: "https://x/1", status: 200 });

    const onDisk = await readFile(entry.path);
    expect(onDisk.subarray(0, 2)).toEqual(GZIP_MAGIC);
    expect(onDisk.toString("utf8")).not.toContain("Alice");
    await expect(stat(entry.path)).resolves.toBeDefined();
  });

  it("computes the shape hash the same way shapeHashOfBody would", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const body = JSON.stringify({ a: 1, b: "two" });

    const entry = await archive.archive({ body, url: "https://x/1", status: 200 });

    expect(entry.shapeHash).toBe(shapeHashOfBody(body));
  });

  it("round-trips a string body byte-identically, including non-ASCII and emoji", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const body = JSON.stringify({ name: "Zoë 🎉", city: "Straße" });

    const entry = await archive.archive({ body, url: "https://x/1", status: 200 });
    const back = await archive.readText(entry);

    expect(back).toBe(body);
  });

  it("round-trips a Uint8Array body byte-identically", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const text = JSON.stringify({ ok: true, note: "emoji 🚀 in bytes" });
    const bytes = new TextEncoder().encode(text);

    const entry = await archive.archive({ body: bytes, url: "https://x/1", status: 200 });
    const back = await archive.read(entry);

    expect(Buffer.from(back)).toEqual(Buffer.from(bytes));
  });

  it("archives a non-JSON body fine, tagging it with the non-JSON shape hash", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const body = "<html><body>rate limited</body></html>";

    const entry = await archive.archive({ body, url: "https://x/1", status: 429 });

    expect(entry.shapeHash).toBe(shapeHashOfBody(body));
    expect(await archive.readText(entry)).toBe(body);
  });

  it("persists two captures of the same shape without deduping either one", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);
    const first = await archive.archive({
      body: JSON.stringify({ id: 1, name: "Alice" }),
      url: "https://x/1",
      status: 200,
    });
    const second = await archive.archive({
      body: JSON.stringify({ id: 2, name: "Bob" }),
      url: "https://x/2",
      status: 200,
    });

    expect(first.shapeHash).toBe(second.shapeHash);
    expect(first.path).not.toBe(second.path);

    const listed = await archive.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((e) => e.file).sort()).toEqual([first.file, second.file].sort());
  });
});

describe("RawArchive.list", () => {
  it("returns metadata (url, status, capturedAt, bytes, shapeHash) with seq order preserved", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);

    const a = await archive.archive({
      body: JSON.stringify({ n: 1 }),
      url: "https://x/first",
      status: 200,
      method: "GET",
      capturedAt: "2026-08-08T00:00:00.000Z",
    });
    const b = await archive.archive({
      body: JSON.stringify({ n: 2 }),
      url: "https://x/second",
      status: 201,
      method: "POST",
      capturedAt: "2026-08-08T00:01:00.000Z",
    });

    const listed = await archive.list();
    expect(listed.map((e) => e.seq)).toEqual([a.seq, b.seq]);
    expect(listed[0]).toMatchObject({
      url: "https://x/first",
      status: 200,
      method: "GET",
      capturedAt: "2026-08-08T00:00:00.000Z",
      shapeHash: a.shapeHash,
    });
    expect(listed[0]?.bytes).toBeGreaterThan(0);
    expect(listed[1]).toMatchObject({ url: "https://x/second", status: 201 });
  });

  it("returns [] for an empty directory and for one that does not exist yet", async () => {
    const dir = await tempDir();
    const empty = new RawArchive(dir);
    expect(await empty.list()).toEqual([]);

    const missing = new RawArchive(join(dir, "does-not-exist"));
    expect(await missing.list()).toEqual([]);
  });

  it("a fresh RawArchive over an existing directory continues the sequence rather than overwriting", async () => {
    const dir = await tempDir();
    const first = new RawArchive(dir);
    const a = await first.archive({ body: JSON.stringify({ n: 1 }), url: "https://x/1", status: 200 });
    const b = await first.archive({ body: JSON.stringify({ n: 2 }), url: "https://x/2", status: 200 });

    const resumed = new RawArchive(dir);
    const c = await resumed.archive({ body: JSON.stringify({ n: 3 }), url: "https://x/3", status: 200 });

    expect(c.seq).toBeGreaterThan(b.seq);
    expect(c.seq).toBeGreaterThan(a.seq);

    const listed = await resumed.list();
    expect(listed).toHaveLength(3);
    // Every prior body is still readable, untouched by the new instance.
    expect(await resumed.readText(a)).toBe(JSON.stringify({ n: 1 }));
    expect(await resumed.readText(b)).toBe(JSON.stringify({ n: 2 }));
  });
});

describe("RawArchive.read", () => {
  it("throws a CapabilityError with code ARCHIVE_ENTRY_MISSING for an unknown id", async () => {
    const dir = await tempDir();
    const archive = new RawArchive(dir);

    const err = await archive.read("0099-deadbeefdeadbeef.json.gz").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("ARCHIVE_ENTRY_MISSING");
    expect((err as CapabilityError).retryable).toBe(false);
    expect((err as CapabilityError).action).toBe("HALT_AND_NOTIFY");
  });
});
