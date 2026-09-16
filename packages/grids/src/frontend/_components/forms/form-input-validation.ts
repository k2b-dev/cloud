import { objectListHandler, objectListScalarHandlers } from "../../../field-types/object-list";
import { principalHandler } from "../../../field-types/principal";
import { jsonHandler } from "../../../field-types/tier3";
import type { FieldValidationContext, ValueFieldType } from "../../../field-types/types";
import { fieldValidationMessages } from "../../../field-types/validation-messages";
import type { FrontendField, UserInputEntry } from "./form-fields";

const handlers: Record<string, ValueFieldType> = {
  ...objectListScalarHandlers,
  object_list: objectListHandler,
  principal: principalHandler,
  json: jsonHandler,
};

/** Reuse write validators without replacing input with their normalized storage values. */
export function formFieldError(
  field: Pick<FrontendField, "type" | "config" | "required">,
  entry: Pick<UserInputEntry, "required">,
  value: unknown,
  context: FieldValidationContext,
): string | undefined {
  const required = Boolean(entry.required || field.required);
  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
  if (required && empty && field.type !== "boolean") return fieldValidationMessages(context.locale).required;
  // Browser relations use public IDs and temporary inline IDs; existence and
  // access checks belong to the server, whose relation validator expects UUIDs.
  const handler = handlers[field.type];
  if (!handler) return;
  const result = handler.validate(field.type === "boolean" && value === undefined ? false : value, field.config, required, context);
  return result.ok ? undefined : result.error;
}
