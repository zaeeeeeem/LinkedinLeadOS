import { CapabilityError, EXIT } from "../core/run/receipt.js";
import type { UniversalFlags } from "./types.js";

export const DEFAULT_FLAGS: UniversalFlags = {
  runId: null,
  dryRun: false,
  fields: null,
  noStore: false,
  budget: null,
  forceRelease: false,
};

export type ParsedInvocation = {
  /** The capability name or built-in subcommand; `null` when none was given. */
  command: string | null;
  flags: UniversalFlags;
  /** Raw capability arguments, before the capability's own schema sees them.
   *  Values are strings (or `true` for a bare flag, or an array when repeated) —
   *  coercion is the schema's job, so `z.coerce` is where numbers get made. */
  args: Record<string, unknown>;
  help: boolean;
};

/** Universal flags that carry a value, and so must be written `--flag=value`. */
const VALUE_FLAGS = new Set(["run-id", "fields", "budget"]);
/** Universal flags that are switches. */
const BOOLEAN_FLAGS = new Set(["dry-run", "no-store", "force-release", "help"]);

function invalid(code: string, message: string): CapabilityError {
  return new CapabilityError({
    code,
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message,
  });
}

const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Splits argv into the subcommand, the universal flags of §4.4, and whatever is
 * left for the capability's own schema.
 *
 * Every value is written `--flag=value`, universal and capability flags alike.
 * The alternative — consuming the next token — cannot be applied uniformly here,
 * because the parser does not know a capability's schema at this point and so
 * cannot know whether `--verbose next` means a value or a switch followed by a
 * positional. One rule that always holds beats two rules that disagree on the
 * arguments nobody tested.
 */
export function parseArgv(argv: string[]): ParsedInvocation {
  const flags: UniversalFlags = { ...DEFAULT_FLAGS };
  // Null-prototype: capability arg names come from argv, so `--__proto__=x` must
  // land as an ordinary key rather than reaching Object.prototype.
  const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  let command: string | null = null;
  let help = false;

  for (const token of argv) {
    if (!token.startsWith("--")) {
      if (command === null) {
        command = token;
        continue;
      }
      throw invalid(
        "FLAG_POSITIONAL",
        `unexpected argument ${token}; every value is passed as --name=value`,
      );
    }

    const body = token.slice(2);
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const raw = eq === -1 ? null : body.slice(eq + 1);

    if (VALUE_FLAGS.has(name)) {
      if (raw === null) throw invalid("FLAG_INVALID", `--${name} needs a value: --${name}=<value>`);
      applyValueFlag(flags, name, raw);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      if (raw !== null) throw invalid("FLAG_INVALID", `--${name} takes no value`);
      if (name === "dry-run") flags.dryRun = true;
      if (name === "no-store") flags.noStore = true;
      if (name === "force-release") flags.forceRelease = true;
      if (name === "help") help = true;
      continue;
    }

    if (name === "") throw invalid("FLAG_INVALID", "empty flag name");
    const key = camel(name);
    const value: string | true = raw === null ? true : raw;
    const existing = args[key];
    if (existing === undefined) args[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else args[key] = [existing, value];
  }

  return { command, flags, args, help };
}

function applyValueFlag(flags: UniversalFlags, name: string, raw: string): void {
  if (name === "run-id") {
    if (raw === "") throw invalid("FLAG_INVALID", "--run-id= needs a run id");
    flags.runId = raw;
    return;
  }
  if (name === "fields") {
    const fields = raw.split(",").map((f) => f.trim()).filter((f) => f !== "");
    if (fields.length === 0) {
      throw invalid("FLAG_INVALID", "--fields= needs at least one field name");
    }
    flags.fields = fields;
    return;
  }
  // --budget: a per-invocation page-load cap. Only ever lowers a limit (§8), which
  // is enforced where it is applied, not here.
  if (!/^\d+$/.test(raw)) {
    throw invalid("FLAG_INVALID", `--budget= must be a whole number of page loads, got ${raw}`);
  }
  flags.budget = Number(raw);
}
