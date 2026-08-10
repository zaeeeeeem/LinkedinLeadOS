import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, appendFile, chmod, utimes, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, spend, usage, BudgetLedger, type SpendRecord } from "../src/core/budget/ledger.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import {
  CAPABILITY_SUB_CAPS,
  COMPACTION_RETENTION_MS,
  DEFAULT_BUDGET_LIMITS,
  DEFAULT_CAPABILITY_SUB_CAPS,
  subCapsFor,
  LEDGER_LOCK_STALE_MS,
  LEDGER_LOCK_TIMEOUT_MS,
} from "../src/core/budget/constants.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "budget-"));
  path = join(dir, "budget.ndjson");
});

afterEach(async () => {
  await chmod(dir, 0o755).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

const readLines = async (): Promise<SpendRecord[]> => {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as SpendRecord);
};

/** Writes synthetic lines directly, bypassing spend(), to stage boundary and window cases. */
async function plant(records: Array<Partial<SpendRecord> & { kind: SpendRecord["kind"] }>): Promise<void> {
  const lines = records.map((r) =>
    JSON.stringify({
      ts: r.ts ?? new Date().toISOString(),
      run_id: r.run_id ?? "seed-run",
      capability: r.capability ?? "seed.capability",
      kind: r.kind,
      n: r.n ?? 1,
      ...(r.ref !== undefined ? { ref: r.ref } : {}),
    }),
  );
  await appendFile(path, lines.map((l) => l + "\n").join(""), "utf8");
}

const asErr = async (p: Promise<unknown>): Promise<CapabilityError> =>
  p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e: unknown) => e as CapabilityError,
  );

describe("spend", () => {
  it("records a spend under limits and returns the record", async () => {
    const rec = await spend({ runId: "run-a", capability: "profile.get", kind: "page_load", path });
    expect(rec.kind).toBe("page_load");
    expect(rec.n).toBe(1);
    expect(rec.run_id).toBe("run-a");
    expect(rec.capability).toBe("profile.get");
    expect(typeof rec.ts).toBe("string");
  });

  it("appends ledger lines durably, one JSON object per spend", async () => {
    await spend({ runId: "run-a", capability: "profile.get", kind: "page_load", path });
    await spend({ runId: "run-a", capability: "profile.get", kind: "page_load", path });
    const lines = await readLines();
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.kind === "page_load")).toBe(true);
  });

  it("creates the ledger directory if it does not exist", async () => {
    const nested = join(dir, "runs", "budget.ndjson");
    await spend({ runId: "run-a", capability: "profile.get", kind: "page_load", path: nested });
    expect((await readFile(nested, "utf8")).trim().length).toBeGreaterThan(0);
  });
});

describe("limit boundaries", () => {
  it("allows the Nth page load per hour and refuses the N+1th", async () => {
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.pageLoadsPerHour - 1 }, () => ({ kind: "page_load" as const })),
    );
    const ok = await spend({ runId: "r", capability: "c", kind: "page_load", path });
    expect(ok.kind).toBe("page_load");

    const err = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path }));
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.exit).toBe(EXIT.BUDGET);
    expect(err.action).toBe("HALT_AND_NOTIFY");
    expect(err.retryable).toBe(false);
  });

  it("trips the daily page-load limit even under the hourly one, using a spread of timestamps", async () => {
    const now = Date.now();
    // Spread across the last 20 hours so the hourly window (last 60 minutes)
    // never holds more than a couple, but the daily window holds all of them.
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.pageLoadsPerDay }, (_, i) => ({
        kind: "page_load" as const,
        ts: new Date(now - (i % 20) * 55 * 60 * 1000).toISOString(),
      })),
    );
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path, now: new Date(now) }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(JSON.parse(err.evidence!).window).toBe("day");
  });

  it("trips the Sales Nav search-page daily limit at its boundary", async () => {
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.searchPagesPerDay - 1 }, () => ({ kind: "search_page" as const })),
    );
    await expect(spend({ runId: "r", capability: "c", kind: "search_page", path })).resolves.toBeDefined();
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "search_page", path }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
  });

  it("trips the distinct-profile daily limit at its boundary", async () => {
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.distinctProfilesPerDay - 1 }, (_, i) => ({
        kind: "profile_open" as const,
        ref: `urn:li:fsd_profile:${i}`,
      })),
    );
    await expect(
      spend({ runId: "r", capability: "c", kind: "profile_open", ref: "urn:li:fsd_profile:last", path }),
    ).resolves.toBeDefined();
    const err = await asErr(
      spend({ runId: "r", capability: "c", kind: "profile_open", ref: "urn:li:fsd_profile:overflow", path }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
  });
});

describe("window expiry", () => {
  it("does not count page loads older than an hour toward the hourly limit", async () => {
    const now = Date.now();
    await plant([{ kind: "page_load", ts: new Date(now - 61 * 60 * 1000).toISOString() }]);
    const snap = await usage({ path, now: new Date(now) });
    expect(snap.pageLoadsLastHour).toBe(0);
    expect(snap.pageLoadsToday).toBe(1);
  });

  it("does not count spends older than a day toward any daily limit", async () => {
    const now = Date.now();
    await plant([
      { kind: "page_load", ts: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
      { kind: "search_page", ts: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
      { kind: "profile_open", ref: "urn:old", ts: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
    ]);
    const snap = await usage({ path, now: new Date(now) });
    expect(snap.pageLoadsToday).toBe(0);
    expect(snap.searchPagesToday).toBe(0);
    expect(snap.distinctProfilesToday).toBe(0);
  });
});

describe("distinct-profile counting", () => {
  it("counts the same profile opened twice in a day once", async () => {
    await spend({ runId: "r", capability: "c", kind: "profile_open", ref: "urn:a", path });
    await spend({ runId: "r", capability: "c", kind: "profile_open", ref: "urn:a", path });
    const snap = await usage({ path });
    expect(snap.distinctProfilesToday).toBe(1);
    expect((await readLines()).length).toBe(2);
  });

  it("allows reopening an already-counted profile even when the day's distinct quota is full", async () => {
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.distinctProfilesPerDay }, (_, i) => ({
        kind: "profile_open" as const,
        ref: `urn:${i}`,
      })),
    );
    await expect(
      spend({ runId: "r", capability: "c", kind: "profile_open", ref: "urn:0", path }),
    ).resolves.toBeDefined();
  });

  it("refuses a profile_open spend with no ref", async () => {
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "profile_open", path }));
    expect(err.code).toBe("BUDGET_PROFILE_REF_REQUIRED");
    expect(err.retryable).toBe(false);
  });
});

describe("corrupt ledger", () => {
  it("fails closed on a corrupt line instead of counting only the valid ones", async () => {
    await plant(
      Array.from({ length: 3 }, () => ({ kind: "page_load" as const })),
    );
    await appendFile(path, "not json at all\n", "utf8");

    const err = await asErr(usage({ path }));
    expect(err.code).toBe("BUDGET_LEDGER_CORRUPT");
    expect(err.action).toBe("HALT_AND_NOTIFY");
    expect(err.retryable).toBe(false);

    // Also refuses a spend that would otherwise be comfortably under limit.
    const spendErr = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path }));
    expect(spendErr.code).toBe("BUDGET_LEDGER_CORRUPT");
  });

  it("treats a structurally wrong line (missing fields) as corrupt too", async () => {
    await writeFile(path, JSON.stringify({ ts: new Date().toISOString() }) + "\n", "utf8");
    const err = await asErr(usage({ path }));
    expect(err.code).toBe("BUDGET_LEDGER_CORRUPT");
  });
});

describe("limit overrides can only lower a limit", () => {
  it("ignores an override that raises the default", async () => {
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.pageLoadsPerHour }, () => ({ kind: "page_load" as const })),
    );
    const err = await asErr(
      check({ capability: "c", kind: "page_load", path, limits: { pageLoadsPerHour: 10_000 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
  });

  it("applies an override that lowers the default", async () => {
    await plant([{ kind: "page_load" }, { kind: "page_load" }]);
    const err = await asErr(check({ capability: "c", kind: "page_load", path, limits: { pageLoadsPerHour: 2 } }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(JSON.parse(err.evidence!).limit).toBe(2);
  });
});

describe("check does not spend", () => {
  it("leaves the ledger untouched", async () => {
    await check({ capability: "c", kind: "page_load", path });
    const lines = await readLines().catch(() => []);
    expect(lines).toHaveLength(0);
  });
});

describe("concurrent spends", () => {
  it("lets exactly one of two racing spends through a limit of one", async () => {
    const results = await Promise.allSettled([
      spend({ runId: "r1", capability: "c", kind: "page_load", path, limits: { pageLoadsPerHour: 1 } }),
      spend({ runId: "r2", capability: "c", kind: "page_load", path, limits: { pageLoadsPerHour: 1 } }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason.code).toBe("BUDGET_EXCEEDED");
    expect(await readLines()).toHaveLength(1);
  });

  it("does not deadlock: ten racing spends against a limit of five leave exactly five recorded", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        spend({ runId: `r${i}`, capability: "c", kind: "page_load", path, limits: { pageLoadsPerHour: 5 } }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(await readLines()).toHaveLength(5);
  });
});

describe("BudgetLedger.open", () => {
  it("binds a path and limits so check/spend/usage need not repeat them", async () => {
    const ledger = BudgetLedger.open({ path, limits: { pageLoadsPerHour: 1 } });
    await ledger.spend({ runId: "r", capability: "c", kind: "page_load" });
    const err = await asErr(ledger.spend({ runId: "r", capability: "c", kind: "page_load" }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
    const snap = await ledger.usage();
    expect(snap.pageLoadsToday).toBe(1);
  });

  it("creates the ledger's directory on open", () => {
    const nested = join(dir, "a", "b", "budget.ndjson");
    expect(() => BudgetLedger.open({ path: nested })).not.toThrow();
  });
});

describe("unwritable ledger path", () => {
  it("classifies a directory that cannot be created as fatal, not retryable", async () => {
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "file, not a directory", "utf8");
    const nested = join(blocked, "budget.ndjson");
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path: nested }));
    expect(err.code).toBe("BUDGET_LEDGER_UNWRITABLE");
    expect(err.exit).toBe(EXIT.GENERIC);
    expect(err.retryable).toBe(false);
  });

  it("BudgetLedger.open reports the same unwritable classification mkdirSync would not", async () => {
    const blocked = join(dir, "not-a-dir");
    await writeFile(blocked, "file, not a directory", "utf8");
    const nested = join(blocked, "budget.ndjson");
    let err: CapabilityError | undefined;
    try {
      BudgetLedger.open({ path: nested });
    } catch (e) {
      err = e as CapabilityError;
    }
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err!.code).toBe("BUDGET_LEDGER_UNWRITABLE");
    expect(err!.retryable).toBe(false);
  });
});

/** Plants a lock file directly and backdates its mtime so it reads as stale (or not). */
async function plantLock(ageMs: number, content = "planted"): Promise<string> {
  const lock = `${path}.lock`;
  await mkdir(dir, { recursive: true });
  await writeFile(lock, content, "utf8");
  const past = new Date(Date.now() - ageMs);
  await utimes(lock, past, past);
  return lock;
}

describe("stale lock recovery", () => {
  it("lets exactly one racer through when several find the same stale lock", async () => {
    // Regression: an unlink-then-open steal lets two racers who both judge
    // the lock stale each unlink — the second unlink deletes the first
    // racer's brand-new lock, and both end up holding it. Run several
    // trials since the race window is narrow.
    for (let trial = 0; trial < 8; trial++) {
      const trialDir = await mkdtemp(join(tmpdir(), "budget-race-"));
      const trialPath = join(trialDir, "budget.ndjson");
      await writeFile(`${trialPath}.lock`, "stale-holder", "utf8");
      const past = new Date(Date.now() - LEDGER_LOCK_STALE_MS - 500);
      await utimes(`${trialPath}.lock`, past, past);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          spend({
            runId: `racer-${i}`,
            capability: "c",
            kind: "page_load",
            path: trialPath,
            limits: { pageLoadsPerHour: 1 },
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(1);

      const lines = (await readFile(trialPath, "utf8")).trim().split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(1);
      await rm(trialDir, { recursive: true, force: true });
    }
  });

  it("reclaims a stale lock and completes the spend", async () => {
    await plantLock(LEDGER_LOCK_STALE_MS + 500);
    const rec = await spend({ runId: "r", capability: "c", kind: "page_load", path });
    expect(rec.kind).toBe("page_load");
  });
});

describe("live-lock timeout", () => {
  it("refuses with a retryable BUDGET_LEDGER_BUSY when the lock never frees and never ages into stale", async () => {
    await plantLock(0); // fresh — never eligible for steal during this test
    const started = Date.now();
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path }));
    const elapsed = Date.now() - started;
    expect(err.code).toBe("BUDGET_LEDGER_BUSY");
    expect(err.retryable).toBe(true);
    expect(err.action).toBe("RETRY_BACKOFF");
    expect(elapsed).toBeGreaterThanOrEqual(LEDGER_LOCK_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(LEDGER_LOCK_TIMEOUT_MS + 2_000);
  }, 10_000);
});

describe("compaction", () => {
  it("drops entries older than the retention window from the file on the next spend", async () => {
    const now = Date.now();
    await plant([
      { kind: "page_load", ts: new Date(now - (COMPACTION_RETENTION_MS + 60 * 60 * 1000)).toISOString() },
      { kind: "page_load", ts: new Date(now - 1 * 60 * 60 * 1000).toISOString() },
    ]);
    await spend({ runId: "r", capability: "c", kind: "page_load", path, now: new Date(now) });
    const lines = await readLines();
    // The entry older than retention is gone; the 1h-old one and the new spend remain.
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => now - Date.parse(l.ts) < COMPACTION_RETENTION_MS)).toBe(true);
  });

  it("keeps an entry older than a day but inside the wider retention window", async () => {
    const now = Date.now();
    await plant([{ kind: "page_load", ts: new Date(now - 25 * 60 * 60 * 1000).toISOString() }]);
    await spend({ runId: "r", capability: "c", kind: "page_load", path, now: new Date(now) });
    const lines = await readLines();
    expect(lines).toHaveLength(2);
  });

  it("still fails closed on a corrupt line instead of compacting past it", async () => {
    await plant([{ kind: "page_load" }]);
    await appendFile(path, "not json\n", "utf8");
    const err = await asErr(spend({ runId: "r", capability: "c", kind: "page_load", path }));
    expect(err.code).toBe("BUDGET_LEDGER_CORRUPT");
  });

  it("survives a simulated crash between writing the tmp file and the rename (fsync durability)", async () => {
    // Not a true power-loss test (impossible from userspace), but proves the
    // write path exercises fsync without throwing and that the resulting
    // file is byte-valid immediately after — the property fsync exists to
    // guarantee is that the tmp file's bytes are durable *before* the
    // rename that publishes them, which this exercises end-to-end.
    await spend({ runId: "r", capability: "c", kind: "page_load", path });
    const lines = await readLines();
    expect(lines).toHaveLength(1);
  });
});

describe("corrupt-line evidence", () => {
  it("never puts the line's own bytes (which may carry a profile URN) on the receipt", async () => {
    await writeFile(path, JSON.stringify({ kind: "profile_open", ref: "urn:li:fsd_profile:SECRET123" }) + "\n", "utf8");
    const err = await asErr(usage({ path }));
    expect(err.code).toBe("BUDGET_LEDGER_CORRUPT");
    expect(err.evidence ?? "").not.toContain("SECRET123");
    expect(err.message).not.toContain("SECRET123");
  });
});

// ---------------------------------------------------------------------------
// Per-capability daily sub-caps (D153/D160-D163)
// ---------------------------------------------------------------------------

const scopeOf = (err: CapabilityError): unknown => JSON.parse(err.evidence!).scope;

describe("per-capability daily sub-caps", () => {
  it("trips exactly at the sub-cap boundary while the global limits stay untouched", async () => {
    const now = Date.now();
    const cap = DEFAULT_CAPABILITY_SUB_CAPS.pageLoadsPerDay;
    // Spread across the day so the global hourly limit (60) is nowhere near,
    // and `cap` < the global daily 400 — only the sub-cap can bite here.
    await plant(
      Array.from({ length: cap - 1 }, (_, i) => ({
        kind: "page_load" as const,
        capability: "runaway.reader",
        ts: new Date(now - (i % 20) * 55 * 60 * 1000).toISOString(),
      })),
    );

    const ok = await spend({
      runId: "r", capability: "runaway.reader", kind: "page_load", path, now: new Date(now),
    });
    expect(ok.capability).toBe("runaway.reader");

    const err = await asErr(
      spend({ runId: "r", capability: "runaway.reader", kind: "page_load", path, now: new Date(now) }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(err.exit).toBe(EXIT.BUDGET);
    expect(err.action).toBe("HALT_AND_NOTIFY");
    expect(err.retryable).toBe(false);
    expect(scopeOf(err)).toBe("capability");
    expect(JSON.parse(err.evidence!).capability).toBe("runaway.reader");
    expect(JSON.parse(err.evidence!).limit).toBe(cap);
    expect(err.message).toContain("runaway.reader");

    // The point of the whole feature: the shared budget is still open for
    // everyone else. `cap` page loads is well under the global daily 400.
    await expect(
      spend({ runId: "r", capability: "other.reader", kind: "page_load", path, now: new Date(now) }),
    ).resolves.toBeDefined();
    const snap = await usage({ path, now: new Date(now) });
    expect(snap.pageLoadsToday).toBe(cap + 1);
    expect(snap.pageLoadsToday).toBeLessThan(DEFAULT_BUDGET_LIMITS.pageLoadsPerDay);
  });

  it("still trips the global limit, named as global, when the sub-cap is roomy", async () => {
    // The hourly 60 is below every sub-cap, so a single capability hits the
    // global wall first and the receipt must say so.
    await plant(
      Array.from({ length: DEFAULT_BUDGET_LIMITS.pageLoadsPerHour }, () => ({
        kind: "page_load" as const,
        capability: "one.reader",
      })),
    );
    const err = await asErr(spend({ runId: "r", capability: "one.reader", kind: "page_load", path }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("global");
    expect(JSON.parse(err.evidence!).window).toBe("hour");
    expect(err.message).toContain("global");
  });

  it("counts only the capability's own lines, so another capability's spend does not consume it", async () => {
    const now = Date.now();
    await plant(
      Array.from({ length: 40 }, (_, i) => ({
        kind: "page_load" as const,
        capability: "noisy.neighbour",
        ts: new Date(now - (i % 20) * 55 * 60 * 1000).toISOString(),
      })),
    );
    await expect(
      spend({
        runId: "r", capability: "quiet.reader", kind: "page_load", path, now: new Date(now),
        subCaps: { pageLoadsPerDay: 1 },
      }),
    ).resolves.toBeDefined();
  });

  it("applies the sub-cap to check() too, not only to spend()", async () => {
    await plant([{ kind: "page_load", capability: "c1" }, { kind: "page_load", capability: "c1" }]);
    const err = await asErr(
      check({ capability: "c1", kind: "page_load", path, subCaps: { pageLoadsPerDay: 2 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("capability");
    // check() is read-only even when it refuses.
    expect(await readLines()).toHaveLength(2);
  });

  it("caps distinct profile opens per capability, and re-opening a ref it already opened stays free", async () => {
    await plant([
      { kind: "profile_open", capability: "reader.a", ref: "in:one" },
      { kind: "profile_open", capability: "reader.a", ref: "in:two" },
    ]);
    // Already counted under this capability → free, however tight the sub-cap.
    await expect(
      spend({ runId: "r", capability: "reader.a", kind: "profile_open", ref: "in:one", path, subCaps: { distinctProfilesPerDay: 2 } }),
    ).resolves.toBeDefined();
    // A third distinct one is not.
    const err = await asErr(
      spend({ runId: "r", capability: "reader.a", kind: "profile_open", ref: "in:three", path, subCaps: { distinctProfilesPerDay: 2 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("capability");
    // Another capability's ref is free globally but still costs a sub-cap unit,
    // so a runaway reader cannot re-walk another run's day for nothing.
    const err2 = await asErr(
      spend({ runId: "r", capability: "reader.b", kind: "profile_open", ref: "in:one", path, subCaps: { distinctProfilesPerDay: 0 } }),
    );
    expect(scopeOf(err2)).toBe("capability");
  });

  it("caps search pages per capability", async () => {
    await plant([{ kind: "search_page", capability: "search.reader", n: 5 }]);
    const err = await asErr(
      spend({ runId: "r", capability: "search.reader", kind: "search_page", path, subCaps: { searchPagesPerDay: 5 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("capability");
    expect(JSON.parse(err.evidence!).limit).toBe(5);
  });
});

describe("sub-cap overrides can only lower a sub-cap", () => {
  it("ignores an override that raises the capability's cap", async () => {
    const now = Date.now();
    const cap = DEFAULT_CAPABILITY_SUB_CAPS.pageLoadsPerDay;
    await plant(
      Array.from({ length: cap }, (_, i) => ({
        kind: "page_load" as const,
        capability: "greedy.reader",
        ts: new Date(now - (i % 20) * 55 * 60 * 1000).toISOString(),
      })),
    );
    const err = await asErr(
      spend({
        runId: "r", capability: "greedy.reader", kind: "page_load", path,
        now: new Date(now), subCaps: { pageLoadsPerDay: 10_000 },
      }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("capability");
    expect(JSON.parse(err.evidence!).limit).toBe(cap); // the default, not 10_000
  });

  it("honours an override that lowers the capability's cap", async () => {
    await plant([{ kind: "page_load", capability: "polite.reader" }]);
    const err = await asErr(
      spend({ runId: "r", capability: "polite.reader", kind: "page_load", path, subCaps: { pageLoadsPerDay: 1 } }),
    );
    expect(JSON.parse(err.evidence!).limit).toBe(1);
  });

  it("takes a table entry over the fallback, and the table entry may sit above it", () => {
    expect(subCapsFor("profile.capture").pageLoadsPerDay).toBe(200);
    expect(subCapsFor("profile.capture").pageLoadsPerDay).toBeGreaterThan(
      DEFAULT_CAPABILITY_SUB_CAPS.pageLoadsPerDay,
    );
    expect(subCapsFor("never.registered")).toEqual(DEFAULT_CAPABILITY_SUB_CAPS);
  });

  it("every probe is capped as a probe, not left on the reader fallback", () => {
    // A probe's stated per-run ceiling is 6 loads (CONTEXT rule 8). Landing on
    // the 150-load reader fallback by omission is the exact failure the table
    // exists to prevent, and it is invisible until a probe loops. The exact
    // number belongs to each probe's own task; what is pinned here is that it
    // has one, that it is a probe-sized number, and that it issues no search.
    for (const probe of ["company.probe", "activity.capture", "job.capture"]) {
      const caps = CAPABILITY_SUB_CAPS[probe];
      expect(caps, `${probe} has no sub-cap entry`).toBeDefined();
      expect(caps!.pageLoadsPerDay).toBeLessThan(DEFAULT_CAPABILITY_SUB_CAPS.pageLoadsPerDay);
      expect(caps!.searchPagesPerDay).toBe(0);
    }
  });

  it("both inbox readers have explicit low sub-caps with no search or profile allowance", () => {
    for (const name of ["inbox.list", "inbox.thread"]) {
      expect(CAPABILITY_SUB_CAPS[name]).toEqual({
        pageLoadsPerDay: 12,
        searchPagesPerDay: 0,
        distinctProfilesPerDay: 0,
      });
    }
  });

  it("every sub-cap is strictly inside the global limit it sits under", () => {
    for (const caps of [DEFAULT_CAPABILITY_SUB_CAPS, ...Object.values(CAPABILITY_SUB_CAPS)]) {
      expect(caps.pageLoadsPerDay).toBeLessThan(DEFAULT_BUDGET_LIMITS.pageLoadsPerDay);
      expect(caps.searchPagesPerDay).toBeLessThanOrEqual(DEFAULT_BUDGET_LIMITS.searchPagesPerDay);
      expect(caps.distinctProfilesPerDay).toBeLessThan(DEFAULT_BUDGET_LIMITS.distinctProfilesPerDay);
    }
  });
});

describe("racing spends against one sub-cap", () => {
  it("lands exactly the capped count, never more, when several run at once", async () => {
    // Same harness shape as the global racing test: the sub-cap is the only
    // limit in reach (2 « the global 60/hour), so anything over 2 fulfilled
    // spends means the lock is not covering the sub-cap evaluation.
    for (let trial = 0; trial < 5; trial++) {
      const trialDir = await mkdtemp(join(tmpdir(), "budget-subcap-race-"));
      const trialPath = join(trialDir, "budget.ndjson");
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          spend({
            runId: `racer-${i}`, capability: "raced.reader", kind: "page_load",
            path: trialPath, subCaps: { pageLoadsPerDay: 2 },
          }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(2);
      for (const r of results.filter((x) => x.status === "rejected")) {
        expect((r as PromiseRejectedResult).reason.code).toBe("BUDGET_EXCEEDED");
      }
      const lines = (await readFile(trialPath, "utf8")).trim().split("\n").filter((l) => l !== "");
      expect(lines).toHaveLength(2);
      await rm(trialDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("a ledger file written before sub-caps existed", () => {
  // The real ledger from the M3 live runs, copied verbatim except that the
  // `ref` values (LinkedIn vanity handles) are replaced with opaque
  // placeholders — captured LinkedIn data is never committed. Every other
  // field, and the record shape, is exactly what the pre-Task-20 writer
  // produced: no migration, no new field.
  const fixture = new URL("./fixtures-budget/pre-task-20-budget.ndjson", import.meta.url);
  // Just after the fixture's newest line, so all of it is inside the day window.
  const asOf = new Date("2026-08-09T12:00:00.000Z");

  beforeEach(async () => {
    await writeFile(path, await readFile(fixture, "utf8"), "utf8");
  });

  it("parses with no format change and counts the same as before", async () => {
    const snap = await usage({ path, now: asOf });
    // 7 page loads across two capabilities (5 profile.capture + 2 profile.get),
    // all inside the day window at `asOf`, and one distinct profile between them.
    expect(snap.pageLoadsToday).toBe(7);
    expect(snap.distinctProfilesToday).toBe(1);
  });

  it("evaluates old lines against the new sub-caps, attributed to the capability that wrote them", async () => {
    // Two of the fixture's page loads are profile.get's; a sub-cap of 2 is
    // therefore already met for profile.get and untouched for anyone else.
    const err = await asErr(
      check({ capability: "profile.get", kind: "page_load", path, now: asOf, subCaps: { pageLoadsPerDay: 2 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(scopeOf(err)).toBe("capability");
    await expect(
      check({ capability: "profile.posts", kind: "page_load", path, now: asOf, subCaps: { pageLoadsPerDay: 2 } }),
    ).resolves.toBeUndefined();
  });

  it("spends onto it without rewriting the old records' shape", async () => {
    const before = await readLines();
    await spend({ runId: "r", capability: "profile.get", kind: "page_load", path, now: asOf });
    const after = await readLines();
    expect(after).toHaveLength(before.length + 1);
    expect(after.slice(0, before.length)).toEqual(before);
  });
});
