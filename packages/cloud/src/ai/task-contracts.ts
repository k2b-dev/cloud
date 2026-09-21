import { z } from "zod";

const prompt = z.string().trim().min(1).max(20_000);
const modelProfileId = z.string().trim().min(1).max(120).optional();
const choice = z.string().trim().min(1).max(200);
const choices = z
  .array(choice)
  .min(2)
  .max(50)
  .refine((values) => new Set(values).size === values.length, "Choices must be unique.");

const structuredField = z
  .object({
    name: z
      .string()
      .trim()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/),
    type: z.enum(["text", "number", "boolean", "date_time", "enum"]),
    description: z.string().trim().min(1).max(500),
    required: z.boolean().default(true),
    choices: z.array(choice).min(1).max(50).optional(),
    maxLength: z.number().int().min(1).max(20_000).optional(),
  })
  .strict()
  .superRefine((field, ctx) => {
    if (field.type === "enum" && !field.choices)
      ctx.addIssue({ code: "custom", path: ["choices"], message: "Enum fields require choices." });
    if (field.type !== "enum" && field.choices)
      ctx.addIssue({ code: "custom", path: ["choices"], message: "Choices are only valid for enum fields." });
    if (field.type !== "text" && field.maxLength)
      ctx.addIssue({ code: "custom", path: ["maxLength"], message: "maxLength is only valid for text fields." });
  });

const structuredFields = z
  .array(structuredField)
  .min(1)
  .max(40)
  .refine((fields) => new Set(fields.map((field) => field.name)).size === fields.length, "Structured field names must be unique.");

export const AiTaskRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("generate_text"),
    prompt,
    input: z.unknown().optional(),
    modelProfileId,
    maxOutputChars: z.number().int().min(1).max(20_000).default(4_000),
  }),
  z.object({
    kind: z.literal("classify"),
    prompt,
    input: z.unknown(),
    choices,
    modelProfileId,
  }),
  z
    .object({
      kind: z.literal("classify_many"),
      prompt,
      input: z.unknown(),
      choices,
      minChoices: z.number().int().min(0).max(50).default(0),
      maxChoices: z.number().int().min(0).max(50).optional(),
      modelProfileId,
    })
    .superRefine((value, ctx) => {
      const maximum = value.maxChoices ?? value.choices.length;
      if (maximum > value.choices.length) {
        ctx.addIssue({ code: "custom", path: ["maxChoices"], message: "maxChoices cannot exceed the number of choices." });
      }
      if (value.minChoices > maximum) {
        ctx.addIssue({ code: "custom", path: ["minChoices"], message: "minChoices cannot exceed maxChoices." });
      }
    }),
  z.object({
    kind: z.literal("extract_data"),
    prompt,
    input: z.unknown(),
    fields: structuredFields,
    modelProfileId,
  }),
]);

export type AiTaskRequest = z.infer<typeof AiTaskRequestSchema>;
export type AiTaskRequestInput = z.input<typeof AiTaskRequestSchema>;
