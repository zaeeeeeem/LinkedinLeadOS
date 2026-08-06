import { dirname } from "node:path";
import { z } from "zod";
import { defineCapability, ZERO_COST } from "../../cli/types.js";
import { queryWhy } from "../../core/log/queries.js";

/**
 * `log.why` — every event for one item in one run (spec §5's
 * `log:why --run=<id> --item=<ref>`), in the order they were written. This
 * is what an operator reads when something has already gone wrong, so a
 * truncated trailing line from a killed process must not make it read as
 * empty — `queryWhy` returns everything complete before the damage, always.
 */
export const capability = defineCapability({
  name: "log.why",
  risk: "local",
  summary: "Every event for one item in one run — the bounded slice for debugging a single failure.",
  args: z.object({ run: z.string().min(1), item: z.string().min(1) }).strict(),
  needsBrowser: false,
  cost: () => ZERO_COST,
  run: async ({ run, args }) => {
    const runsDir = dirname(run.dir);
    const result = queryWhy(runsDir, args.run, args.item);

    return {
      counts: {
        requested: result.events.length,
        captured: result.events.length,
        usable: result.events.length,
        skipped: 0,
      },
      data: result,
      ...(result.truncated ? { warnings: [{ code: "LOG_RESULT_TRUNCATED", n: result.dropped }] } : {}),
    };
  },
});

export default capability;
