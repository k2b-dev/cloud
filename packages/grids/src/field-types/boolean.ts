import { z } from "zod";
import { fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

const BoolConfigSchema = z.object({});

export const booleanHandler: ValueFieldType = {
  type: "boolean",
  kind: "value",
  configSchema: BoolConfigSchema,
  validate(raw, _config, required, context) {
    const t = fieldValidationMessages(context?.locale);
    if (raw === null || raw === undefined) {
      return required ? fail(t.required) : ok(null);
    }
    if (typeof raw === "boolean") return ok(raw);
    // Tolerant of common API-form encodings.
    if (raw === "true" || raw === 1 || raw === "1") return ok(true);
    if (raw === "false" || raw === 0 || raw === "0") return ok(false);
    return fail(t.boolean);
  },
};
