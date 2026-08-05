import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { CapabilityError, EXIT } from "../run/receipt.js";
import { ENV } from "./constants.js";

export type StoreConfig = {
  url: string;
  serviceRoleKey: string;
};

export type EnvLike = Record<string, string | undefined>;

let envFileLoaded = false;

/**
 * Loads `.env` from the working directory once per process, and only when the
 * caller is asking about the real environment. Node reads it natively, so this
 * costs no dependency.
 *
 * Existing `process.env` values win: `loadEnvFile` does not overwrite them, so an
 * explicitly exported variable always beats the file.
 */
function loadEnvFileOnce(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // A malformed or unreadable .env is not fatal here: the variables may be set
    // some other way, and if they are not, the caller gets STORE_NOT_CONFIGURED
    // naming exactly what is missing.
  }
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * The store's configuration, or `null` when it is not configured.
 *
 * Returning null rather than throwing is the point: a capability run with
 * `--skip-store` must be able to ask whether the store exists without a missing
 * `.env` ending the run.
 *
 * Passing an explicit `env` skips the `.env` file entirely — tests get exactly the
 * environment they hand in.
 */
export function readStoreConfig(env?: EnvLike): StoreConfig | null {
  if (env === undefined) {
    loadEnvFileOnce();
    env = process.env;
  }
  const url = clean(env[ENV.url]);
  const serviceRoleKey = clean(env[ENV.serviceRoleKey]);
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

export function isStoreConfigured(env?: EnvLike): boolean {
  return readStoreConfig(env) !== null;
}

/** The same read, for callers that cannot proceed without a store. */
export function requireStoreConfig(env?: EnvLike): StoreConfig {
  const config = readStoreConfig(env);
  if (config) return config;
  throw new CapabilityError({
    code: "STORE_NOT_CONFIGURED",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message:
      `the store is not configured: set ${ENV.url} and ${ENV.serviceRoleKey} in .env ` +
      `(see .env.example), or run the capability with --skip-store`,
  });
}
