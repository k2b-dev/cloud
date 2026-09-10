import { prompts, type FieldSchema } from "@k2b/ui";
import { z } from "zod";
import { ModalField, ModalRequest } from "../runtime/modal-schema";
import { messages } from "./messages";

type Field = z.infer<typeof ModalField>;
function convert(field: Field, t: ReturnType<typeof messages.resolve>["t"]): FieldSchema {
  if (field.type === "select")
    return {
      ...field,
      options: field.options.map(({ value, ...option }) => ({ ...option, id: value })),
      validate: (value: string | undefined) => (value && !field.options.some((option) => option.value === value) ? t.modalInvalid : null),
    };
  if (field.type === "number")
    return {
      ...field,
      validate: (value: number | undefined) =>
        value !== undefined &&
        (!Number.isFinite(value) || (field.min !== undefined && value < field.min) || (field.max !== undefined && value > field.max))
          ? t.modalNumberRange
          : null,
    };
  if (field.type === "text")
    return {
      ...field,
      validate: (value: string | undefined) => {
        if (field.required && !value?.trim()) return t.modalRequired;
        if (
          value &&
          ((field.minLength !== undefined && value.length < field.minLength) ||
            (field.maxLength !== undefined && value.length > field.maxLength))
        )
          return t.modalTextLength;
        return null;
      },
    };
  return field;
}
export async function openKitModal(input: unknown, signal: AbortSignal, locale: string) {
  const request = ModalRequest.parse(input);
  const { kind, ...options } = request;
  const t = messages.resolve([locale]).t;
  if (request.kind === "confirm") return (await prompts.confirm(request.message, { ...options, signal })) ?? false;
  if (request.kind === "dialog") {
    const fields = Object.fromEntries(Object.entries(request.fields).map(([name, field]) => [name, convert(field, t)]));
    const result = await prompts.form({ ...options, fields, signal });
    // Kit fields contain scalar values; detach the Solid store before worker RPC.
    return result === null ? null : Object.fromEntries(Object.entries(result));
  }
  const field: Field =
    request.kind === "text"
      ? {
          type: "text",
          label: request.label,
          default: request.value,
          required: request.required,
          minLength: request.minLength,
          maxLength: request.maxLength,
          multiline: request.multiline,
        }
      : { type: "number", label: request.label, default: request.value, required: request.required, min: request.min, max: request.max };
  const result = await prompts.form({ ...options, fields: { value: convert(field, t) }, signal });
  return result?.value ?? null;
}
