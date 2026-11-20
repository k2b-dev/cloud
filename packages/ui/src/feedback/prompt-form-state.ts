import { createStore } from "solid-js/store";
import { resolveUiMessages } from "../intl/messages";
import { resolvePromptMessages } from "./prompt-messages";
import type { FieldSchema, PromptFormValue } from "./prompts";

// The form state of `prompts.form`, public as `createFormState`. A module of its own, so the form fields that load
// on demand use it without an import cycle back into the prompts.

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

export const createFormState = <T extends Record<string, FieldSchema>>(schema: T) => {
  const messages = resolveUiMessages();
  const promptMessages = resolvePromptMessages();
  const [values, setValues] = createStore<Record<string, PromptFormValue>>({});
  const [errors, setErrors] = createStore<Record<string, string | undefined>>({});
  // Errors appear with the first submit and then follow every change. Before that, a check that fails mid-input,
  // such as a URL still being typed, would interrupt the user with an alert on the first character.
  let submitted = false;

  for (const [key, field] of Object.entries(schema)) {
    if (field.type !== "info" && "default" in field) setValues(key, field.default as PromptFormValue);
  }

  const validateField = (key: string, value: PromptFormValue): string | null => {
    const field = schema[key];
    if (!field || field.type === "info") return null;
    if (field.type === "boolean" && field.required && value !== true) return messages.required;
    if (field.required && isEmpty(value)) return messages.required;
    if ("validate" in field && field.validate) {
      const customError = (field.validate as (next: never) => string | null)(value as never);
      if (customError) return customError;
    }
    if (field.type === "text" && typeof value === "string" && value.length > 0) {
      if (field.minLength !== undefined && value.length < field.minLength) return promptMessages.minCharacters({ count: field.minLength });
      if (field.maxLength !== undefined && value.length > field.maxLength) return promptMessages.maxCharacters({ count: field.maxLength });
    }
    if (field.type === "tags" && Array.isArray(value) && value.length > 0) {
      if (field.minTags !== undefined && value.length < field.minTags) return promptMessages.minTags({ count: field.minTags });
      if (field.maxTags !== undefined && value.length > field.maxTags) return promptMessages.maxTags({ count: field.maxTags });
    }
    return null;
  };

  const updateField = (key: string, value: PromptFormValue) => {
    setValues(key, value);
    if (submitted) setErrors(key, validateField(key, value) ?? undefined);
  };

  const validateAll = (): boolean => {
    submitted = true;
    let valid = true;
    for (const [key, field] of Object.entries(schema)) {
      if (field.type === "info") continue;
      const error = validateField(key, values[key]);
      setErrors(key, error ?? undefined);
      if (error) valid = false;
    }
    return valid;
  };

  const reset = () => {
    submitted = false;
    for (const [key, field] of Object.entries(schema)) {
      if (field.type === "info") continue;
      setValues(key, "default" in field ? (field.default as PromptFormValue) : undefined);
      setErrors(key, undefined);
    }
  };

  return { values, errors, updateField, validateAll, reset };
};
