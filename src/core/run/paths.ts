import { resolve } from "node:path";

/**
 * Root of the run archive. Every run directory, and the budget ledger (D11), live
 * under here. Overridable by env so tests — and only tests — can point the whole
 * archive at a temp directory without threading a parameter through every caller.
 */
export function defaultRunsDir(): string {
  const override = process.env.LINKEDIN_OS_RUNS_DIR;
  return override ? resolve(override) : resolve(process.cwd(), "runs");
}

/**
 * Receipt artifact paths are repo-relative in the spec (`runs/<id>/events.ndjson`).
 * Relative while the path is inside the cwd, absolute once it escapes it — an agent
 * reading the receipt must never be handed a path it cannot resolve.
 */
export function receiptPath(abs: string): string {
  const rel = resolve(abs).startsWith(resolve(process.cwd()) + "/")
    ? resolve(abs).slice(resolve(process.cwd()).length + 1)
    : null;
  return rel ?? resolve(abs);
}
