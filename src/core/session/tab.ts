import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CdpEvent, Unsubscribe } from "../cdp/client.js";
import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  FOREGROUND_SETTLE_MS,
  INTERACTIVE_SETTLE_MS,
  NAVIGATE_TIMEOUT_MS,
  NETWORK_RESOURCE_BUFFER_BYTES,
  NETWORK_TOTAL_BUFFER_BYTES,
  READY_POLL_INTERVAL_MS,
  TEARDOWN_STEP_TIMEOUT_MS,
} from "./constants.js";

/**
 * How a navigation finished waiting.
 *
 * `settledOn` is reported rather than swallowed because the two are not equally
 * good news: `complete` is a page that finished, `interactive` is a page that
 * parsed and then held a connection open forever. A capability that settles on
 * `interactive` has a working page and a fact worth putting on its receipt.
 */
export type Navigation = {
  settledOn: "complete" | "interactive";
  readyState: string;
  waitedMs: number;
};

/**
 * The slice of `CdpClient` the tab uses. Structural on purpose: the attach
 * sequence and the foreground escalation are safety properties (D8, D10), and a
 * structural type is what lets them be pinned by an offline test against a
 * recording double instead of only by prose.
 */
export type CdpTransport = {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
  on(listener: (event: CdpEvent) => void): Unsubscribe;
};

/** What the page itself believes about its visibility — the only opinion that
 *  decides whether `IntersectionObserver` fires. */
export type ForegroundState = { hidden: boolean; focused: boolean; visibility: string };

export type ForegroundResult = {
  ok: boolean;
  /** Which escalation step got there; `"already"` means nothing had to change. */
  via: "already" | "focus-emulation" | "web-lifecycle" | "activate-target" | null;
  state: ForegroundState | null;
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message,
    evidence,
  });
}

function fatal(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
    evidence,
  });
}

/** Best-effort teardown step: never throws, never outlives its budget. */
async function attempt(run: () => Promise<unknown>): Promise<void> {
  try {
    // Unref'd, because the loser of this race is never cancelled: a teardown that
    // finished in 3ms would otherwise hold the event loop open for the rest of the
    // budget. Invisible under the CLI, where emitReceipt exits the process, and
    // exactly the kind of thing that makes a module unusable as a library.
    await Promise.race([run(), delay(TEARDOWN_STEP_TIMEOUT_MS, undefined, { ref: false })]);
  } catch {
    /* teardown reports nothing; the run's outcome was decided before this */
  }
}

/**
 * A handle on the single resident worker tab (D10): session-scoped commands,
 * expression evaluation, navigation, screenshots, and foreground management.
 *
 * Everything a capability does to a page goes through here, which is what keeps
 * the attach surface a property of one file. `attach()` below is the only place
 * a domain is ever enabled, and it enables exactly one.
 */
export class WorkerTab {
  readonly targetId: string;
  readonly sessionId: string;

  readonly #cdp: CdpTransport;
  readonly #unsubscribe: Unsubscribe;
  #focusEmulated = false;
  #gone: CapabilityError | undefined;

  private constructor(cdp: CdpTransport, targetId: string, sessionId: string) {
    this.#cdp = cdp;
    this.targetId = targetId;
    this.sessionId = sessionId;

    // `Target.detachedFromTarget` arrives for an attached session without any
    // domain being enabled — target *discovery* would need one, this does not.
    // Without it a closed tab is only discovered as a puzzling command failure.
    this.#unsubscribe = cdp.on((event) => {
      if (
        event.method === "Target.detachedFromTarget" &&
        event.params["sessionId"] === this.sessionId
      ) {
        this.#gone = transient(
          "TAB_DETACHED",
          `the worker tab ${this.targetId} detached (closed, crashed, or navigated away from us)`,
        );
      }
    });
  }

  /**
   * Attaches to an existing target and brings it up to working state.
   *
   * The enable list here is the whole attach surface (D8): `Network` and nothing
   * else. `Runtime.enable` leaks `consoleAPICalled`, the classic CDP tell, and
   * `Runtime.evaluate` does not need it. `Page.enable` buys page lifecycle events
   * this module deliberately polls for instead — see `navigate`.
   */
  static async attach(cdp: CdpTransport, targetId: string): Promise<WorkerTab> {
    let sessionId: string;
    try {
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      sessionId = attached.sessionId;
    } catch (cause) {
      throw rethrow("TAB_ATTACH_FAILED", `attaching to target ${targetId} failed`, cause);
    }

    const tab = new WorkerTab(cdp, targetId, sessionId);
    try {
      await tab.send("Network.enable", {
        maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
        maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
      });
      // Immediately, before anything loads: a background tab has its timers
      // clamped and never fires IntersectionObserver, which is exactly how
      // LinkedIn lazy-renders (0.9s measured as 43.9s in that state). It is also
      // a tell in its own right — nobody reads 25 profiles with
      // visibilityState === "hidden".
      await tab.setFocusEmulation(true);
    } catch (cause) {
      // A half-attached tab is worse than none: it would render like a background
      // tab and quietly produce empty captures.
      tab.#unsubscribe();
      throw cause;
    }
    return tab;
  }

  /** Sends a command scoped to this tab's session. */
  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (this.#gone) throw this.#gone;
    return this.#cdp.send<T>(method, params, this.sessionId, timeoutMs);
  }

  /**
   * Evaluates an expression in the page and returns its value.
   *
   * A page-side throw is a failure of this call, not of the transport: it comes
   * back as a successful CDP reply carrying `exceptionDetails`, and turning that
   * into a resolved `undefined` is how a caller ends up storing nulls it thinks
   * are real.
   */
  async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const r = await this.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);

    if (r.exceptionDetails) {
      const detail =
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown page error";
      throw transient("TAB_EVAL_FAILED", `page JS threw during evaluate: ${detail}`, detail);
    }
    return r.result.value as T;
  }

  /**
   * Navigates the tab and waits for the document to finish loading.
   *
   * Readiness is polled rather than awaited on `Page.loadEventFired`, because
   * consuming that event would mean `Page.enable` (D8). Evaluation failures while
   * polling are expected — the execution context is torn down and rebuilt mid
   * navigation — so they count as "not ready yet", never as an error.
   *
   * Settles on `complete`, or on `interactive` once it has held for
   * `INTERACTIVE_SETTLE_MS` — LinkedIn's activity feed keeps a connection open and
   * never fires the load event, and failing a capture whose bytes are already
   * archived spends a metered page load to report nothing (D302). Which of the two
   * it settled on is returned rather than hidden, so a caller can put it on a
   * receipt.
   */
  async navigate(url: string, timeoutMs = NAVIGATE_TIMEOUT_MS): Promise<Navigation> {
    const r = await this.send<{ errorText?: string }>("Page.navigate", { url });
    if (r.errorText) {
      throw transient(
        "TAB_NAVIGATE_FAILED",
        `navigating the worker tab to ${url} failed: ${r.errorText}`,
        r.errorText,
      );
    }

    const started = Date.now();
    const deadline = started + timeoutMs;
    let interactiveSince: number | null = null;

    while (Date.now() < deadline) {
      let state: string | null = null;
      try {
        state = await this.evaluate<string>("document.readyState");
      } catch {
        /* context swapped underneath us mid-navigation; keep waiting */
      }

      if (state === "complete") {
        return { settledOn: "complete", readyState: "complete", waitedMs: Date.now() - started };
      }

      if (state === "interactive") {
        interactiveSince ??= Date.now();
        if (Date.now() - interactiveSince >= INTERACTIVE_SETTLE_MS) {
          return {
            settledOn: "interactive",
            readyState: "interactive",
            waitedMs: Date.now() - started,
          };
        }
      } else {
        // Back to `loading` — a client-side navigation replaced the document, so
        // the interactive clock starts again rather than counting a stale page.
        interactiveSince = null;
      }

      await delay(READY_POLL_INTERVAL_MS);
    }
    throw transient(
      "TAB_NAVIGATE_TIMEOUT",
      `the worker tab did not finish loading ${url} within ${timeoutMs}ms`,
    );
  }

  /** The URL the page is actually on, read from the page rather than from CDP
   *  bookkeeping — redirects make those two different answers. */
  currentUrl(): Promise<string> {
    return this.evaluate<string>("document.location.href");
  }

  /** Writes a PNG screenshot to `path` and returns it. Used for challenge
   *  evidence, so it must work on a page that is otherwise unreadable. */
  async screenshot(path: string): Promise<string> {
    const { data } = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(data, "base64"));
    } catch (cause) {
      throw fatal("TAB_SCREENSHOT_UNWRITABLE", `writing the screenshot to ${path} failed`, String(cause));
    }
    return path;
  }

  /**
   * What the page believes about its own visibility. `null` when it cannot be
   * read at all — callers treat that exactly like "not foreground" rather than
   * failing, since an unreadable tab is never a tab worth trusting to render.
   */
  async foregroundState(): Promise<ForegroundState | null> {
    try {
      return await this.evaluate<ForegroundState>(
        `({ hidden: document.hidden, focused: document.hasFocus(), visibility: document.visibilityState })`,
      );
    } catch {
      return null;
    }
  }

  async setFocusEmulation(enabled: boolean): Promise<boolean> {
    try {
      await this.send("Emulation.setFocusEmulationEnabled", { enabled });
      this.#focusEmulated = enabled;
      return true;
    } catch {
      return false;
    }
  }

  get focusEmulated(): boolean {
    return this.#focusEmulated;
  }

  /**
   * Gets the tab reporting itself as foreground, verifying after each step.
   *
   * The order is the point, and it is least-intrusive first: emulation is
   * invisible to the operator, the web-lifecycle nudge is cheap and still
   * invisible, and `Target.activateTarget` is strictly last because it yanks the
   * operator's window to this tab. Never assert emulation and assume it worked —
   * that assumption is what produced skeleton rows in the reference worker.
   */
  async ensureForeground(): Promise<ForegroundResult> {
    const good = (s: ForegroundState | null): boolean => s !== null && s.hidden === false;

    let state = await this.foregroundState();
    if (good(state)) return { ok: true, via: "already", state };

    const steps: [ForegroundResult["via"], () => Promise<unknown>][] = [
      ["focus-emulation", () => this.setFocusEmulation(true)],
      ["web-lifecycle", () => this.send("Page.setWebLifecycleState", { state: "active" })],
      ["activate-target", () => this.#cdp.send("Target.activateTarget", { targetId: this.targetId })],
    ];

    for (const [via, run] of steps) {
      try {
        await run();
      } catch {
        continue;
      }
      await delay(FOREGROUND_SETTLE_MS);
      state = await this.foregroundState();
      if (good(state)) return { ok: true, via, state };
    }
    return { ok: false, via: null, state };
  }

  /**
   * Leaves the browser as it was found: emulation dropped, target closed, the
   * event subscription released. Nothing here throws — teardown running after a
   * failure must not replace the real reason the run ended.
   */
  async close(): Promise<void> {
    if (this.#focusEmulated && !this.#gone) {
      await attempt(() => this.send("Emulation.setFocusEmulationEnabled", { enabled: false }));
      this.#focusEmulated = false;
    }
    await attempt(() => this.#cdp.send("Target.closeTarget", { targetId: this.targetId }));
    this.#unsubscribe();
    // Fatal, not transient, and for the same reason `CDP_CLIENT_CLOSED` is: a tab
    // we closed ourselves is permanently gone, and `retryable` is what callers
    // branch on, so a transient class here spins a back-off loop against a
    // condition that can never change. `TAB_DETACHED` stays transient on purpose —
    // a tab that crashed or navigated out from under us may well come back on a
    // fresh attach — which is why these are separate codes rather than one code
    // with a different `retryable`.
    this.#gone ??= fatal("TAB_CLOSED", `the worker tab ${this.targetId} was closed by this session`);
  }
}

/**
 * Keeps a `CapabilityError` exactly as classified — the launcher and the
 * transport already decided retryability with context this layer does not have
 * (D13, D15) — and gives anything else a class of its own rather than letting a
 * raw CDP shape reach a capability.
 */
export function rethrow(code: string, message: string, cause: unknown): CapabilityError {
  if (cause instanceof CapabilityError) return cause;
  return transient(code, `${message}: ${String(cause)}`, String(cause));
}
