import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The automation Chrome's debug port. Deliberately not 9222 (D9): the operator's
 * daily-driver Chrome holds 9222 via the `chrome://inspect` toggle, and attaching
 * to it would drive their real logged-in session. Port separation is what makes
 * that impossible, so this number is a constant of the module, never a default a
 * caller can drift away from.
 */
export const AUTOMATION_PORT = 9223;

/** The operator's personal Chrome. Never connected to, guarded against explicitly. */
export const PERSONAL_CHROME_PORT = 9222;

/** The dedicated automation profile — logged into LinkedIn by hand, once (D9). */
export const CHROME_PROFILE_DIR = join(homedir(), ".linkedin-os", "chrome-profile");

/** Overridable for a non-standard install; the default is the macOS location. */
export const DEFAULT_CHROME_BINARY =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Discovery is a loopback GET; anything slower than this means Chrome is not serving. */
export const PROBE_TIMEOUT_MS = 2_000;

/** How long to wait for a freshly spawned Chrome to start answering /json/version. */
export const LAUNCH_TIMEOUT_MS = 30_000;

/** Gap between endpoint polls while waiting for a launch. */
export const LAUNCH_POLL_INTERVAL_MS = 250;
