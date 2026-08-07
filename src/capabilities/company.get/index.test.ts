import { describe, expect, it, vi } from "vitest";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import { StoreWriteError, type StoreClient, type StoredCompany } from "../../core/store/index.js";
import { createCompanyGetCapability, type CompanyGetDeps } from "./index.js";

const urn = "urn:li:fsd_company:42";
const candidate = { entityUrn: urn, universalName: "acme", name: "Acme" };
const island = JSON.stringify({ included: [{ ...candidate, description: "About Acme" }] })
  .replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const captures = [
  { url: "https://www.linkedin.com/voyager/api/graphql", body: JSON.stringify({ included: [candidate] }) },
  { url: "https://www.linkedin.com/company/acme/", body: `<code id="bpr-guid-1">${island}</code>` },
];
const client = {} as StoreClient;

function stored(last_seen = new Date().toISOString()): StoredCompany {
  return { company: { urn, name: "Acme", vanity: "acme", website: null, industry: null, size_range: null, hq: null, about: null, first_seen: last_seen, last_seen }, vanityMatches: 1 };
}
function setup(o: { cached?: StoredCompany | null; driftError?: CapabilityError; noStore?: boolean; configured?: boolean } = {}) {
  const capture = vi.fn(async () => ({
    captures, sessionUrns: [],
    result: { counts: { requested: 1, captured: 2, usable: 1, skipped: 0 }, warnings: [] },
  }));
  const deps: CompanyGetDeps = {
    storeConfigured: () => o.configured ?? true,
    store: () => client,
    findByUrn: vi.fn(async () => null),
    findByVanity: vi.fn(async () => o.cached ?? null),
    upsert: vi.fn(async () => ({ urn, rows: 1 as const })),
    recordDrift: vi.fn(async () => { if (o.driftError) throw o.driftError; return 0; }),
    capture,
  };
  const logs: unknown[] = [];
  const ctx = {
    args: { url: "acme", maxAge: "7d" }, flags: { noStore: !!o.noStore },
    run: { runId: "run", paths: { raw: "/tmp/run/raw" }, log: (...items: unknown[]) => logs.push(items) },
  } as never;
  return { deps, capture, ctx };
}

describe("company.get composition", () => {
  it("returns a fresh unambiguous company without invoking capture", async () => {
    const { deps, capture, ctx } = setup({ cached: stored() });
    const result = await createCompanyGetCapability(deps).run(ctx);
    expect(capture).not.toHaveBeenCalled();
    expect(result.counts).toEqual({ requested: 1, captured: 0, usable: 1, skipped: 0 });
    expect(result.data).toMatchObject({ from_cache: true });
  });

  it("parses, stores one company, and exposes no captured identity in data", async () => {
    const { deps, ctx } = setup();
    const result = await createCompanyGetCapability(deps).run(ctx);
    expect(deps.upsert).toHaveBeenCalledWith(expect.objectContaining({ urn, name: "Acme", vanity: "acme" }), client);
    expect(result.stored).toEqual({ table: "companies", run_ref: "run", rows: 1 });
    expect(JSON.stringify(result.data)).not.toContain(urn);
  });

  it("reports one primary row already stored when drift persistence fails", async () => {
    const failure = new CapabilityError({ code: "STORE_UNAVAILABLE", exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message: "down" });
    const { deps, ctx } = setup({ driftError: failure });
    await expect(createCompanyGetCapability(deps).run(ctx)).rejects.toMatchObject({ stored: 1 });
    await createCompanyGetCapability(deps).run(ctx).catch((error) => expect(error).toBeInstanceOf(StoreWriteError));
  });

  it("keeps capture and parsing active under no-store even when the store is configured", async () => {
    const { deps, capture, ctx } = setup({ noStore: true, configured: true });
    const result = await createCompanyGetCapability(deps).run(ctx);
    expect(capture).toHaveBeenCalledOnce();
    expect(deps.upsert).not.toHaveBeenCalled();
    expect(result.stored).toBeUndefined();
    expect(result.data).toMatchObject({ storage: { skipped: true, reason: "--no-store" } });
  });
});
