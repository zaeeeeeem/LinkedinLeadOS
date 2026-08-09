import { describe, expect, it, vi } from "vitest";
import { createJobGetCapability, type JobGetDeps } from "./index.js";
import type { StoreClient } from "../../core/store/client.js";

const ID = "4450930857";
const html = `<html><body><a href="?x=urn%3Ali%3Afsd_jobPosting%3A${ID}">report</a><section><h2>About the job</h2><p><span data-testid="expandable-text-box"></span></p></section></body></html>`;

describe("job.get drift gate", () => {
  it("records a missing description and halts before jobs storage", async () => {
    const client = {} as StoreClient;
    const deps: JobGetDeps = {
      storeConfigured: () => true,
      store: () => client,
      upsert: vi.fn(async () => ({ id: ID, rows: 1 as const })),
      recordDrift: vi.fn(async () => 1),
      capture: vi.fn(async () => ({
        counts: { requested: 1, captured: 1, usable: 1, skipped: 0 },
        data: { snapshot: { archived: "snapshot.html" }, capture: { captured: 1, misses: 0 } },
      })),
    };
    const capability = createJobGetCapability(deps);
    const context = {
      args: { url: `https://www.linkedin.com/jobs/view/${ID}/` },
      flags: { noStore: false },
      run: { runId: "run", paths: { raw: "/tmp/run/raw" }, log: vi.fn() },
      browser: { archive: { readText: vi.fn(async () => html), list: vi.fn(async () => [{ file: "snapshot.html", shapeHash: "shape" }]) } },
    };

    const error = await capability.run(context as never).catch((cause) => cause);
    expect(error).toMatchObject({ code: "JOB_DESCRIPTION_UNAVAILABLE", exit: 5 });
    expect(deps.recordDrift).toHaveBeenCalledWith(
      [expect.objectContaining({ field: "description" })], client, "shape",
    );
    expect(deps.upsert).not.toHaveBeenCalled();
  });
});
