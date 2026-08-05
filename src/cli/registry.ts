import { readdir } from "node:fs/promises";
import { z } from "zod";
import { CapabilityError, EXIT } from "../core/run/receipt.js";
import type { AnyCapability, CostEstimate, RiskClass } from "./types.js";

/**
 * Where capability directories live (spec §10). Resolved from this module rather
 * than from `process.cwd()`, so the CLI finds its capabilities no matter which
 * directory it is invoked from.
 */
export const CAPABILITIES_DIR = new URL("../capabilities/", import.meta.url);

/** One row of `cap list`. Everything here is JSON — this is the whole contract a
 *  context-less agent rediscovers the toolkit from (§4.5). */
export type ManifestEntry = {
  name: string;
  risk: RiskClass;
  summary: string;
  needs_browser: boolean;
  needs_auth: boolean;
  /** JSON Schema for the capability's arguments. */
  args_schema: unknown;
  /**
   * The estimate for an invocation with no arguments, or `null` when the
   * capability cannot be costed without them. A cost *function* cannot be
   * serialized, and a number that pretended to cover every argument set would be
   * a worse answer than an explicit null next to the schema that explains it.
   */
  cost: CostEstimate | null;
};

function usage(code: string, message: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
  });
}

/** The runtime shape check `loadCapabilities` applies to whatever a capability
 *  directory exports. A capability that is malformed must fail at load, not
 *  halfway through a run against the real account. */
function assertWellFormed(value: unknown, where: string): asserts value is AnyCapability {
  const d = value as Partial<AnyCapability> | null;
  const bad = (why: string) => usage("CAPABILITY_MALFORMED", `${where}: ${why}`);
  if (typeof d !== "object" || d === null) throw bad("does not export a capability object");
  if (typeof d.name !== "string" || d.name === "") throw bad("has no name");
  if (d.risk !== "local" && d.risk !== "read-cheap" && d.risk !== "read-metered") {
    throw bad(`has an unknown risk class ${String(d.risk)}`);
  }
  if (typeof d.summary !== "string" || d.summary === "") throw bad("has no summary");
  if (typeof d.needsBrowser !== "boolean") throw bad("does not declare needsBrowser");
  if (typeof d.cost !== "function") throw bad("has no cost function");
  if (typeof d.run !== "function") throw bad("has no run function");
  if (!(d.args instanceof z.ZodType)) throw bad("has no zod args schema");
}

/** A capability's auth requirement defaults to whether it drives the browser. */
export function needsAuth(def: AnyCapability): boolean {
  return def.needsAuth ?? def.needsBrowser;
}

export class Registry {
  readonly #byName = new Map<string, AnyCapability>();

  register(def: AnyCapability): void {
    if (this.#byName.has(def.name)) {
      // Silently replacing would make which implementation runs depend on
      // directory-listing order, which is not a thing anyone can debug.
      throw usage("CAPABILITY_DUPLICATE", `capability ${def.name} is already registered`);
    }
    this.#byName.set(def.name, def);
  }

  get(name: string): AnyCapability {
    const def = this.#byName.get(name);
    if (def) return def;
    throw usage(
      "CAPABILITY_UNKNOWN",
      `unknown capability ${name}; known capabilities: ${this.names().join(", ") || "(none)"}`,
    );
  }

  has(name: string): boolean {
    return this.#byName.has(name);
  }

  names(): string[] {
    return [...this.#byName.keys()].sort();
  }

  all(): AnyCapability[] {
    return this.names().map((n) => this.#byName.get(n)!);
  }

  manifest(): ManifestEntry[] {
    return this.all().map((def) => ({
      name: def.name,
      risk: def.risk,
      summary: def.summary,
      needs_browser: def.needsBrowser,
      needs_auth: needsAuth(def),
      args_schema: z.toJSONSchema(def.args, { io: "input" }),
      cost: costAtDefaults(def),
    }));
  }
}

/** The estimate for `{}`, when the schema accepts `{}` at all. */
function costAtDefaults(def: AnyCapability): CostEstimate | null {
  const parsed = def.args.safeParse({});
  if (!parsed.success) return null;
  try {
    return def.cost(parsed.data);
  } catch {
    return null;
  }
}

/**
 * Builds the registry by scanning `src/capabilities/` — one directory per
 * capability, each exporting its definition as `capability` or as the default
 * export. This is what "adding a capability means adding one directory" means
 * literally: there is no list of capabilities anywhere to forget to update.
 *
 * The directory name must equal the capability name. It is the one thing that
 * keeps the spec §10 promise — an agent reads `src/capabilities/profile.get/`
 * and is looking at what `cap profile.get` runs — and nothing else would catch a
 * rename that moved them apart.
 */
export async function loadCapabilities(
  o: { dir?: URL; registry?: Registry } = {},
): Promise<Registry> {
  const dir = o.dir ?? CAPABILITIES_DIR;
  const registry = o.registry ?? new Registry();

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (cause) {
    throw usage("CAPABILITY_DIR_UNREADABLE", `cannot read capability directory ${dir.pathname}: ${String(cause)}`);
  }

  for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const moduleUrl = new URL(`${entry.name}/index.ts`, dir);
    let mod: Record<string, unknown>;
    try {
      mod = (await import(moduleUrl.href)) as Record<string, unknown>;
    } catch (cause) {
      throw usage(
        "CAPABILITY_LOAD_FAILED",
        `capability directory ${entry.name} failed to load: ${String(cause)}`,
      );
    }
    const exported = mod["capability"] ?? mod["default"];
    assertWellFormed(exported, `capability directory ${entry.name}`);
    if (exported.name !== entry.name) {
      throw usage(
        "CAPABILITY_NAME_MISMATCH",
        `capability directory ${entry.name} declares the name ${exported.name}; they must match`,
      );
    }
    registry.register(exported);
  }
  return registry;
}
