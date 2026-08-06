import { dirname } from "node:path";
import { z } from "zod";
import { defineCapability, ZERO_COST } from "../../cli/types.js";
import { parseDuration } from "../../core/store/freshness.js";
import { queryDrift } from "../../core/log/queries.js";

/**
 * `log.drift` — `parse.miss` events across every run, grouped by capability
 * and field, within a time window (spec §5's `log:drift --since=7d`). This
 * is what tells an agent which parser to go fix, not just that something
 * once failed to parse.
 */
export const capability = defineCapability({
  name: "log.drift",
  risk: "local",
  summary: "parse.miss events grouped by capability and field, within a time window.",
  args: z.object({ since: z.string().default("7d") }).strict(),
  needsBrowser: false,
  cost: () => ZERO_COST,
  run: async ({ run, args }) => {
    const sinceMs = parseDuration(args.since);
    const runsDir = dirname(run.dir);
    const { groups, truncated, dropped } = queryDrift(runsDir, { sinceMs });

    return {
      counts: { requested: groups.length, captured: groups.length, usable: groups.length, skipped: 0 },
      data: { since: args.since, groups, truncated, dropped },
      ...(truncated ? { warnings: [{ code: "LOG_RESULT_TRUNCATED", n: dropped }] } : {}),
    };
  },
});

export default capability;
