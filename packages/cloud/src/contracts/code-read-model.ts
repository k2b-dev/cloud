import { z } from "zod";

/** Platform-owned presentation for all Code surfaces. Keys are for navigation, never display text. */
export const CODE_READ_MODEL_LIST_LIMIT = 50;
export const CODE_READ_MODEL_RECENT_LIMIT = 6;
export const CODE_READ_MODEL_TIMELINE_LIMIT = 200;
const count = z.number().int().nonnegative();
const text = z.string();
const list = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item).max(CODE_READ_MODEL_LIST_LIMIT), more: count, moreText: text.nullable() });
export const CodeReadModelRowSchema = z.strictObject({
  text,
  note: text.optional(),
  href: text.optional(),
  app: text.optional(),
  icon: text.optional(),
});
export const CodeReadModelChangeSchema = z.strictObject({ kind: z.enum(["add", "remove", "same"]), text, note: text.optional() });
export const CodeReadModelNoticeSchema = z.strictObject({ severity: z.enum(["warning", "block"]), text, consequence: text });
export const CodeReadModelExampleSchema = z.strictObject({
  name: text,
  modelLabel: text,
  state: z.enum(["succeeded", "failed"]),
  status: text,
  sentence: text,
  differences: z.array(z.strictObject({ subject: text.optional(), expected: text, actual: text })).max(4),
});
export const CodeVersionReadModelSchema = z.strictObject({
  versionId: z.uuid(),
  number: z.number().int().positive(),
  submittedAt: z.iso.datetime(),
  locale: text,
  description: z.strictObject({ state: z.enum(["visible", "missing", "restricted"]), text: text.nullable(), modelLabel: text }),
  assurance: text,
  mayDo: list(CodeReadModelRowSchema),
  timing: list(CodeReadModelRowSchema),
  changes: z.strictObject({
    state: z.enum(["first", "changed", "access_same_behavior_changed", "same", "unavailable"]),
    text,
    rows: list(CodeReadModelChangeSchema),
    assurance: text,
  }),
  examples: z.strictObject({
    state: z.enum(["passed", "failed", "none", "unavailable"]),
    passed: count,
    total: count,
    summary: text,
    explanation: text,
    // Core additionally bounds this list by the installation's CodeTestLimits.cases.
    items: z.array(CodeReadModelExampleSchema),
  }),
  notices: list(CodeReadModelNoticeSchema),
});
export type CodeVersionReadModel = z.infer<typeof CodeVersionReadModelSchema>;
export type CodeReadModelRow = z.infer<typeof CodeReadModelRowSchema>;
export type CodeReadModelChange = z.infer<typeof CodeReadModelChangeSchema>;
export type CodeReadModelNotice = z.infer<typeof CodeReadModelNoticeSchema>;
export type CodeReadModelExample = z.infer<typeof CodeReadModelExampleSchema>;

export const CodeRunReadModelSchema = z.strictObject({
  runId: z.uuid(),
  title: text,
  state: z.enum(["queued", "running", "succeeded", "failed", "skipped"]),
  status: text,
  at: z.iso.datetime(),
  reason: text.nullable(),
  untilThen: list(CodeReadModelRowSchema),
  complete: z.boolean(),
});
export type CodeRunReadModel = z.infer<typeof CodeRunReadModelSchema>;
export const CodeActivityReadModelSchema = z.strictObject({
  week: z.iso.datetime(),
  counters: list(z.strictObject({ key: text, automationKey: text, text, count })),
  recent: z.array(z.strictObject({ text, at: z.iso.datetime(), href: text.optional(), runId: z.uuid() })).max(CODE_READ_MODEL_RECENT_LIMIT),
  timeline: z.strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    marks: z
      .array(
        z.strictObject({
          at: z.iso.datetime(),
          state: z.enum(["queued", "running", "succeeded", "failed", "skipped", "planned", "group"]),
          count,
          runId: z.uuid().optional(),
        }),
      )
      .max(CODE_READ_MODEL_TIMELINE_LIMIT),
    total: count,
  }),
});
export type CodeActivityReadModel = z.infer<typeof CodeActivityReadModelSchema>;
export const codeReadModelContracts = {
  version: {
    input: z.strictObject({
      codeId: text.describe("Code ID to read."),
      versionId: z.uuid().describe("Saved version to describe."),
      comparisonVersionId: z
        .uuid()
        .nullable()
        .optional()
        .describe("Version to compare; omit for the submitted baseline, null for no baseline."),
    }),
    data: CodeVersionReadModelSchema,
  },
  run: {
    input: z.strictObject({ codeId: text.describe("Code ID to read."), runId: z.uuid().describe("Recorded run ID.") }),
    data: CodeRunReadModelSchema,
  },
  activity: {
    input: z.strictObject({
      codeId: text.describe("Code ID to read."),
      day: z.iso.date().describe("Local calendar day in ISO format."),
      timeZone: text.describe("IANA time zone for this local day."),
    }),
    data: CodeActivityReadModelSchema,
  },
} as const;
