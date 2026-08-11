import { z } from "zod";

export const selectionTypeSchema = z.enum(["INCLUDED", "EXCLUDED"]);

export const CANONICAL_RANGE_ATOM = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const rangeAtomSchema = z.union([z.string(), z.number()])
  .transform((value) => String(value))
  .pipe(z.string().regex(CANONICAL_RANGE_ATOM, "must be a canonical decimal without whitespace, prefixes, or exponent notation"))
  .refine((value) => Number.isFinite(Number(value)) && !/^-0(?:\.0+)?$/.test(value), "must be finite and cannot be negative zero");

export const entityFilterSchema = z.object({
  kind: z.literal("values"),
  type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  values: z.array(z.object({
    id: z.string().min(1),
    text: z.string().min(1),
    selectionType: selectionTypeSchema,
    /** Some measured URLs omit `text` although the vocabulary row has it. */
    emitText: z.boolean().default(true),
  }).strict()).min(1),
  selectedSubFilter: z.string().min(1).optional(),
}).strict();

export const rangeFilterSchema = z.object({
  kind: z.literal("range"),
  type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  min: rangeAtomSchema.optional(),
  max: rangeAtomSchema.optional(),
  selectedSubFilter: z.string().min(1).optional(),
}).strict();

export const rawTextFilterSchema = z.object({
  kind: z.literal("raw-text"),
  type: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  text: z.string().min(1),
  selectionType: selectionTypeSchema,
}).strict();

export const filterSpecSchema = z.object({
  vertical: z.enum(["LEAD", "ACCOUNT"]),
  keywords: z.string().min(1).optional(),
  recentSearch: z.object({
    doLogHistory: z.literal(true),
  }).strict().optional(),
  filters: z.array(z.discriminatedUnion("kind", [
    entityFilterSchema, rangeFilterSchema, rawTextFilterSchema,
  ])).min(1),
}).strict();

export type FilterSpec = z.infer<typeof filterSpecSchema>;
export type EntityFilter = z.infer<typeof entityFilterSchema>;
export type RangeFilter = z.infer<typeof rangeFilterSchema>;
export type RawTextFilter = z.infer<typeof rawTextFilterSchema>;
