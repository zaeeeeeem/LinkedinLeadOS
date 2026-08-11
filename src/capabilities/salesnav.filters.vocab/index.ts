import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineCapability } from "../../cli/types.js";
import { CapabilityError, EXIT, type ExitCode } from "../../core/run/receipt.js";
import {
  PUBLIC_VOCABULARY_PATH,
  VocabularyError,
  auditVocabularyRow,
  harvestVocabulary,
  loadVocabulary,
  mergeVocabularyRegistries,
  privateVocabularyPath,
  readVocabularyFile,
  splitVocabulary,
  writeVocabularyFile,
} from "../../core/salesnav-query/index.js";

const args = z.object({
  operation: z.enum(["lookup", "list", "audit", "harvest"]).default("list"),
  vertical: z.enum(["LEAD", "ACCOUNT"]).optional(),
  facet: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  text: z.string().min(1).optional(),
  rowId: z.string().regex(/^[a-f0-9]{24}$/).optional(),
  runIds: z.string().min(1).optional(),
  runsDir: z.string().min(1).optional(),
  publicVocabPath: z.string().min(1).optional(),
  privateVocabPath: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

function usage(code: string, message: string, exit: ExitCode = EXIT.GENERIC): CapabilityError {
  return new CapabilityError({ code, exit, action: "HALT_AND_NOTIFY", retryable: false, message });
}

function required(value: string | undefined, name: string): string {
  if (value === undefined) throw usage("VOCAB_ARGUMENT_REQUIRED", `${name} is required for this operation`);
  return value;
}

function exitForVocabularyError(error: VocabularyError): ExitCode {
  return error.code === "VOCAB_REGISTRY_INVALID" || error.code === "VOCAB_REGISTRY_BOUNDED" || error.code === "VOCAB_ROW_INVALID" ||
    error.code === "VOCAB_PROVENANCE_INVALID" || error.code === "VOCAB_ROW_ID_INVALID" ||
    error.code === "VOCAB_SCOPE_INVALID" || error.code === "VOCAB_ID_CONFLICT" ||
    error.code === "VOCAB_ROW_DUPLICATE"
    ? EXIT.PARSE_DRIFT
    : EXIT.GENERIC;
}

function safeRows(rows: Awaited<ReturnType<typeof loadVocabulary>>["rows"]) {
  return rows.map((row) => ({
    row_id: row.rowId,
    vertical: row.vertical,
    facet: row.facet,
    id: row.id,
    text: row.text,
    operator_scoped: row.operatorScoped,
    provenance_ids: row.provenance.map((source) => `${source.runId}/${source.archiveId}`),
  }));
}

export const capability = defineCapability({
  name: "salesnav.filters.vocab",
  risk: "local",
  summary: "Lookup, list, audit, or archive-harvest the measured Sales Navigator filter vocabulary offline.",
  args,
  needsBrowser: false,
  needsAuth: false,
  cost: () => ({ page_loads: 0, search_pages: 0, profile_opens: 0 }),
  run: async (ctx) => {
    try {
      const publicPath = ctx.args.publicVocabPath ?? fileURLToPath(PUBLIC_VOCABULARY_PATH);
      const privatePath = ctx.args.privateVocabPath ?? privateVocabularyPath(ctx.args.runsDir);
      if (ctx.args.operation === "harvest") {
        const runIds = required(ctx.args.runIds, "--run-ids").split(",").map((id) => id.trim()).filter(Boolean);
        const harvestWarnings: Array<{ code: string }> = [];
        const harvested = await harvestVocabulary({
          runIds,
          ...(ctx.args.runsDir === undefined ? {} : { runsDir: ctx.args.runsDir }),
          onWarning: (warning) => harvestWarnings.push({ code: warning.code }),
        });
        const split = splitVocabulary(harvested);
        const existingPublic = await readVocabularyFile(publicPath);
        const existingPrivate = await readVocabularyFile(privatePath);
        const publicRows = mergeVocabularyRegistries(existingPublic, split.publicRows);
        const privateRows = mergeVocabularyRegistries(existingPrivate, split.privateRows);
        const committed: string[] = [];
        try {
          await writeVocabularyFile(privatePath, privateRows);
          committed.push("private");
          await writeVocabularyFile(publicPath, publicRows);
          committed.push("public");
        } catch (cause) {
          throw usage(
            "VOCAB_HARVEST_PARTIAL_WRITE",
            `vocabulary harvest failed after atomically committing: ${committed.join(", ") || "none"}; rerun is idempotent (${cause instanceof Error ? cause.message : String(cause)})`,
          );
        }
        return {
          counts: { requested: runIds.length, captured: harvested.rows.length, usable: harvested.rows.length, skipped: harvestWarnings.length },
          warnings: [...new Set(harvestWarnings.map((warning) => warning.code))].sort().map((code) => ({
            code,
            n: harvestWarnings.filter((warning) => warning.code === code).length,
          })),
          data: {
            operation: "harvest",
            source_runs: runIds,
            rows_harvested: harvested.rows.length,
            public_rows_total: publicRows.rows.length,
            private_rows_total: privateRows.rows.length,
            per_facet: Object.fromEntries([...new Set(harvested.rows.map((row) => row.facet))].sort().map((facet) => [
              facet, harvested.rows.filter((row) => row.facet === facet).length,
            ])),
          },
        };
      }

      const registry = await loadVocabulary({ publicPath, privatePath });
      if (ctx.args.operation === "audit") {
        const rowId = required(ctx.args.rowId, "--row-id");
        const row = registry.rows.find((candidate) => candidate.rowId === rowId);
        if (row === undefined) throw usage("VOCAB_ROW_NOT_FOUND", `no vocabulary row has id ${rowId}`);
        const audit = await auditVocabularyRow(row, ctx.args.runsDir);
        if (!audit.ok) throw usage("VOCAB_AUDIT_FAILED", `row ${rowId} did not resolve to its named archive source`, EXIT.PARSE_DRIFT);
        return {
          counts: { requested: 1, captured: audit.checked, usable: 1, skipped: 0 },
          data: { operation: "audit", row_id: rowId, ok: true, sources_checked: audit.checked },
        };
      }

      const vertical = required(ctx.args.vertical, "--vertical") as "LEAD" | "ACCOUNT";
      const facet = required(ctx.args.facet, "--facet");
      let rows = registry.rows.filter((row) => row.vertical === vertical && row.facet === facet);
      if (ctx.args.operation === "lookup") {
        const text = required(ctx.args.text, "--text").trim().toLocaleLowerCase("en-US");
        rows = rows.filter((row) => row.text.trim().toLocaleLowerCase("en-US") === text);
      }
      const returned = rows.slice(0, ctx.args.limit);
      return {
        counts: { requested: rows.length, captured: 0, usable: returned.length, skipped: rows.length - returned.length },
        warnings: rows.length > returned.length ? [{ code: "VOCAB_RESULT_TRUNCATED", n: rows.length - returned.length }] : [],
        data: { operation: ctx.args.operation, vertical, facet, rows: safeRows(returned) },
      };
    } catch (cause) {
      if (cause instanceof CapabilityError) throw cause;
      if (cause instanceof VocabularyError) throw usage(cause.code, cause.message, exitForVocabularyError(cause));
      throw usage("VOCAB_FAILED", cause instanceof Error ? cause.message : String(cause));
    }
  },
});

export default capability;
