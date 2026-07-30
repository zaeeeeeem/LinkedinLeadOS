import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, chmod, utimes } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  acquireLease,
  releaseLease,
  inspectLease,
  reclaimObserved,
  type LeaseRecord,
} from "../src/core/lease/tab-lease.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import { LEASE_SCRATCH_PREFIX } from "../src/core/lease/constants.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lease-"));
  path = join(dir, "tab.lock");
});

afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const read = async (): Promise<LeaseRecord> =>
  JSON.parse(await readFile(path, "utf8")) as LeaseRecord;

/** A pid that is guaranteed dead: spawn a process, wait for it to exit, reuse its pid. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((ok) => child.on("exit", () => ok()));
  return pid;
}

/** Writes a lease file directly, bypassing acquire, to set up a starting state. */
async function plant(o: Partial<LeaseRecord> & { run_id: string }): Promise<void> {
  const rec: LeaseRecord = {
    run_id: o.run_id,
    pid: o.pid ?? process.pid,
    host: o.host ?? hostname(),
    capability: o.capability ?? "profile.get",
    acquired_at: o.acquired_at ?? new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(rec) + "\n", "utf8");
}

describe("acquireLease", () => {
  it("acquires a free lease and writes the holder record", async () => {
    const rec = await acquireLease({ runId: "run-a", capability: "profile.get", path });
    expect(rec.run_id).toBe("run-a");
    expect(rec.pid).toBe(process.pid);
    expect(rec.capability).toBe("profile.get");
    expect(await read()).toEqual(rec);
  });

  it("creates the lease directory if it does not exist", async () => {
    const nested = join(dir, "runs", "tab.lock");
    await acquireLease({ runId: "run-a", capability: "profile.get", path: nested });
    expect(JSON.parse(await readFile(nested, "utf8")).run_id).toBe("run-a");
  });

  it("refuses while a live pid holds it, without touching the file", async () => {
    await plant({ run_id: "run-a", pid: process.pid });
    const before = await readFile(path, "utf8");
    const err = await acquireLease({ runId: "run-b", capability: "profile.posts", path })
      .then(() => undefined, (e: unknown) => e as CapabilityError);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err!.code).toBe("TAB_LEASE_HELD");
    expect(err!.retryable).toBe(true);
    expect(err!.action).toBe("RETRY_BACKOFF");
    expect(err!.exit).toBe(EXIT.TRANSIENT);
    expect(err!.retryAfterMs).toBeGreaterThan(0);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("is re-entrant for the same run id and keeps the original acquisition time", async () => {
    const first = await acquireLease({ runId: "run-a", capability: "profile.get", path });
    const again = await acquireLease({ runId: "run-a", capability: "profile.get", path });
    expect(again.run_id).toBe("run-a");
    expect(again.acquired_at).toBe(first.acquired_at);
    expect(again.renewed_at).toBeDefined();
  });

  it("reclaims a lease whose holder pid is dead", async () => {
    await plant({ run_id: "run-a", pid: await deadPid() });
    const rec = await acquireLease({ runId: "run-b", capability: "profile.posts", path });
    expect(rec.run_id).toBe("run-b");
    expect((await read()).run_id).toBe("run-b");
  });

  it("reclaims a corrupt lease file", async () => {
    await writeFile(path, "{not json at all", "utf8");
    const rec = await acquireLease({ runId: "run-b", capability: "profile.posts", path });
    expect(rec.run_id).toBe("run-b");
    expect((await read()).run_id).toBe("run-b");
  });

  it("reclaims a lease whose record is structurally wrong", async () => {
    await writeFile(path, JSON.stringify({ run_id: "run-a" }), "utf8");
    const rec = await acquireLease({ runId: "run-b", capability: "profile.posts", path });
    expect(rec.run_id).toBe("run-b");
  });

  it("refuses a lease held by another host rather than judging its pid locally", async () => {
    await plant({ run_id: "run-a", pid: await deadPid(), host: "some-other-machine" });
    const err = await acquireLease({ runId: "run-b", capability: "profile.get", path })
      .then(() => undefined, (e: unknown) => e as CapabilityError);
    expect(err!.code).toBe("TAB_LEASE_HELD");
    expect((await read()).run_id).toBe("run-a");
  });

  it("reports an unwritable lease directory as fatal, not as something to retry", async () => {
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o500);
    const err = await acquireLease({ runId: "run-a", capability: "profile.get", path: join(locked, "tab.lock") })
      .then(() => undefined, (e: unknown) => e as CapabilityError);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err!.code).toBe("TAB_LEASE_UNWRITABLE");
    expect(err!.retryable).toBe(false);
    expect(err!.action).toBe("HALT_AND_NOTIFY");
    expect(err!.exit).toBe(EXIT.GENERIC);
    await chmod(locked, 0o755);
  });
});

describe("releaseLease", () => {
  it("removes the lease when the releasing run holds it", async () => {
    await acquireLease({ runId: "run-a", capability: "profile.get", path });
    expect(await releaseLease({ runId: "run-a", path })).toBe(true);
    expect(await inspectLease(path)).toEqual({ state: "free" });
  });

  it("is a no-op when another run holds the lease", async () => {
    await plant({ run_id: "run-a" });
    expect(await releaseLease({ runId: "run-b", path })).toBe(false);
    expect((await read()).run_id).toBe("run-a");
  });

  it("is a no-op when the lease whose holder died belongs to another run", async () => {
    await plant({ run_id: "run-a", pid: await deadPid() });
    expect(await releaseLease({ runId: "run-b", path })).toBe(false);
    expect((await read()).run_id).toBe("run-a");
  });

  it("is a no-op when no lease exists", async () => {
    expect(await releaseLease({ runId: "run-a", path })).toBe(false);
  });

  it("clears a corrupt lease only when forced by the reclaim path, not by release", async () => {
    await writeFile(path, "{garbage", "utf8");
    expect(await releaseLease({ runId: "run-a", path })).toBe(false);
    expect(await readFile(path, "utf8")).toBe("{garbage");
  });
});

describe("inspectLease", () => {
  it("reports free when there is no lease file", async () => {
    expect(await inspectLease(path)).toEqual({ state: "free" });
  });

  it("reports held with the holder record for a live pid", async () => {
    await plant({ run_id: "run-a", capability: "search.run" });
    const s = await inspectLease(path);
    expect(s.state).toBe("held");
    expect(s.state === "held" && s.holder.capability).toBe("search.run");
  });

  it("reports stale for a dead pid", async () => {
    await plant({ run_id: "run-a", pid: await deadPid() });
    const s = await inspectLease(path);
    expect(s.state).toBe("stale");
    expect(s.state === "stale" && s.holder.run_id).toBe("run-a");
  });

  it("reports corrupt for an unparseable file", async () => {
    await writeFile(path, "nope", "utf8");
    expect((await inspectLease(path)).state).toBe("corrupt");
  });

  it("reports foreign for a lease written on another host", async () => {
    await plant({ run_id: "run-a", host: "elsewhere" });
    const s = await inspectLease(path);
    expect(s.state).toBe("foreign");
    expect(s.state === "foreign" && s.holder.host).toBe("elsewhere");
  });
});

describe("exclusion under concurrency", () => {
  it("hands a reclaimable lease to exactly one of many simultaneous acquirers", async () => {
    await plant({ run_id: "dead-run", pid: await deadPid() });
    const results = await Promise.allSettled(
      ["r1", "r2", "r3", "r4", "r5"].map((runId) =>
        acquireLease({ runId, capability: "profile.get", path }),
      ),
    );
    const winners = results.filter((r) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    expect((await read()).run_id).toBe(
      (winners[0] as PromiseFulfilledResult<LeaseRecord>).value.run_id,
    );
  });

  it("hands a free lease to exactly one of many simultaneous acquirers", async () => {
    const results = await Promise.allSettled(
      ["r1", "r2", "r3", "r4", "r5"].map((runId) =>
        acquireLease({ runId, capability: "profile.get", path }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });
});

/**
 * Runs one acquire in its own process. `offset` staggers it past the shared start,
 * which is how the tests reproduce a racer whose write lands after an earlier
 * racer has already finished checking.
 */
function child(runId: string, startAt: number, offset: number, hold = 2_000) {
  return new Promise<{ runId: string; code: number; out: string }>((ok) => {
    const p = spawn(
      process.execPath,
      ["--import", "tsx", helper, path, runId, String(startAt), String(offset), String(hold)],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let out = "";
    p.stdout.on("data", (d) => (out += String(d)));
    p.on("exit", (code) => ok({ runId, code: code ?? -1, out }));
  });
}

const helper = new URL("./helpers/acquire-child.ts", import.meta.url).pathname;

describe("exclusion across processes", () => {
  /** tsx has to boot in each child before the barrier means anything. */
  const BOOT_MS = 2_000;

  it(
    "hands a reclaimable lease to exactly one process, however the racers are staggered",
    { timeout: 30_000 },
    async () => {
      await plant({ run_id: "dead-run", pid: await deadPid() });
      const startAt = Date.now() + BOOT_MS;
      // 0/20/50/80ms apart: the interleaving where a settle-and-read-back check
      // returns before a later racer has written at all.
      const results = await Promise.all(
        [0, 20, 50, 80].map((offset, i) => child(`p${i}`, startAt, offset)),
      );
      const winners = results.filter((r) => r.code === 0);
      expect(winners).toHaveLength(1);
      expect((await read()).run_id).toBe(winners[0]!.runId);
      for (const loser of results.filter((r) => r.code !== 0)) {
        expect(loser.code).toBe(EXIT.TRANSIENT);
        expect(loser.out).toBe("TAB_LEASE_HELD");
      }
    },
  );

  it(
    "hands a free lease to exactly one process",
    { timeout: 30_000 },
    async () => {
      const startAt = Date.now() + BOOT_MS;
      const results = await Promise.all(
        [0, 15, 40, 70].map((offset, i) => child(`p${i}`, startAt, offset)),
      );
      expect(results.filter((r) => r.code === 0)).toHaveLength(1);
    },
  );
});

describe("scratch file hygiene", () => {
  it("sweeps temp files a crashed acquire left behind", async () => {
    const orphan = join(dir, `${LEASE_SCRATCH_PREFIX}quarantine.999.abandoned`);
    await writeFile(orphan, "{}", "utf8");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(orphan, old, old);
    await acquireLease({ runId: "run-a", capability: "profile.get", path });
    expect(await readdir(dir)).not.toContain(orphan.split("/").pop());
  });

  it("leaves a recent scratch file alone — it may belong to a live acquire", async () => {
    const inflight = `${LEASE_SCRATCH_PREFIX}quarantine.999.inflight`;
    await writeFile(join(dir, inflight), "{}", "utf8");
    await acquireLease({ runId: "run-a", capability: "profile.get", path });
    expect(await readdir(dir)).toContain(inflight);
  });

  it("leaves no scratch file behind on a clean reclaim", async () => {
    await plant({ run_id: "run-a", pid: await deadPid() });
    await acquireLease({ runId: "run-b", capability: "profile.get", path });
    expect((await readdir(dir)).filter((n) => n.startsWith(LEASE_SCRATCH_PREFIX))).toEqual([]);
  });
});

describe("two reclaimers that observed the same stale lease", () => {
  /**
   * The interleaving a settle-and-read-back check cannot close: both racers read
   * the stale record before either writes, and the second one's write lands after
   * the first has already finished checking. Staged directly, because process
   * start times cannot stage it — the loser would be refused long before reclaim.
   */
  it("gives the lease to the first, and the second refuses without disturbing it", async () => {
    await plant({ run_id: "dead-run", pid: await deadPid() });
    const observed = await readFile(path, "utf8");

    const winner = await reclaimObserved(path, observed, {
      run_id: "run-a",
      pid: process.pid,
      host: hostname(),
      capability: "profile.get",
      acquired_at: new Date().toISOString(),
    });
    expect((await read()).run_id).toBe("run-a");

    const err = await reclaimObserved(path, observed, {
      run_id: "run-b",
      pid: process.pid,
      host: hostname(),
      capability: "profile.posts",
      acquired_at: new Date().toISOString(),
    }).then(() => undefined, (e: unknown) => e as CapabilityError);

    expect(err).toBeInstanceOf(CapabilityError);
    expect(err!.code).toBe("TAB_LEASE_HELD");
    // The winner's record is intact: the loser put back what it briefly took away.
    expect(await read()).toEqual(winner);
    expect((await readdir(dir)).filter((n) => n.startsWith(LEASE_SCRATCH_PREFIX))).toEqual([]);
  });

  it("refuses when the stale lease is already gone", async () => {
    const err = await reclaimObserved(path, "{}", {
      run_id: "run-b",
      pid: process.pid,
      host: hostname(),
      capability: "profile.get",
      acquired_at: new Date().toISOString(),
    }).then(() => undefined, (e: unknown) => e as CapabilityError);
    expect(err!.code).toBe("TAB_LEASE_HELD");
    expect(await inspectLease(path)).toEqual({ state: "free" });
  });
});
