import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, appendFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, spend, usage, BudgetLedger, type SpendRecord } from "../src/core/budget/ledger.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import { DEFAULT_BUDGET_LIMITS } from "../src/core/budget/constants.js";

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
      check({ kind: "page_load", path, limits: { pageLoadsPerHour: 10_000 } }),
    );
    expect(err.code).toBe("BUDGET_EXCEEDED");
  });

  it("applies an override that lowers the default", async () => {
    await plant([{ kind: "page_load" }, { kind: "page_load" }]);
    const err = await asErr(check({ kind: "page_load", path, limits: { pageLoadsPerHour: 2 } }));
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(JSON.parse(err.evidence!).limit).toBe(2);
  });
});

describe("check does not spend", () => {
  it("leaves the ledger untouched", async () => {
    await check({ kind: "page_load", path });
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
});
