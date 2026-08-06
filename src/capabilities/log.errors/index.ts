import { dirname } from "node:path";
import { z } from "zod";
import { defineCapability, ZERO_COST } from "../../cli/types.js";
import { queryErrors } from "../../core/log/queries.js";

/**
 * `log.errors` — every `warn`/`error`-level event in one run (spec §5's
 * `log:errors --run=<id>`), in the order they were written. The `info`/
 * `debug` events that make up the successful majority of a long run are
 * exactly what this query exists to filter out.
 */
export const capability = defineCapability({
  name: "log.errors",
  risk: "local",
  summary: "Failures and warnings for one run, in order — bounded, never the full event log.",
  args: z.object({ run: z.string().min(1) }).strict(),
  needsBrowser: false,
  cost: () => ZERO_COST,
  run: async ({ run, args }) => {
    const runsDir = dirname(run.dir);
    const result = queryErrors(runsDir, args.run);

    return {
      counts: {
        requested: result.events.length,
        captured: result.events.length,
        usable: result.events.length,
        skipped: 0,
      },
      data: result,
      ...(result.truncated ? { warnings: [{ code: "LOG_RESULT_TRUNCATED", n: result.dropped }] } : {}),
      next: `cap log.why --run=${args.run} --item=<ref>`,
    };
  },
});

export default capability;
