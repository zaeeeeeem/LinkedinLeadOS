import { CapabilityError, EXIT } from "../run/receipt.js";
import { PERSONAL_CHROME_PORT, PROBE_TIMEOUT_MS } from "./constants.js";

/** Chrome is not answering yet — always worth another attempt after a back-off. */
function unreachable(port: number, cause: unknown): CapabilityError {
  return new CapabilityError({
    code: "CHROME_UNREACHABLE",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: `no CDP endpoint on 127.0.0.1:${port} (${String(cause)})`,
  });
}

/**
 * Chrome answered but not with a usable browser endpoint. Still transient: a
 * Chrome mid-startup, or one opted in via `chrome://inspect` (whose discovery
 * endpoints 404), both land here and both are fixed by launching our own.
 */
function malformed(port: number, detail: string): CapabilityError {
  return new CapabilityError({
    code: "CHROME_DISCOVERY_MALFORMED",
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message: `/json/version on 127.0.0.1:${port} did not yield a browser WebSocket URL: ${detail}`,
  });
}

/**
 * Targeting the operator's personal Chrome is a configuration bug, not a blip.
 * Retrying cannot fix it and succeeding would be worse than failing, so this is
 * the one failure here that halts instead of backing off.
 */
function forbiddenPort(port: number): CapabilityError {
  return new CapabilityError({
    code: "CHROME_FORBIDDEN_PORT",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `refusing to use port ${port}: that is the operator's personal Chrome. ` +
      `The automation profile is the only Chrome this toolkit may drive.`,
  });
}

export function assertNotPersonalChrome(port: number): void {
  if (port === PERSONAL_CHROME_PORT) throw forbiddenPort(port);
}

/**
 * The only supported discovery path (D9): `GET /json/version` → `webSocketDebuggerUrl`.
 * The bare `ws://host:port/devtools/browser` path is rejected by Chrome 151 and the
 * `DevToolsActivePort` file is not reliably written, so neither is used here.
 */
export async function discoverBrowserWsUrl(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<string> {
  assertNotPersonalChrome(port);

  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw unreachable(port, cause instanceof Error ? cause.message : cause);
  }

  if (!res.ok) throw malformed(port, `HTTP ${res.status}`);

  const body = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw malformed(port, "response body is not JSON");
  }

  const wsUrl = (parsed as { webSocketDebuggerUrl?: unknown })?.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string" || !wsUrl.startsWith("ws://")) {
    throw malformed(port, "missing or non-ws webSocketDebuggerUrl");
  }
  return wsUrl;
}

/**
 * Does this Chrome still have at least one target (B5)? A running automation
 * Chrome whose windows have all been closed answers `/json/version` normally
 * and returns an empty `/json/list`; on that process every browser-level
 * command fails ("Browser context management is not supported"), so preflight
 * dies at `Storage.getCookies` with a retryable `CDP_PROTOCOL_ERROR` that no
 * retry can ever fix — the condition holds until someone restarts Chrome.
 *
 * Never throws: anything short of a parsed, non-empty array is `false`. An
 * unreachable or malformed `/json/list` did not answer "at least one target",
 * and treating "cannot tell" as healthy is what produced B5's misleading
 * receipt in the first place. `false` costs at most a launch attempt, which
 * already reports the real environment problem; `true` costs an attach to a
 * browser that cannot serve a single command.
 */
export async function hasLiveTarget(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  assertNotPersonalChrome(port);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const parsed: unknown = JSON.parse(await res.text());
    return Array.isArray(parsed) && parsed.length > 0;
  } catch {
    return false;
  }
}

/** Cheap "is our Chrome serving CDP here" probe. Never throws for a down endpoint. */
export async function isChromeUp(
  port: number,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  assertNotPersonalChrome(port);
  try {
    await discoverBrowserWsUrl(port, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
