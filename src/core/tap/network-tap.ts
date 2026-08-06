import type { CdpEvent, Unsubscribe } from "../cdp/client.js";
import type { ArchivedCapture, CaptureInput } from "../archive/raw.js";
import type { EventFields, EventName } from "../run/events.js";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { BODY_FETCH_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS, SEEN_REQUEST_CAP } from "./constants.js";

/**
 * The slice of `CdpClient` the tap needs. Structural, like `CdpTransport` in
 * session/tab.ts and for the same reason: the whole point of this module is
 * the ordering of protocol events, and a structural type is what lets those
 * orderings be staged offline instead of hoped for against a live page.
 */
export type TapTransport = {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs?: number,
  ): Promise<T>;
  on(listener: (event: CdpEvent) => void): Unsubscribe;
};

/** The archive the tap writes through. `RawArchive` satisfies it (D2). */
export type ArchiveSink = { archive(input: CaptureInput): Promise<ArchivedCapture> };

/** The run's event log. `RunContext` and `EventLogger` both satisfy it. */
export type EventSink = { log(event: EventName, fields?: EventFields): unknown };

/**
 * A URL pattern the tap watches for. `name` is a stable label: it lands on the
 * capture, on the archive sidecar, and on every `capture.hit` / `capture.miss`
 * event, so `log:why` can answer "what did we watch for, and what showed up".
 */
export type WatchPattern = {
  name: string;
  match: string | RegExp | ((url: string) => boolean);
};

/** One archived response body. `body` is the utf-8 view; the archive holds the
 *  exact bytes, which is the copy that matters for a binary response. */
export type Capture = {
  /** Tap-local index, and the value `waitFor`'s `since` is expressed in. */
  seq: number;
  /** The first registered pattern that matched — the one on the archive record. */
  pattern: string;
  /** Every pattern that matched, in registration order. */
  patterns: string[];
  requestId: string;
  url: string;
  status: number;
  method?: string;
  contentType?: string;
  body: string;
  bytes: number;
  archived: ArchivedCapture;
  capturedAt: string;
  /**
   * The body reached us through a lossy UTF-8 decode: it is not byte-exact
   * (D310). Set when a text body came back holding U+FFFD, which Chrome and the
   * transport substitute for bytes that are not valid UTF-8. Conservative on
   * purpose — a body that genuinely contains U+FFFD is flagged too, because the
   * two are indistinguishable by the time we hold a string, and a false "maybe
   * lossy" is cheap while a missed one turns a lost byte into a parser mystery.
   */
  lossyUtf8?: true;
};

export type MissReason =
  /** Chrome never finished the request: aborted, blocked, or the tab navigated away. */
  | "loading-failed"
  /** The request finished but the body was gone — an evicted buffer, most often. */
  | "body-unavailable"
  /** The body arrived but could not be written to the archive; nothing may use it (D2). */
  | "archive-failed"
  /** The tap gave up tracking it: `SEEN_REQUEST_CAP` matched responses were
   *  outstanding at once, so the oldest was dropped. Recorded rather than
   *  silently forgotten — an untracked response is indistinguishable from one
   *  that never arrived, which is the report that sends an operator to the
   *  browser over a bug in here. */
  | "abandoned";

/** A watched response the tap saw and could not deliver. Never a throw: a lost
 *  body is a fact about one response, not a reason to end a run. */
export type CaptureMiss = {
  pattern: string;
  patterns: string[];
  requestId: string;
  url: string;
  status?: number;
  reason: MissReason;
  error?: string;
  at: string;
};

export type NetworkTapOptions = {
  cdp: TapTransport;
  /** The worker tab's session. Events from any other target are ignored. */
  sessionId: string;
  archive: ArchiveSink;
  events?: EventSink;
  bodyTimeoutMs?: number;
  defaultWaitMs?: number;
};

export type WaitOptions = {
  timeoutMs?: number;
  /**
   * Look back to this `cursor` value instead of only waiting for what comes
   * next. Snapshot `tap.cursor` *before* the click that causes the fetch and
   * pass it here — otherwise a response that lands before the caller gets
   * around to awaiting is invisible, and the wait burns its whole timeout on a
   * capture that already happened.
   */
  since?: number;
};

type Compiled = { name: string; test(url: string): boolean };

type Inflight = {
  requestId: string;
  url: string;
  status: number;
  method?: string;
  contentType?: string;
  patterns: string[];
  /** Set the moment the body fetch starts, so a duplicate finish event cannot
   *  ask Chrome for the same body twice. */
  claimed: boolean;
};

type Waiter = {
  name: string;
  since: number;
  resolve(capture: Capture): void;
  reject(err: CapabilityError): void;
};

function transient(code: string, message: string, evidence?: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.TRANSIENT, action: "RETRY_BACKOFF", retryable: true, message, evidence,
  });
}

function fatal(code: string, message: string): CapabilityError {
  return new CapabilityError({
    code, exit: EXIT.GENERIC, action: "HALT_AND_NOTIFY", retryable: false, message,
  });
}

function compile(pattern: WatchPattern): Compiled {
  const { match } = pattern;
  if (typeof match === "function") return { name: pattern.name, test: match };
  if (typeof match === "string") return { name: pattern.name, test: (url) => url.includes(match) };
  // `g`/`y` carry `lastIndex` between calls, so the same regex would match a URL
  // and then miss the identical one that follows. Strip them rather than trust
  // every caller to know that.
  const re = new RegExp(match.source, match.flags.replace(/[gy]/g, ""));
  return { name: pattern.name, test: (url) => re.test(url) };
}

/** Insertion-ordered, capped: remembering request ids for a run that lasts hours
 *  is a leak unless something drops the oldest. `onEvict` is how a map whose
 *  entries mean something to a caller reports what it dropped. */
function remember<V>(map: Map<string, V>, key: string, value: V, onEvict?: (evicted: V) => void): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > SEEN_REQUEST_CAP) {
    const oldest = map.entries().next();
    if (oldest.done) break;
    map.delete(oldest.value[0]);
    onEvict?.(oldest.value[1]);
  }
}

/**
 * The passive capture layer (D1). It watches the worker tab's own network
 * traffic for URL patterns and, when a watched response has *finished loading*,
 * reads its body out of Chrome and archives it raw (D2) before anyone else sees
 * it. It never issues a request, and it never enables a CDP domain — `Network`
 * is already on from `WorkerTab.attach`, which is the one place the attach
 * surface is decided (D8).
 *
 * The sequencing is the whole design. `Network.getResponseBody` before
 * `Network.loadingFinished` returns a partial body or an error, so a response is
 * only fetched once both its `responseReceived` (which carries the URL, and
 * therefore whether we care) and its `loadingFinished` have been seen — in
 * either order, because CDP orders events within a type and not across them.
 *
 * Nothing here throws at the caller from an event handler. A response that
 * cannot be delivered is a recorded miss; only `waitFor` fails, and it fails as
 * a bounded transient wait rather than hanging.
 */
export class NetworkTap {
  readonly #cdp: TapTransport;
  readonly #sessionId: string;
  readonly #archive: ArchiveSink;
  readonly #events: EventSink | undefined;
  readonly #bodyTimeoutMs: number;
  readonly #defaultWaitMs: number;

  readonly #watches = new Map<string, Compiled>();
  readonly #captures: Capture[] = [];
  readonly #misses: CaptureMiss[] = [];
  readonly #waiters = new Set<Waiter>();

  /** Watched responses seen, awaiting their loading outcome. */
  readonly #inflight = new Map<string, Inflight>();
  /** Loading outcomes seen before their response — the out-of-order case. */
  readonly #earlyFinish = new Map<string, { failed: boolean; errorText?: string }>();
  /** Request method by id, kept only for URLs a pattern already matched. */
  readonly #methods = new Map<string, string>();
  /** In-flight body fetch + archive work, so `drain()` can be deterministic. */
  readonly #pending = new Set<Promise<void>>();

  #unsubscribe: Unsubscribe | undefined;

  constructor(o: NetworkTapOptions) {
    this.#cdp = o.cdp;
    this.#sessionId = o.sessionId;
    this.#archive = o.archive;
    this.#events = o.events;
    this.#bodyTimeoutMs = o.bodyTimeoutMs ?? BODY_FETCH_TIMEOUT_MS;
    this.#defaultWaitMs = o.defaultWaitMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  }

  /** Registers a pattern. Returns its own `unwatch`. */
  watch(pattern: WatchPattern): Unsubscribe {
    if (this.#watches.has(pattern.name)) {
      // Replacing silently would redefine what an already-waiting `waitFor` is
      // waiting for, from somewhere else in the code.
      throw fatal("TAP_DUPLICATE_PATTERN", `a watch named "${pattern.name}" is already registered`);
    }
    this.#watches.set(pattern.name, compile(pattern));
    return () => this.unwatch(pattern.name);
  }

  unwatch(name: string): void {
    this.#watches.delete(name);
  }

  get watching(): string[] {
    return [...this.#watches.keys()];
  }

  /** Subscribes to the transport's events. Idempotent. */
  start(): void {
    if (this.#unsubscribe) return;
    this.#unsubscribe = this.#cdp.on((event) => this.#onEvent(event));
  }

  /**
   * Unsubscribes and fails anything still waiting. Captures and misses already
   * recorded stay readable — the receipt is built after the tap stops.
   */
  stop(): void {
    if (!this.#unsubscribe) return;
    this.#unsubscribe();
    this.#unsubscribe = undefined;

    // Anything still waiting for a loading outcome is a watched response this
    // tap saw and never delivered. Recording them here is what makes the
    // `#methods` gate above safe: the case it drops — an early finish for a
    // request with no `requestWillBeSent` of its own — parks in `#inflight`,
    // and without this it would only surface if 500 newer matched responses
    // happened to push it out. A capability's receipt now accounts for every
    // matched response either way.
    for (const entry of [...this.#inflight.values()]) {
      this.#recordMiss(entry, "abandoned", "the tap was stopped before this response finished loading");
    }
    this.#inflight.clear();
    this.#earlyFinish.clear();
    this.#methods.clear();

    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const w of waiters) {
      // Fatal rather than transient, for the reason CDP_CLIENT_CLOSED and
      // TAB_CLOSED are: we stopped it ourselves, so no back-off can change the
      // outcome and `retryable` is what callers branch on.
      w.reject(fatal("TAP_STOPPED", `the network tap was stopped while waiting for "${w.name}"`));
    }
  }

  get running(): boolean {
    return this.#unsubscribe !== undefined;
  }

  /** How many captures have landed. Snapshot it before an action, pass it as
   *  `waitFor`'s `since`. */
  get cursor(): number {
    return this.#captures.length;
  }

  captures(pattern?: string): Capture[] {
    if (pattern === undefined) return [...this.#captures];
    return this.#captures.filter((c) => c.patterns.includes(pattern));
  }

  misses(pattern?: string): CaptureMiss[] {
    if (pattern === undefined) return [...this.#misses];
    return this.#misses.filter((m) => m.patterns.includes(pattern));
  }

  /** Diagnostics for a receipt or a hung run: what is the tap still holding? */
  stats(): { inflight: number; pendingFinish: number; pendingBodies: number; waiters: number; captures: number; misses: number } {
    return {
      inflight: this.#inflight.size,
      pendingFinish: this.#earlyFinish.size,
      pendingBodies: this.#pending.size,
      waiters: this.#waiters.size,
      captures: this.#captures.length,
      misses: this.#misses.length,
    };
  }

  /** Settles once every body fetch and archive write started so far has
   *  finished. Lets a capability stop cleanly, and lets tests be deterministic
   *  without sleeping. */
  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
  }

  /**
   * Waits for the next capture matching `pattern` — a registered name, or an
   * inline pattern registered for the duration of this wait.
   *
   * A miss on the same pattern does *not* fail the wait: a lost body says
   * nothing about whether the next matching response will arrive, and failing
   * early would turn a page that retries its own fetch into a failed run. The
   * misses seen are named in the timeout message instead, so a timeout that was
   * really an eviction is diagnosable without reading the event log.
   */
  waitFor(pattern: string | WatchPattern, opts: WaitOptions = {}): Promise<Capture> {
    const inline = typeof pattern === "string" ? undefined : pattern;
    const name = typeof pattern === "string" ? pattern : pattern.name;
    const timeoutMs = opts.timeoutMs ?? this.#defaultWaitMs;
    const since = opts.since ?? this.#captures.length;

    if (inline) {
      try {
        this.watch(inline);
      } catch (err) {
        return Promise.reject(err as CapabilityError);
      }
    } else if (!this.#watches.has(name)) {
      // A typo'd name would otherwise present as a timeout, which reads as
      // "LinkedIn did not respond" and sends the operator hunting the browser.
      return Promise.reject(
        fatal("TAP_UNKNOWN_PATTERN", `no watch named "${name}" is registered; watching: ${this.watching.join(", ") || "nothing"}`),
      );
    }

    const cleanup = () => {
      if (inline) this.unwatch(name);
    };

    if (!this.running) {
      cleanup();
      return Promise.reject(fatal("TAP_STOPPED", `the network tap is not running; cannot wait for "${name}"`));
    }

    // Matched by URL, not by the names recorded on the capture: a pattern
    // registered after a capture landed (every inline pattern, and any watch
    // added mid-run) is absent from that capture's `patterns`, so a name-based
    // lookback would silently never match and `since` would quietly degrade
    // into "wait for the next one".
    const matcher = this.#watches.get(name);
    const already = this.#captures.slice(since).find((c) => matcher?.test(c.url) ?? false);
    if (already) {
      cleanup();
      return Promise.resolve(already);
    }

    return new Promise<Capture>((resolve, reject) => {
      const waiter: Waiter = {
        name,
        since,
        resolve: (capture) => settle(() => resolve(capture)),
        reject: (err) => settle(() => reject(err)),
      };
      const settle = (finish: () => void) => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        cleanup();
        finish();
      };
      const timer = setTimeout(() => {
        const missed = this.misses(name).length;
        waiter.reject(
          transient(
            "CAPTURE_TIMEOUT",
            `no response matching "${name}" was captured within ${timeoutMs}ms` +
              (missed ? ` (${missed} miss${missed === 1 ? "" : "es"} recorded for it — see capture.miss events)` : ""),
            `pattern=${name} timeout_ms=${timeoutMs} misses=${missed}`,
          ),
        );
      }, timeoutMs);
      this.#waiters.add(waiter);
    });
  }

  #onEvent(event: CdpEvent): void {
    // Session scoping is a correctness property, not tidiness: the browser-level
    // connection carries traffic from every target, and a body fetched against
    // the wrong session is either a wrong answer or an error.
    if (event.sessionId !== this.#sessionId) return;

    switch (event.method) {
      case "Network.requestWillBeSent":
        return this.#onRequest(event.params);
      case "Network.responseReceived":
        return this.#onResponse(event.params);
      case "Network.loadingFinished":
        return this.#onLoadingOutcome(String(readPath(event.params, ["requestId"]) ?? ""), false);
      case "Network.loadingFailed":
        return this.#onLoadingOutcome(
          String(readPath(event.params, ["requestId"]) ?? ""),
          true,
          asString(readPath(event.params, ["errorText"])),
        );
      default:
        return;
    }
  }

  /** Only remembered for URLs a pattern already matches — a page issues
   *  thousands of requests and almost none of them are ours. */
  #onRequest(params: Record<string, unknown>): void {
    const requestId = asString(params["requestId"]);
    const url = asString(readPath(params, ["request", "url"]));
    const method = asString(readPath(params, ["request", "method"]));
    if (!requestId || !url || !method) return;
    if (!this.#matches(url).length) return;
    remember(this.#methods, requestId, method);
  }

  #onResponse(params: Record<string, unknown>): void {
    const requestId = asString(params["requestId"]);
    const url = asString(readPath(params, ["response", "url"]));
    if (!requestId || !url) return;

    const patterns = this.#matches(url);
    if (!patterns.length) return;

    const entry: Inflight = {
      requestId,
      url,
      status: Number(readPath(params, ["response", "status"]) ?? 0),
      method: this.#methods.get(requestId),
      contentType: asString(readPath(params, ["response", "mimeType"])),
      patterns,
      claimed: false,
    };
    // Capped like everything else here, and loudly: a matched response that
    // never gets a loading outcome (the tab navigated away mid-flight, a
    // service worker answered it) would otherwise sit in this map for the life
    // of the process.
    remember(this.#inflight, requestId, entry, (evicted) => {
      this.#recordMiss(
        evicted,
        "abandoned",
        `no loading outcome arrived before ${SEEN_REQUEST_CAP} newer matched responses did`,
      );
    });

    // The out-of-order case: the request already finished (or failed) before we
    // learned what its URL was, so the outcome is waiting for us rather than
    // the other way round.
    const early = this.#earlyFinish.get(requestId);
    if (early) {
      this.#earlyFinish.delete(requestId);
      this.#settleInflight(entry, early.failed, early.errorText);
    }
  }

  #onLoadingOutcome(requestId: string, failed: boolean, errorText?: string): void {
    if (!requestId) return;
    const entry = this.#inflight.get(requestId);
    if (!entry) {
      // Ours, arriving before its `responseReceived` — or not ours at all. The
      // `#methods` set answers that: it is populated at `requestWillBeSent`,
      // for matching URLs only, and `requestWillBeSent` always precedes
      // `loadingFinished` for the same request.
      //
      // Remembering every finish instead is what the first version did, and it
      // was a silent data-loss bug: a feed issues thousands of requests, so the
      // cap churned constantly, and one of *our* early finishes could be
      // evicted before its response arrived. The response then parked in
      // `#inflight` waiting for a finish that had already happened and been
      // thrown away — no capture, no miss, and a `waitFor` timing out with zero
      // misses to explain it.
      //
      // Residual, and now visible rather than silent: a request with no
      // `requestWillBeSent` of its own (served by a service worker, say) whose
      // finish beats its response is dropped here, and its `#inflight` entry
      // ages out as an `abandoned` miss.
      if (this.#methods.has(requestId)) {
        remember(this.#earlyFinish, requestId, { failed, ...(errorText !== undefined ? { errorText } : {}) });
      }
      return;
    }
    this.#settleInflight(entry, failed, errorText);
  }

  #settleInflight(entry: Inflight, failed: boolean, errorText?: string): void {
    if (entry.claimed) return; // a duplicate finish must not re-fetch the body
    entry.claimed = true;
    this.#inflight.delete(entry.requestId);
    this.#methods.delete(entry.requestId);

    if (failed) {
      this.#recordMiss(entry, "loading-failed", errorText ?? "the request did not finish loading");
      return;
    }
    this.#track(this.#fetchAndArchive(entry));
  }

  /** Fetch the body, archive it, then deliver. Every failure inside is a miss;
   *  nothing here may throw, because there is no caller to throw to. */
  async #fetchAndArchive(entry: Inflight): Promise<void> {
    let bytes: Buffer;
    let lossyUtf8 = false;
    try {
      const r = await this.#cdp.send<{ body: string; base64Encoded?: boolean }>(
        "Network.getResponseBody",
        { requestId: entry.requestId },
        this.#sessionId,
        this.#bodyTimeoutMs,
      );
      bytes = r.base64Encoded ? Buffer.from(r.body, "base64") : Buffer.from(r.body, "utf8");
      // A base64 body is exact by construction; only a text body can have lost
      // bytes on the way here (D310).
      lossyUtf8 = !r.base64Encoded && r.body.includes("�");
    } catch (cause) {
      this.#recordMiss(entry, "body-unavailable", messageOf(cause));
      return;
    }

    // A stop that landed while the body was on the wire: the capability has
    // moved on, and delivering now would append to a result set nobody is
    // reading. The body stays unarchived on purpose — it belongs to a phase
    // that is over.
    if (!this.running) return;

    let archived: ArchivedCapture;
    try {
      archived = await this.#archive.archive({
        body: bytes,
        url: entry.url,
        status: entry.status,
        requestId: entry.requestId,
        pattern: entry.patterns[0]!,
        ...(entry.method !== undefined ? { method: entry.method } : {}),
        ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
        ...(lossyUtf8 ? { lossyUtf8: true as const } : {}),
      });
    } catch (cause) {
      // Raw-first (D2) is not advisory: a body no one archived is a body no one
      // may parse, because there would be no copy to re-parse when the parser
      // turns out to be wrong.
      this.#recordMiss(entry, "archive-failed", messageOf(cause));
      return;
    }

    const capture: Capture = {
      seq: this.#captures.length,
      pattern: entry.patterns[0]!,
      patterns: entry.patterns,
      requestId: entry.requestId,
      url: entry.url,
      status: entry.status,
      ...(entry.method !== undefined ? { method: entry.method } : {}),
      ...(entry.contentType !== undefined ? { contentType: entry.contentType } : {}),
      body: bytes.toString("utf8"),
      bytes: bytes.length,
      archived,
      capturedAt: archived.capturedAt,
      ...(lossyUtf8 ? { lossyUtf8: true as const } : {}),
    };
    this.#captures.push(capture);

    this.#events?.log("capture.hit", {
      item_ref: capture.requestId,
      detail: {
        pattern: capture.pattern,
        patterns: capture.patterns,
        url: capture.url,
        status: capture.status,
        bytes: capture.bytes,
        shape_hash: archived.shapeHash,
        file: archived.file,
        request_id: capture.requestId,
        ...(archived.warning ? { archive_warning: archived.warning.code } : {}),
        // D310: visible in `log:why`, so a body that lost bytes on the way in is
        // findable later without re-reading every sidecar.
        ...(capture.lossyUtf8 ? { lossy_utf8: true } : {}),
      },
    });

    this.#wake(capture);
  }

  #recordMiss(entry: Inflight, reason: MissReason, error: string): void {
    const miss: CaptureMiss = {
      pattern: entry.patterns[0]!,
      patterns: entry.patterns,
      requestId: entry.requestId,
      url: entry.url,
      status: entry.status,
      reason,
      error,
      at: new Date().toISOString(),
    };
    this.#misses.push(miss);
    this.#events?.log("capture.miss", {
      level: "warn",
      item_ref: miss.requestId,
      detail: {
        pattern: miss.pattern,
        patterns: miss.patterns,
        url: miss.url,
        status: miss.status,
        reason: miss.reason,
        error: miss.error,
        request_id: miss.requestId,
      },
    });
  }

  #wake(capture: Capture): void {
    for (const waiter of [...this.#waiters]) {
      if (capture.seq >= waiter.since && capture.patterns.includes(waiter.name)) {
        waiter.resolve(capture);
      }
    }
  }

  #matches(url: string): string[] {
    const hits: string[] = [];
    for (const w of this.#watches.values()) {
      let matched = false;
      try {
        matched = w.test(url);
      } catch {
        matched = false; // a caller's predicate that throws is a non-match, not a crash
      }
      if (matched) hits.push(w.name);
    }
    return hits;
  }

  #track(work: Promise<void>): void {
    const tracked = work.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function readPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
