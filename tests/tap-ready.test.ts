import { describe, expect, it, vi } from "vitest";
import { waitForAny } from "../src/core/tap/ready.js";
import { CapabilityError, EXIT } from "../src/core/run/receipt.js";

/**
 * D321. Measured three times on 2026-08-10 — twice on profiles, once on a job —
 * the page's own document arrived fully populated, no Voyager call followed, and
 * the run failed CAPTURE_TIMEOUT with the page load already spent. The DOM
 * readers parse that document, so those runs failed holding what they came for.
 */
function timeout(name: string): CapabilityError {
  return new CapabilityError({
    code: "CAPTURE_TIMEOUT",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: `no response matching "${name}" was captured within 25000ms`,
  });
}

/** Answers per pattern name: a value resolves, an Error rejects, a number is a
 *  delay in ms before resolving — enough to make "first one wins" observable. */
function tap(answers: Record<string, unknown>) {
  const asked: string[] = [];
  return {
    asked,
    waitFor: vi.fn(async (pattern: string) => {
      asked.push(pattern);
      const answer = answers[pattern];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "number") {
        await new Promise((r) => setTimeout(r, answer));
        return `${pattern}:late`;
      }
      return answer;
    }),
  };
}

describe("waitForAny", () => {
  it("resolves on the document when no api call ever comes", async () => {
    const t = tap({ "linkedin-api": timeout("linkedin-api"), "profile-document": "the document" });
    await expect(waitForAny(t, ["linkedin-api", "profile-document"], { since: 0 })).resolves.toBe(
      "the document",
    );
  });

  it("still resolves on the api when that is what arrives", async () => {
    const t = tap({ "linkedin-api": "a voyager body", "profile-document": timeout("profile-document") });
    await expect(waitForAny(t, ["linkedin-api", "profile-document"], { since: 0 })).resolves.toBe(
      "a voyager body",
    );
  });

  it("takes whichever is first, not whichever is listed first", async () => {
    const t = tap({ "linkedin-api": 50, "profile-document": "the document" });
    await expect(waitForAny(t, ["linkedin-api", "profile-document"], { since: 0 })).resolves.toBe(
      "the document",
    );
  });

  it("waits on every pattern given, so a late arrival on either one counts", async () => {
    const t = tap({ "linkedin-api": "body", "profile-document": "doc" });
    await waitForAny(t, ["linkedin-api", "profile-document"], { since: 3, timeoutMs: 100 });
    expect(t.asked).toEqual(["linkedin-api", "profile-document"]);
    expect(t.waitFor).toHaveBeenCalledWith("linkedin-api", { since: 3, timeoutMs: 100 });
  });

  it("fails with the real timeout when the page answered with nothing at all", async () => {
    const t = tap({ "linkedin-api": timeout("linkedin-api"), "profile-document": timeout("profile-document") });
    await expect(
      waitForAny(t, ["linkedin-api", "profile-document"], { since: 0 }),
    ).rejects.toMatchObject({ code: "CAPTURE_TIMEOUT", exit: EXIT.TRANSIENT, retryable: true });
  });

  it("refuses an empty pattern list rather than resolving on nothing", async () => {
    await expect(waitForAny(tap({}), [], { since: 0 })).rejects.toMatchObject({
      code: "TAP_NO_READY_PATTERN",
    });
  });
});
