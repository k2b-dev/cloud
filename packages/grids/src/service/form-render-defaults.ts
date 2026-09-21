import type { DateContext } from "@k2b/stdlib";
import { materializeFieldDefault } from "../field-defaults";
import type { Form } from "./forms";
import type { Field } from "./types";

/** Resolve display defaults once on the server, never mutate stored config. */
export const materializeFormRenderDefaults = (form: Form, fields: Field[], options: { dateConfig?: DateContext; now?: Date }): Form => {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const now = options.now ?? new Date();
  return {
    ...form,
    config: {
      ...form.config,
      fields: form.config.fields.map((entry) => {
        const field = byId.get(entry.fieldId);
        if (entry.kind !== "user_input" || field?.type !== "date" || entry.defaultValue === undefined) return entry;
        return { ...entry, defaultValue: materializeFieldDefault({ ...field, defaultValue: entry.defaultValue }, { ...options, now }) };
      }),
    },
  };
};
