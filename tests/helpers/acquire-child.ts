/**
 * Acquires the tab lease in its own process, so the concurrency tests exercise
 * real cross-process filesystem races rather than interleaved promises in one
 * event loop. Waits for a shared wall-clock start so several children collide on
 * purpose. Exits 0 when it holds the lease, or with the failure's exit code.
 *
 * Stays alive for `hold` ms after acquiring: a winner that exited immediately
 * would leave a dead pid behind, and the next racer would legitimately reclaim it
 * rather than being refused, which is not the race under test.
 *
 * argv: <lease path> <run id> <start at, epoch ms> <extra delay ms> <hold ms>
 */
import { acquireLease } from "../../src/core/lease/tab-lease.js";
import { CapabilityError } from "../../src/core/run/receipt.js";

const [path, runId, startAt, extra, hold] = process.argv.slice(2);

const wait = Number(startAt) + Number(extra ?? 0) - Date.now();
if (wait > 0) await new Promise<void>((ok) => setTimeout(ok, wait));

try {
  const rec = await acquireLease({ runId: runId!, capability: "profile.get", path: path! });
  process.stdout.write(rec.run_id);
  await new Promise<void>((ok) => setTimeout(ok, Number(hold ?? 0)));
  process.exit(0);
} catch (e) {
  process.stdout.write(e instanceof CapabilityError ? e.code : String(e));
  process.exit(e instanceof CapabilityError ? e.exit : 1);
}
