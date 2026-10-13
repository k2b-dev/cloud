import { z } from "zod";
import { CapabilityQualifiedIdSchema, CloudResourceRefSchema } from "../contracts/capabilities";
import {
  WIDGET_SETTING_MAX_OPTIONS,
  WIDGET_SETTING_TEXT_MAX_LENGTH,
  WIDGET_SETTINGS_MAX_FIELDS,
  WIDGET_TITLE_MAX_LENGTH,
  type WidgetSettings,
  type WidgetSettingsDeclaration,
  type WidgetSettingValue,
} from "../contracts/widgets";

const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const settingLabel = z.string().trim().min(1).max(WIDGET_TITLE_MAX_LENGTH);
/** The single declaration schema used at startup and for tolerant registry reads. */
export const WidgetSettingsDeclarationSchema = z
  .record(
    z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
    z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("choice"),
          label: settingLabel,
          options: z
            .array(
              z.object({
                label: settingLabel,
                value: z
                  .string()
                  .min(1)
                  .max(100)
                  .refine((value) => !controlCharacters.test(value)),
              }),
            )
            .min(1)
            .max(WIDGET_SETTING_MAX_OPTIONS),
          default: z.string().optional(),
        })
        .superRefine((field, ctx) => {
          if (new Set(field.options.map((option) => option.value)).size !== field.options.length)
            ctx.addIssue({ code: "custom", path: ["options"], message: "Choice option values must be distinct" });
          if (field.default !== undefined && !field.options.some((option) => option.value === field.default))
            ctx.addIssue({ code: "custom", path: ["default"], message: "Choice default must be a declared option" });
        }),
      z.object({ kind: z.literal("resource"), label: settingLabel, type: CapabilityQualifiedIdSchema }),
      z.object({ kind: z.literal("toggle"), label: settingLabel, default: z.boolean().optional() }),
      z.object({
        kind: z.literal("text"),
        label: settingLabel,
        placeholder: settingLabel.optional(),
        maxLength: z.number().int().min(1).max(WIDGET_SETTING_TEXT_MAX_LENGTH).optional(),
      }),
    ]),
  )
  .refine((fields) => Object.keys(fields).length <= WIDGET_SETTINGS_MAX_FIELDS, `Declare at most ${WIDGET_SETTINGS_MAX_FIELDS} settings`);

/** Drop invalid or undeclared values and fill choice and toggle defaults without reporting input errors. */
export const parseWidgetSettings = (declaration: WidgetSettingsDeclaration | undefined, raw: unknown): WidgetSettings => {
  const values = z.record(z.string(), z.unknown()).safeParse(raw);
  const settings: Record<string, WidgetSettingValue> = {};
  for (const [name, field] of Object.entries(declaration ?? {})) {
    const value = values.success && Object.hasOwn(values.data, name) ? values.data[name] : undefined;
    switch (field.kind) {
      case "choice":
        if (typeof value === "string" && field.options.some((option) => option.value === value)) settings[name] = value;
        else if (field.default !== undefined) settings[name] = field.default;
        break;
      case "toggle":
        if (typeof value === "boolean") settings[name] = value;
        else if (field.default !== undefined) settings[name] = field.default;
        break;
      case "text": {
        if (typeof value !== "string" || controlCharacters.test(value)) break;
        const text = value.trim();
        if (text && text.length <= (field.maxLength ?? WIDGET_SETTING_TEXT_MAX_LENGTH)) settings[name] = text;
        break;
      }
      case "resource": {
        const ref = CloudResourceRefSchema.safeParse(value);
        if (ref.success && ref.data.type === field.type) settings[name] = ref.data;
        break;
      }
    }
  }
  return settings;
};
