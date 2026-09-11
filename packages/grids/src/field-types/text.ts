import { z } from "zod";
import { type FieldValidationContext, fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

const BaseTextConfigSchema = z.object({
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).optional(),
  regex: z.string().optional(),
  multiline: z.boolean().optional(),
});

const TextConfigSchema = BaseTextConfigSchema;
const LongTextConfigSchema = BaseTextConfigSchema.extend({
  markdown: z.boolean().optional(),
});

const validateTextValue = (
  raw: unknown,
  config: z.infer<typeof BaseTextConfigSchema>,
  required: boolean,
  context?: FieldValidationContext,
) => {
  const t = fieldValidationMessages(context?.locale);
  if (raw === null || raw === undefined) {
    return required ? fail(t.required) : ok(null);
  }
  if (typeof raw !== "string") return fail(t.text);

  // Trimming applies to single-line text only; longtext preserves whitespace.
  const value = config.multiline ? raw : raw.trim();

  if (value.length === 0) return required ? fail(t.required) : ok(null);

  if (config.minLength !== undefined && value.length < config.minLength) {
    return fail(t.minLength({ count: config.minLength }));
  }
  if (config.maxLength !== undefined && value.length > config.maxLength) {
    return fail(t.maxLength({ count: config.maxLength }));
  }
  if (config.regex !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(config.regex);
    } catch {
      return fail(t.regexConfig);
    }
    if (!re.test(value)) return fail(t.regex);
  }
  return ok(value);
};

const validateText = (raw: unknown, configRaw: unknown, required: boolean, context?: FieldValidationContext) => {
  const parsed = TextConfigSchema.safeParse(configRaw ?? {});
  if (!parsed.success) return fail(fieldValidationMessages(context?.locale).config);
  return validateTextValue(raw, parsed.data, required, context);
};

export const textHandler: ValueFieldType = {
  type: "text",
  kind: "value",
  configSchema: TextConfigSchema,
  validate: validateText,
};

export const longtextHandler: ValueFieldType = {
  type: "longtext",
  kind: "value",
  configSchema: LongTextConfigSchema,
  validate: (raw, configRaw, required, context) => {
    const parsed = LongTextConfigSchema.safeParse(configRaw ?? {});
    if (!parsed.success) return fail(fieldValidationMessages(context?.locale).config);
    return validateTextValue(raw, { ...parsed.data, multiline: true }, required, context);
  },
};
