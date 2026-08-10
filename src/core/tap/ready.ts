import { CapabilityError, EXIT } from "../run/receipt.js";

/** The slice of the tap this needs. Structural, so the gate is testable without
 *  a browser — which is the only way it gets tested at all. */
export type ReadyTap = {
  waitFor(pattern: string, opts: { since?: number; timeoutMs?: number }): Promise<unknown>;
};

/**
 * Waits for whichever of several watched patterns answers first.
 *
 * The gate this replaces waited on the broad API pattern alone, and threw away
 * pages that answered without an API call at all. Measured three times on
 * 2026-08-10 — twice on profiles, once on a job — the page's own document
 * arrived, fully populated and archived, no Voyager call followed inside 25s,
 * and the run failed `CAPTURE_TIMEOUT` at exit 6 with the page load already
 * spent. The document is what the DOM readers parse (D123, D130, D305, D313), so
 * those runs failed holding exactly what they came for (D321).
 *
 * This is a readiness gate, not a safety gate. It requests nothing, relaxes no
 * rule, and leaves the challenge gates on either side of it untouched: all it
 * changes is which arrival counts as "the page has answered".
 *
 * Rejects only when every pattern timed out, and with the first real failure so
 * the operator sees the wait they recognize rather than an aggregate.
 */
export async function waitForAny(
  tap: ReadyTap,
  patterns: readonly string[],
  opts: { since?: number; timeoutMs?: number },
): Promise<unknown> {
  if (patterns.length === 0) {
    throw new CapabilityError({
      code: "TAP_NO_READY_PATTERN",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: "waitForAny was given no pattern to wait for",
    });
  }
  return await Promise.any(patterns.map((name) => tap.waitFor(name, opts))).catch(
    (cause: unknown) => {
      const errors = cause instanceof AggregateError ? cause.errors : [cause];
      const first = errors.find((e): e is CapabilityError => e instanceof CapabilityError);
      throw (
        first ??
        new CapabilityError({
          code: "CAPTURE_TIMEOUT",
          exit: EXIT.TRANSIENT,
          action: "RETRY_BACKOFF",
          retryable: true,
          message: `no response matching ${patterns.join(" or ")} was captured`,
        })
      );
    },
  );
}
