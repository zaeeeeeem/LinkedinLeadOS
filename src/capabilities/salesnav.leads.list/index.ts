import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";

export const capability = defineCapability({
  name: "salesnav.leads.list",
  risk: "local",
  summary: "Parser and store contract are ready; Task 39 wires the metered Sales Navigator runner.",
  args: z.object({}).strict(),
  needsBrowser: false,
  needsAuth: false,
  cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
  run: async () => {
    throw new CapabilityError({
      code: "CAPABILITY_NOT_IMPLEMENTED",
      exit: EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: "salesnav.leads.list execution is not wired; Task 39 must compose the parser with the paged runner before this command can touch LinkedIn",
    });
  },
});

export default capability;
