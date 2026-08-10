import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RawArchive } from "../src/core/archive/raw.js";
import { collectFixtureSessionIdentity } from "../src/core/fixtures/session-identity.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private fixture session identity", () => {
  it("reads an eligible messaging document through identity.ts without weakening shared exclusion", async () => {
    const root = mkdtempSync(join(tmpdir(), "fixture-session-"));
    roots.push(root);
    const archiveDir = join(root, "raw");
    const body = '<html><code id="bpr-guid-1">' + JSON.stringify({
      $type: "com.linkedin.voyager.common.Me",
      entityUrn: "urn:li:fsd_profile:SYNTHETIC_OPERATOR",
      publicIdentifier: "synthetic-operator",
    }).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + "</code></html>";
    await new RawArchive(archiveDir).archive({
      body,
      url: "https://www.linkedin.com/messaging/",
      status: 200,
    });

    await expect(collectFixtureSessionIdentity(archiveDir)).resolves.toEqual({ urns: [], vanities: [] });
    await expect(collectFixtureSessionIdentity(archiveDir, {
      eligiblePrivateEndpoint: (url) => new URL(url).pathname === "/messaging/",
    })).resolves.toEqual({
      urns: ["urn:li:fsd_profile:SYNTHETIC_OPERATOR"],
      vanities: ["synthetic-operator"],
    });
  });
});
