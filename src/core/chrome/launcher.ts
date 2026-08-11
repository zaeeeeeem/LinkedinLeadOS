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
import { assertNotPersonalChrome, discoverBrowserWsUrl, hasLiveTarget } from "./discovery.js";

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

/** The endpoint is not answering *yet* — genuinely worth another attempt. */
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
 * The environment is wrong and only a human can fix it — a missing binary, a
 * profile another Chrome already holds. Same class as pointing at port 9222:
 * backing off just retries forever against a condition that will not change (D13).
 */
function fatal(code: string, message: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
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
  //
  // Note the limit of this: we attach to whatever serves CDP on this port without
  // confirming it runs *our* profile — /json/version exposes the browser version,
  // not the user-data-dir, so there is no cheap proof. Port 9223 being ours is a
  // convention this module enforces at launch, not something it can verify on
  // reuse. Accepted knowingly; the 9222 guard is what keeps the dangerous
  // mistake — the operator's personal Chrome — out of reach.
  //
  // `/json/version` answering is necessary but not sufficient (B5/D122): a
  // Chrome whose windows have all been closed still answers it while every
  // browser-level command on it fails. One extra loopback GET on the reuse
  // path settles that; an empty target list falls through to the launch path
  // below, which already reports a profile held by another process properly.
  // The launch path applies the same test — see the wait loop (D410).
  try {
    const wsUrl = await discoverBrowserWsUrl(port);
    if (await hasLiveTarget(port)) return { port, wsUrl, launched: false };
  } catch (e) {
    if (e instanceof CapabilityError && !e.retryable) throw e;
  }

  if (!existsSync(binary)) {
    throw fatal(
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
    throw fatal("CHROME_LAUNCH_FAILED", `spawning Chrome failed: ${String(cause)}`);
  }

  // Both ways a launch can fail surface asynchronously, so capture each and let
  // the wait loop report the real reason instead of a bare 30s timeout.
  //   `error` — the spawn itself failed (ENOENT, EACCES).
  //   `exit`  — Chrome started and died. The usual cause is another Chrome already
  //             holding this user-data-dir: the new process hands the request to
  //             the running instance and exits 0, so the debug port never opens.
  //             Nothing about that improves on a retry.
  let spawnError: Error | undefined;
  let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.on("error", (e) => {
    spawnError = e;
  });
  child.on("exit", (code, signal) => {
    exited = { code, signal };
  });
  child.unref();

  const deadline = Date.now() + launchTimeoutMs;
  let last = "endpoint never answered";
  while (Date.now() < deadline) {
    if (spawnError) {
      throw fatal("CHROME_LAUNCH_FAILED", `spawning Chrome failed: ${spawnError.message}`);
    }
    // Discovery wins over the exit flag: if the endpoint answers, the launch
    // worked, whatever the process table says.
    //
    // But answering is not being ready (D410). A freshly spawned Chrome serves
    // `/json/version` a few hundred ms before its first target exists, and in
    // that window every browser-level command fails the B5 way — which is how
    // preflight died at `Storage.getCookies` with a `CDP_PROTOCOL_ERROR` that
    // looked transient and was not. The reuse path above already applies this
    // test; the launch path needs it more, because it is the only path that can
    // observe a Chrome mid-start. Same deadline, same failure reporting.
    try {
      const wsUrl = await discoverBrowserWsUrl(port);
      if (await hasLiveTarget(port)) return { port, wsUrl, launched: true };
      last = `port ${port} answered before Chrome had a single target`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (exited) {
      throw fatal(
        "CHROME_LAUNCH_FAILED",
        `Chrome exited immediately (code=${exited.code} signal=${exited.signal}) without ` +
          `opening port ${port}. Most likely another Chrome instance already holds ` +
          `${profileDir} — quit it and retry.`,
      );
    }
    await delay(LAUNCH_POLL_INTERVAL_MS);
  }

  throw transient(
    "CHROME_LAUNCH_TIMEOUT",
    `Chrome launched on port ${port} but no CDP endpoint within ${launchTimeoutMs}ms: ${last}`,
  );
}
