import { dirname } from "node:path";
import { z } from "zod";
import { defineCapability, ZERO_COST } from "../../cli/types.js";
import { parseDuration } from "../../core/store/freshness.js";
import { listRuns } from "../../core/log/queries.js";

/**
 * `log.runs` — one line per run, most-recently-active first, within a time
 * window (spec §5's `log:runs --since=24h`). Local only: reads `run.json`
 * and `summary.json` under `runs/`, no browser, no LinkedIn, no budget.
 */
export const capability = defineCapability({
  name: "log.runs",
  risk: "local",
  summary: "Run summaries within a time window, one line each — bounded, never a raw file dump.",
  args: z.object({
    since: z.string().default("24h"),
    /** Include this query's own runs, and every earlier one. Off by default:
     *  they are newest-first and would crowd out the runs being debugged. */
    includeQueries: z.coerce.boolean().default(false),
  }).strict(),
  needsBrowser: false,
  cost: () => ZERO_COST,
  run: async ({ run, args }) => {
    const sinceMs = parseDuration(args.since);
    const runsDir = dirname(run.dir);
    const { runs, truncated, dropped } = listRuns(runsDir, {
      sinceMs,
      includeQueries: args.includeQueries,
    });

    return {
      counts: { requested: runs.length, captured: runs.length, usable: runs.length, skipped: 0 },
      data: { since: args.since, runs, truncated, dropped },
      ...(truncated ? { warnings: [{ code: "LOG_RESULT_TRUNCATED", n: dropped }] } : {}),
      next: "cap log.why --run=<id> --item=<ref>",
    };
  },
});

export default capability;
