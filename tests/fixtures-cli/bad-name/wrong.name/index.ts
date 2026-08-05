import { z } from "zod";
import { defineCapability } from "../../../../src/cli/types.js";

export const capability = defineCapability({
  name: "not.the.directory",
  risk: "local",
  summary: "a capability whose name does not match its directory",
  args: z.object({}).strict(),
  needsBrowser: false,
  cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
  run: async () => ({}),
});
