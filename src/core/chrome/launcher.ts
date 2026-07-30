import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { CapabilityError, EXIT } from "../run/receipt.js";
import {
  AUTOMATION_PORT,
  CHROME_PROFILE_DIR,
  DEFAULT_CHROME_BINARY,
  LAUNCH_POLL_INTERVAL_MS,
  LAUNCH_TIMEOUT_MS,
} from "./constants.js";
import { assertNotPersonalChrome, discoverBrowserWsUrl } from "./discovery.js";

export type ChromeEndpoint = {
  /** The debug port the endpoint was found on. */
  port: number;
  /** Browser-level CDP WebSocket URL, from `/json/version`. */
  wsUrl: string;
  /** True if this call spawned Chrome, false if an existing one was reused. */
  launched: boolean;
};

export type EnsureChromeOptions = {
  port?: number;
  profileDir?: string;
  binary?: string;
  launchTimeoutMs?: number;
};

function transient(code: string, message: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.TRANSIENT,
    action: "RETRY_BACKOFF",
    retryable: true,
    message,
  });
}

/**
 * Exactly the flag set D9 verified as dialog-free. Nothing else is added: every
 * extra flag is a fingerprint change on an account that cannot be burned, so new
 * flags are a design decision, not a convenience.
 */
export function chromeLaunchArgs(port: number, profileDir: string): string[] {
  return [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/**
 * Guarantees a CDP browser endpoint on the automation port: reuses a Chrome
 * already listening there, otherwise launches one on the dedicated profile and
 * waits, bounded, for `/json/version` to answer.
 *
 * The launched process is detached and unref'd — Chrome outlives the CLI run, so
 * the next capability reuses it instead of paying a cold start.
 */
export async function ensureChrome(opts: EnsureChromeOptions = {}): Promise<ChromeEndpoint> {
  const port = opts.port ?? AUTOMATION_PORT;
  const profileDir = opts.profileDir ?? CHROME_PROFILE_DIR;
  const binary = opts.binary ?? process.env["LINKEDIN_OS_CHROME_BINARY"] ?? DEFAULT_CHROME_BINARY;
  const launchTimeoutMs = opts.launchTimeoutMs ?? LAUNCH_TIMEOUT_MS;

  assertNotPersonalChrome(port);

  // Reuse path: an endpoint already answering is the whole answer.
  try {
    return { port, wsUrl: await discoverBrowserWsUrl(port), launched: false };
  } catch (e) {
    if (e instanceof CapabilityError && !e.retryable) throw e;
  }

  if (!existsSync(binary)) {
    throw transient(
      "CHROME_BINARY_MISSING",
      `Chrome not found at ${binary}; set LINKEDIN_OS_CHROME_BINARY to its real path`,
    );
  }
  mkdirSync(profileDir, { recursive: true });

  let child;
  try {
    child = spawn(binary, chromeLaunchArgs(port, profileDir), {
      detached: true,
      stdio: "ignore",
    });
  } catch (cause) {
    throw transient("CHROME_LAUNCH_FAILED", `spawning Chrome failed: ${String(cause)}`);
  }

  // A spawn error surfaces asynchronously; capture it so the wait loop can report
  // the real reason instead of a bare timeout.
  let spawnError: Error | undefined;
  child.on("error", (e) => {
    spawnError = e;
  });
  child.unref();

  const deadline = Date.now() + launchTimeoutMs;
  let last = "endpoint never answered";
  while (Date.now() < deadline) {
    if (spawnError) throw transient("CHROME_LAUNCH_FAILED", `spawning Chrome failed: ${spawnError.message}`);
    try {
      return { port, wsUrl: await discoverBrowserWsUrl(port), launched: true };
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await delay(LAUNCH_POLL_INTERVAL_MS);
  }

  throw transient(
    "CHROME_LAUNCH_TIMEOUT",
    `Chrome launched on port ${port} but no CDP endpoint within ${launchTimeoutMs}ms: ${last}`,
  );
}
