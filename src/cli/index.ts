#!/usr/bin/env node
import { inspectLease } from "../core/lease/tab-lease.js";
import { defaultLeasePath } from "../core/lease/constants.js";
import { buildErr, CapabilityError, emitReceipt, EXIT } from "../core/run/receipt.js";
import type { Receipt } from "../core/run/receipt.js";
import { parseArgv } from "./flags.js";
import { loadCapabilities } from "./registry.js";
import { execute } from "./run.js";

const USAGE = `cap — LinkedIn toolkit capabilities

  cap list                       every capability as JSON: args schema, risk, cost
  cap <capability> [--flags]     run one capability

Universal flags (§4.4), accepted by every capability:
  --run-id=<id>      resume an existing run instead of starting a new one
  --dry-run          plan and cost estimate only; zero LinkedIn requests
  --fields=a,b,c     project the result into the receipt's data
  --no-store         archive and log, but skip the Supabase write
  --budget=<n>       cap page loads for this invocation (only ever lowers)
  --force-release    drop a wedged tab lease, naming its holder on the receipt

Every value is written --flag=value. Exit codes: 0 ok, 2 challenge, 3 rate-limited,
4 auth dead, 5 parse drift, 6 transient, 7 budget exhausted, 1 anything else.
`;

let emitted = false;

/** stdout carries exactly one receipt per invocation, on every path (§4). */
function emitOnce(receipt: Receipt): never {
  if (emitted) process.exit(receipt.ok ? EXIT.OK : receipt.error.exit);
  emitted = true;
  emitReceipt(receipt);
}

function errorReceipt(capability: string, err: CapabilityError): Receipt {
  return buildErr({
    run_id: "-",
    capability,
    err,
    cost: { search_credits: 0, page_loads: 0, elapsed_ms: 0 },
  });
}

function asCapabilityError(e: unknown): CapabilityError {
  if (e instanceof CapabilityError) return e;
  return new CapabilityError({
    code: "CLI_FAILED",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: e instanceof Error ? e.message : String(e),
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { command, flags, args, help } = parseArgv(argv);

  if (help || command === null) {
    process.stdout.write(USAGE);
    process.exit(command === null && !help ? EXIT.GENERIC : EXIT.OK);
  }

  const registry = await loadCapabilities();

  if (command === "list") {
    // The manifest an agent that lost its context rediscovers the toolkit from
    // (§4.5) — and, alongside it, the tab lease, because a wedged lease is the
    // one piece of state that makes every capability fail for a reason none of
    // their own receipts can explain (D16).
    process.stdout.write(
      JSON.stringify(
        {
          capabilities: registry.manifest(),
          lease: { path: defaultLeasePath(), ...(await inspectLease()) },
          exit_codes: EXIT,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(EXIT.OK);
  }

  // Named with the command the operator typed, not with "cap": a receipt whose
  // `capability` field does not say which capability was asked for is unreadable
  // in a log of many runs.
  let def;
  try {
    def = registry.get(command);
  } catch (e) {
    emitOnce(errorReceipt(command, asCapabilityError(e)));
  }

  let cleanup: () => Promise<void> = async () => {};
  const bail = (e: unknown): void => {
    // A throw from a CDP listener never reaches execute's await chain. Release
    // the tab and the lease anyway — a leftover lease wedges every later run,
    // and D16 refuses to time it out.
    void cleanup()
      .catch(() => {})
      .then(() => emitOnce(errorReceipt(def.name, asCapabilityError(e))));
  };
  process.on("uncaughtException", bail);
  process.on("unhandledRejection", bail);

  const { receipt } = await execute({
    def,
    rawArgs: args,
    flags,
    onCleanup: (fn) => {
      cleanup = fn;
    },
  });
  emitOnce(receipt);
}

main().catch((e: unknown) => {
  emitOnce(errorReceipt("cap", asCapabilityError(e)));
});
