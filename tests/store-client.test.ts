import { afterEach, describe, expect, it } from "vitest";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";
import { getStore, resetStore, storeError } from "../src/core/store/client.js";
import { isStoreConfigured, readStoreConfig, requireStoreConfig } from "../src/core/store/config.js";

const CONFIGURED = {
  SUPABASE_URL: "http://127.0.0.1:55321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

afterEach(() => resetStore());

describe("configuration probe — so a skip-store run never crashes", () => {
  it("reports configured when both variables are present", () => {
    expect(isStoreConfigured(CONFIGURED)).toBe(true);
    expect(readStoreConfig(CONFIGURED)).toEqual({
      url: "http://127.0.0.1:55321",
      serviceRoleKey: "service-role-key",
    });
  });

  const unconfigured: Array<[Record<string, string | undefined>, string]> = [
    [{ SUPABASE_SERVICE_ROLE_KEY: "k" }, "no url"],
    [{ SUPABASE_URL: "http://x" }, "no key"],
    [{}, "neither"],
    [{ SUPABASE_URL: "  ", SUPABASE_SERVICE_ROLE_KEY: "k" }, "blank url"],
    [{ SUPABASE_URL: "http://x", SUPABASE_SERVICE_ROLE_KEY: "" }, "blank key"],
  ];

  it.each(unconfigured)("reports unconfigured (%s) instead of throwing", (env) => {
    expect(isStoreConfigured(env)).toBe(false);
    expect(readStoreConfig(env)).toBeNull();
  });

  it("names both variables when a caller demands a configured store", () => {
    let thrown: unknown;
    try {
      requireStoreConfig({});
    } catch (e) {
      thrown = e;
    }
    const err = thrown as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("STORE_NOT_CONFIGURED");
    expect(err.exit).toBe(EXIT.GENERIC);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("SUPABASE_URL");
    expect(err.message).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("builds one client per configuration and reuses it", () => {
    const a = getStore({ config: readStoreConfig(CONFIGURED)! });
    const b = getStore({ config: readStoreConfig(CONFIGURED)! });
    expect(a).toBe(b);
    const c = getStore({
      config: { url: "http://127.0.0.1:9999", serviceRoleKey: "other" },
    });
    expect(c).not.toBe(a);
  });

  it("refuses to build a client with no configuration", () => {
    expect(() => getStore({ env: {} })).toThrow(CapabilityError);
  });
});

describe("storeError — one code per operator action (D13)", () => {
  const cases: Array<[string, { code?: string; message?: string }, number, string, boolean, number]> = [
    // label, postgrest error, http status, expected code, retryable, exit
    [
      "connection refused (supabase not running)",
      { code: "", message: "TypeError: fetch failed" },
      0,
      "STORE_UNAVAILABLE",
      true,
      EXIT.TRANSIENT,
    ],
    [
      "postgres is restarting",
      { code: "08006", message: "connection failure" },
      503,
      "STORE_UNAVAILABLE",
      true,
      EXIT.TRANSIENT,
    ],
    [
      "too many connections",
      { code: "53300", message: "too many clients" },
      503,
      "STORE_UNAVAILABLE",
      true,
      EXIT.TRANSIENT,
    ],
    [
      "gateway error with no sqlstate",
      { code: "", message: "Bad Gateway" },
      502,
      "STORE_UNAVAILABLE",
      true,
      EXIT.TRANSIENT,
    ],
    [
      "wrong or missing service role key",
      { code: "PGRST301", message: "JWS: signature verification failed" },
      401,
      "STORE_UNAUTHORIZED",
      false,
      EXIT.GENERIC,
    ],
    [
      "rls or a revoked grant blocking the write",
      { code: "42501", message: "permission denied for table persons" },
      403,
      "STORE_UNAUTHORIZED",
      false,
      EXIT.GENERIC,
    ],
    [
      "migration not applied",
      { code: "42P01", message: "relation does not exist" },
      404,
      "STORE_SCHEMA_MISMATCH",
      false,
      EXIT.GENERIC,
    ],
    [
      "column this build expects is not there",
      { code: "42703", message: "column does not exist" },
      400,
      "STORE_SCHEMA_MISMATCH",
      false,
      EXIT.GENERIC,
    ],
    [
      "postgrest has a stale schema cache",
      { code: "PGRST204", message: "column not found in schema cache" },
      400,
      "STORE_SCHEMA_MISMATCH",
      false,
      EXIT.GENERIC,
    ],
    [
      "a value we sent is not a valid date",
      { code: "22007", message: "invalid input syntax for type date" },
      400,
      "STORE_WRITE_REJECTED",
      false,
      EXIT.GENERIC,
    ],
    [
      "a value we sent overflows its column",
      { code: "22003", message: "numeric field overflow" },
      400,
      "STORE_WRITE_REJECTED",
      false,
      EXIT.GENERIC,
    ],
    [
      "a constraint says the row is wrong",
      { code: "23505", message: "duplicate key value violates unique constraint" },
      409,
      "STORE_WRITE_REJECTED",
      false,
      EXIT.GENERIC,
    ],
  ];

  it.each(cases)("classifies %s", (_label, pgError, status, code, retryable, exit) => {
    const err = storeError({ op: "upsert", table: "persons", kind: "write", status, cause: pgError });
    expect(err.code).toBe(code);
    expect(err.retryable).toBe(retryable);
    expect(err.exit).toBe(exit);
    expect(err.action).toBe(retryable ? "RETRY_BACKOFF" : "HALT_AND_NOTIFY");
  });

  it("falls back to a per-direction code when nothing matches", () => {
    const w = storeError({ op: "upsert", table: "persons", kind: "write", status: 400, cause: { code: "XX000", message: "internal error" } });
    const r = storeError({ op: "select", table: "persons", kind: "read", status: 400, cause: { code: "XX000", message: "internal error" } });
    expect(w.code).toBe("STORE_WRITE_FAILED");
    expect(r.code).toBe("STORE_READ_FAILED");
    expect(w.retryable).toBe(false);
  });

  it("classifies a thrown transport exception, not only a returned error object", () => {
    const err = storeError({
      op: "upsert",
      table: "persons",
      kind: "write",
      cause: new TypeError("fetch failed"),
    });
    expect(err.code).toBe("STORE_UNAVAILABLE");
    expect(err.retryable).toBe(true);
  });

  it("never leaks a captured value into the message or the evidence", () => {
    // Postgres puts the offending key values straight into its message, and
    // PostgREST hands that through verbatim. Receipts go to stdout (D3).
    const err = storeError({
      op: "upsert",
      table: "persons",
      kind: "write",
      status: 409,
      cause: {
        code: "23505",
        message: "duplicate key value violates unique constraint \"persons_pkey\"",
        details: "Key (urn)=(urn:li:fsd_profile:ACoAAB1234) already exists.",
        hint: "Ada Lovelace",
      },
    });
    const surface = `${err.message} ${err.evidence ?? ""}`;
    expect(surface).not.toContain("urn:li:fsd_profile:ACoAAB1234");
    expect(surface).not.toContain("Ada Lovelace");
    expect(surface).not.toContain("duplicate key value");
    // What it must still say: which table, which operation, which sqlstate.
    expect(err.message).toContain("persons");
    expect(err.evidence).toContain("23505");
  });

  it("keeps the raw driver error reachable as a non-enumerable cause", () => {
    const cause = { code: "23505", details: "Key (urn)=(urn:li:fsd_profile:X) already exists." };
    const err = storeError({ op: "upsert", table: "persons", kind: "write", status: 409, cause });
    expect(err.cause).toBe(cause);
    expect(JSON.stringify(err)).not.toContain("fsd_profile");
    expect(Object.keys(err)).not.toContain("cause");
  });
});
