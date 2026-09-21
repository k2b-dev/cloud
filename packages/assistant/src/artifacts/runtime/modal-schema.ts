import { z } from "zod";
import { LIMITS } from "../contracts";

const text = z.string().max(LIMITS.text);
const label = text.trim().min(1);
const base = {
  title: label,
  confirmText: label.optional(),
  cancelText: label.optional(),
  variant: z.enum(["primary", "success", "danger"]).optional(),
};
const field = { label, description: text.optional(), placeholder: text.optional(), required: z.boolean().optional() };
export const ModalField = z.discriminatedUnion("type", [
  z
    .object({
      ...field,
      type: z.literal("text"),
      default: text.optional(),
      multiline: z.boolean().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().max(LIMITS.text).optional(),
    })
    .strict(),
  z
    .object({
      ...field,
      type: z.literal("number"),
      default: z.number().finite().optional(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
      step: z.number().positive().optional(),
    })
    .strict(),
  z.object({ ...field, type: z.literal("boolean"), default: z.boolean().optional() }).strict(),
  z
    .object({
      ...field,
      type: z.literal("select"),
      default: text.optional(),
      options: z
        .array(z.object({ value: label, label, icon: text.optional(), description: text.optional() }).strict())
        .min(1)
        .max(200),
    })
    .strict(),
]);
export const ModalRequest = z
  .discriminatedUnion("kind", [
    z.object({ ...base, kind: z.literal("confirm"), message: text }).strict(),
    z
      .object({
        ...base,
        kind: z.literal("text"),
        label,
        value: text.optional(),
        required: z.boolean().optional(),
        minLength: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().positive().max(LIMITS.text).optional(),
        multiline: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("number"),
        label,
        value: z.number().finite().optional(),
        required: z.boolean().optional(),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        kind: z.literal("dialog"),
        fields: z
          .record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/), ModalField)
          .refine((fields) => Object.keys(fields).length > 0 && Object.keys(fields).length <= 64, "Dialogs need 1–64 fields"),
      })
      .strict(),
  ])
  .superRefine((request, ctx) => {
    const fields =
      request.kind === "dialog" ? Object.values(request.fields) : request.kind === "confirm" ? [] : [{ ...request, type: request.kind }];
    for (const f of fields) {
      if (f.type === "number" && f.min !== undefined && f.max !== undefined && f.min > f.max)
        ctx.addIssue({ code: "custom", message: "min must not exceed max" });
      if (f.type === "text" && f.minLength !== undefined && f.maxLength !== undefined && f.minLength > f.maxLength)
        ctx.addIssue({ code: "custom", message: "minLength must not exceed maxLength" });
      if (
        f.type === "select" &&
        (new Set(f.options.map((o) => o.value)).size !== f.options.length ||
          (f.default !== undefined && !f.options.some((o) => o.value === f.default)))
      )
        ctx.addIssue({ code: "custom", message: "Select values must be unique and contain the default" });
    }
  });
export type ModalRequest = z.infer<typeof ModalRequest>;
