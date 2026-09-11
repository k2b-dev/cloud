import { z } from "zod";
import { FormatSpecSchema } from "../contracts";
import { parseFormula } from "../formula/parser";
import type { ComputedFieldKind } from "./types";

// Expression is optional at create-time so a brand-new formula field
// can be added before the user has typed the formula in. Once an
// expression is present, the superRefine parse-checks it so typos like
// `1 +` get rejected at save-time rather than disappearing at record-
// enrichment time.
export const FormulaConfigSchema = z
  .object({
    expression: z.string().optional(),
    format: FormatSpecSchema.optional(),
  })
  .superRefine((cfg, ctx) => {
    const expr = cfg.expression?.trim();
    if (!expr) return;
    const result = parseFormula(expr);
    if (!result.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `formula parse error: ${result.error}`,
        path: ["expression"],
      });
    }
  });

/**
 * Formula field — read-only, computed at records.list time. Save-time
 * validation parses the expression via the config schema's superRefine.
 */
export const formulaHandler: ComputedFieldKind = {
  type: "formula",
  kind: "computed",
  configSchema: FormulaConfigSchema,
};
