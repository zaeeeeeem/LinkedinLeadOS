import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import { CapabilityError, EXIT } from "../../core/run/receipt.js";
import {
  FilterBuildError,
  VocabularyError,
  buildFilterUrl,
  filterSpecSchema,
  loadPinnedFilterCatalog,
  loadVocabulary,
} from "../../core/salesnav-query/index.js";

const args = z.object({
  spec: z.string().min(1),
  publicVocabPath: z.string().min(1).optional(),
  privateVocabPath: z.string().min(1).optional(),
}).strict();

function refusal(cause: unknown): CapabilityError {
  if (cause instanceof CapabilityError) return cause;
  if (cause instanceof FilterBuildError || cause instanceof VocabularyError) {
    return new CapabilityError({
      code: cause.code,
      exit: cause.code.includes("CATALOG") || cause.code.includes("REGISTRY") || cause.code.includes("PROVENANCE")
        ? EXIT.PARSE_DRIFT : EXIT.GENERIC,
      action: "HALT_AND_NOTIFY",
      retryable: false,
      message: cause.message,
    });
  }
  return new CapabilityError({
    code: "FILTER_SPEC_INVALID",
    exit: EXIT.GENERIC,
    action: "HALT_AND_NOTIFY",
    retryable: false,
    message: cause instanceof Error ? cause.message : String(cause),
  });
}

export const capability = defineCapability({
  name: "salesnav.filters.build",
  risk: "local",
  summary: "Validate a typed Sales Navigator filter spec and build its measured query URL offline.",
  args,
  needsBrowser: false,
  needsAuth: false,
  cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
  run: async (ctx) => {
    try {
      let input: unknown;
      try { input = JSON.parse(ctx.args.spec); } catch { throw new Error("--spec must be valid JSON"); }
      const parsed = filterSpecSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; "));
      }
      const vocabulary = await loadVocabulary({
        ...(ctx.args.publicVocabPath === undefined ? {} : { publicPath: ctx.args.publicVocabPath }),
        ...(ctx.args.privateVocabPath === undefined ? {} : { privatePath: ctx.args.privateVocabPath }),
      });
      const built = buildFilterUrl(parsed.data, loadPinnedFilterCatalog(), vocabulary);
      return {
        counts: {
          requested: parsed.data.filters.length,
          captured: 0,
          usable: built.filtersCount,
          skipped: 0,
        },
        warnings: built.warnings,
        data: {
          url: built.url,
          query: built.query,
          vertical: parsed.data.vertical,
          filters_count: built.filtersCount,
          vocabulary: built.vocabularyRows.map((row) => ({
            row_id: row.rowId,
            provenance_ids: row.provenance.map((source) => `${source.runId}/${source.archiveId}`),
            operator_scoped: row.operatorScoped,
          })),
        },
        next: "Pass the built URL to salesnav.filters.apply only under that capability's separate live budget and approval contract.",
      };
    } catch (cause) {
      throw refusal(cause);
    }
  },
});

export default capability;
