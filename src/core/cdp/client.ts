import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  CONNECT_TIMEOUT_MS,
  DEFAULT_COMMAND_TIMEOUT_MS,
  KEEPALIVE_INTERVAL_MS,
  KEEPALIVE_METHOD,
  KEEPALIVE_TIMEOUT_MS,
} from "./constants.js";

/** A protocol event: any inbound frame without an `id`. */
export type CdpEvent = {
  method: string;
  params: Record<string, unknown>;
  /**
   * Present when the event came from an attached target rather than the browser
   * itself. Carried through untouched — the network tap routes on this, so
   * dropping it would make every capture ambiguous once more than one session
   * exists.
   */
  sessionId?: string;
};

export type CdpEventListener = (event: CdpEvent) => void;

/** Removes the listener it was returned for. Idempotent. */
export type Unsubscribe = () => void;

export type CdpClientOptions = {
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  keepaliveIntervalMs?: number;
  keepaliveTimeoutMs?: number;
};

type Pending = {
  method: string;
  settle(err: CapabilityError | undefined, result?: unknown): void;
};

/**
 * Every transport failure is transient. The transport cannot tell a wedged tab
 * from a restarting browser from a command that will never work, so it reports
 * "not right now" and leaves the judgement to the caller — which is why the CDP
 * error code and message survive on `evidence` (see `protocolError`).
 */
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

function protocolError(method: string, err: unknown): CapabilityError {
  const e = err as { code?: unknown; message?: unknown; data?: unknown };
  const detail = typeof e?.message === "string" ? e.message : JSON.stringify(err);
  return transient(
    "CDP_PROTOCOL_ERROR",
    `${method} was rejected by Chrome: ${detail}`,
    JSON.stringify(err),
  );
}

/**
 * A CDP transport and nothing more: one WebSocket carrying request/response
 * pairs and protocol events. It knows nothing about targets, tabs, LinkedIn, or
 * capabilities, and it never enables a CDP domain on its own — what is enabled
 * is the caller's decision, which is what keeps D8's minimal attach surface
 * enforceable in one place instead of scattered through the capabilities.
 */
export class CdpClient {
  readonly url: string;

  readonly #ws: WebSocket;
  readonly #commandTimeoutMs: number;
  readonly #keepaliveIntervalMs: number;
  readonly #keepaliveTimeoutMs: number;

  #nextId = 0;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<CdpEventListener>();
  #listenerErrorHandler: ((error: unknown, event: CdpEvent) => void) | undefined;

  #deathCause: CapabilityError | undefined;
  #lastActivity = Date.now();
  #keepaliveTimer: NodeJS.Timeout | undefined;

  private constructor(ws: WebSocket, url: string, opts: CdpClientOptions) {
    this.#ws = ws;
    this.url = url;
    this.#commandTimeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.#keepaliveIntervalMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
    this.#keepaliveTimeoutMs = opts.keepaliveTimeoutMs ?? KEEPALIVE_TIMEOUT_MS;

    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", () =>
      this.#die(transient("CDP_CONNECTION_CLOSED", `CDP connection to ${url} closed`)),
    );
    this.#startKeepalive();
  }

  /**
   * Opens the socket, bounded by a connect timeout. Rejects — never resolves a
   * half-open client — if the endpoint is down or the handshake stalls.
   */
  static connect(url: string, opts: CdpClientOptions = {}): Promise<CdpClient> {
    const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;

    return new Promise<CdpClient>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (cause) {
        reject(transient("CDP_CONNECT_FAILED", `invalid CDP WebSocket URL ${url}: ${String(cause)}`));
        return;
      }

      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const abort = (err: CapabilityError) =>
        finish(() => {
          // Leave nothing half-open behind: a stalled handshake keeps a socket
          // and its timers alive for as long as the process runs.
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          reject(err);
        });

      const timer = setTimeout(
        () =>
          abort(
            transient("CDP_CONNECT_TIMEOUT", `CDP handshake to ${url} did not complete in ${timeoutMs}ms`),
          ),
        timeoutMs,
      );

      ws.addEventListener("open", () => finish(() => resolve(new CdpClient(ws, url, opts))));
      // Before `open`, both of these mean the endpoint is not there. After it,
      // the instance owns the socket and its own close handler takes over.
      ws.addEventListener("error", () =>
        abort(transient("CDP_CONNECT_FAILED", `cannot open a CDP connection to ${url}`)),
      );
      ws.addEventListener("close", () =>
        abort(transient("CDP_CONNECT_FAILED", `CDP connection to ${url} closed during handshake`)),
      );
    });
  }

  /** True once the connection is gone or `close()` has been called. */
  get dead(): boolean {
    return this.#deathCause !== undefined;
  }

  /**
   * Sends one command and resolves with its `result`. A protocol `error` reply
   * rejects; so does silence past `timeoutMs`, and so does the connection dying
   * underneath an in-flight command.
   */
  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs: number = this.#commandTimeoutMs,
  ): Promise<T> {
    // The original cause is what a caller needs: "the server dropped us" and
    // "we closed it ourselves" call for different handling upstream.
    if (this.#deathCause) return Promise.reject(this.#deathCause);

    const id = ++this.#nextId;
    const frame: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) frame["sessionId"] = sessionId;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Dropping the entry first is what makes a late reply harmless: the
        // dispatcher finds no pending id and discards the frame instead of
        // resolving a promise that has already rejected.
        this.#pending.delete(id);
        reject(transient("CDP_TIMEOUT", `${method} got no CDP reply within ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, {
        method,
        settle: (err, result) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(result as T);
        },
      });

      try {
        this.#ws.send(JSON.stringify(frame));
        this.#lastActivity = Date.now();
      } catch (cause) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(transient("CDP_SEND_FAILED", `writing ${method} to the CDP socket failed: ${String(cause)}`));
      }
    });
  }

  /** Subscribes to every protocol event. Returns its own unsubscribe. */
  on(listener: CdpEventListener): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  off(listener: CdpEventListener): void {
    this.#listeners.delete(listener);
  }

  /**
   * Where a listener's own exception goes. Without this the transport would
   * have to choose between swallowing it and letting one bad subscriber take
   * down the read loop for everybody else.
   */
  onListenerError(handler: (error: unknown, event: CdpEvent) => void): void {
    this.#listenerErrorHandler = handler;
  }

  /** Stops the timers, closes the socket, and fails anything still in flight. */
  close(): void {
    this.#die(transient("CDP_CONNECTION_CLOSED", `CDP connection to ${this.url} was closed locally`));
    try {
      this.#ws.close();
    } catch {
      /* already closed */
    }
  }

  #onMessage(ev: MessageEvent): void {
    this.#lastActivity = Date.now();

    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; error?: unknown; result?: unknown };
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data));
    } catch {
      return; // a frame we cannot parse is not worth killing the connection over
    }

    if (typeof msg.id === "number") {
      const pending = this.#pending.get(msg.id);
      if (!pending) return; // timed-out or unknown id: the reply is stale, drop it
      this.#pending.delete(msg.id);
      pending.settle(
        msg.error !== undefined ? protocolError(pending.method, msg.error) : undefined,
        msg.result,
      );
      return;
    }

    if (typeof msg.method !== "string") return;
    const event: CdpEvent = {
      method: msg.method,
      params: (msg.params as Record<string, unknown>) ?? {},
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    };

    // Iterating the live Set (not a snapshot) is deliberate: a listener that
    // unsubscribes another mid-dispatch must not still reach it. That is the
    // "no events after unsubscribe" guarantee the network tap relies on.
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#listenerErrorHandler?.(error, event);
      }
    }
  }

  #startKeepalive(): void {
    this.#keepaliveTimer = setInterval(() => void this.#keepalive(), this.#keepaliveIntervalMs);
    // The transport must never be the reason the process stays alive.
    this.#keepaliveTimer.unref?.();
  }

  async #keepalive(): Promise<void> {
    if (this.dead) return;
    // Traffic is its own proof of life; only true silence needs a probe.
    if (Date.now() - this.#lastActivity < this.#keepaliveIntervalMs) return;
    try {
      await this.send(KEEPALIVE_METHOD, {}, undefined, this.#keepaliveTimeoutMs);
    } catch {
      this.#die(
        transient("CDP_CONNECTION_DEAD", `CDP keepalive to ${this.url} went unanswered; connection is dead`),
      );
      try {
        this.#ws.close();
      } catch {
        /* already going */
      }
    }
  }

  /** Idempotent teardown: first cause wins, later ones are no-ops. */
  #die(cause: CapabilityError): void {
    if (this.#deathCause) return;
    this.#deathCause = cause;

    if (this.#keepaliveTimer) clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = undefined;

    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) p.settle(cause);
  }
}
