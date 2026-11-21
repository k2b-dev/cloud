import { z } from "zod";
import { CodeIdSchema } from "./contracts";
import { CodePageReportReasonSchema } from "./page-provenance-contracts";

/** Administration › Code reads and resolves the reports members filed on an automation's pages. */
export const codePageReportContracts = {
  list: {
    input: z
      .object({
        codeId: CodeIdSchema,
        state: z.enum(["open", "resolved"]).default("open"),
        /** Opaque cursor of the previous page. */
        cursor: z.string().max(100).optional(),
      })
      .strict(),
  },
  resolve: { input: z.object({ codeId: CodeIdSchema, reportId: z.uuid() }).strict() },
} as const;

export const CodePageReportSchema = z
  .object({
    id: z.uuid(),
    reporter: z.object({ id: z.uuid(), name: z.string() }).strict(),
    path: z.string(),
    reason: CodePageReportReasonSchema.nullable(),
    text: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    state: z.enum(["open", "resolved"]),
    resolvedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict();
export type CodePageReport = z.infer<typeof CodePageReportSchema>;
export const CodePageReportPageSchema = z.object({ items: z.array(CodePageReportSchema), nextCursor: z.string().nullable() }).strict();
export type CodePageReportPage = z.infer<typeof CodePageReportPageSchema>;
