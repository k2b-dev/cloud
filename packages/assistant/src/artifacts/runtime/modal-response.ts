import { z } from "zod";
import type { ModalField, ModalRequest } from "./modal-schema";

function fieldValue(field: z.infer<typeof ModalField>, value: unknown) {
  if (value === undefined || value === null || value === "") {
    if (field.required) throw new Error(`${field.label}: a value is required`);
    return field.type === "text" ? "" : null;
  }
  if (field.type === "boolean") return z.boolean().parse(value);
  if (field.type === "number") {
    let schema = z.number().finite();
    if (field.min !== undefined) schema = schema.min(field.min);
    if (field.max !== undefined) schema = schema.max(field.max);
    return schema.parse(value);
  }
  if (field.type === "select") {
    const selected = z.string().parse(value);
    if (!field.options.some((option) => option.value === selected)) throw new Error(`${field.label}: unknown option`);
    return selected;
  }
  let schema = z.string();
  if (field.minLength !== undefined) schema = schema.min(field.minLength);
  if (field.maxLength !== undefined) schema = schema.max(field.maxLength);
  const text = schema.parse(value);
  if (field.required && !text.trim()) throw new Error(`${field.label}: a value is required`);
  return text;
}

/** Shared by interactive and agent-controlled dialogs. Always returns cloneable data. */
export function validateModalResponse(request: ModalRequest, value: unknown): unknown {
  if (request.kind === "confirm") return z.boolean().parse(value);
  if (value === null) return null;
  if (request.kind === "dialog") {
    const input = z.record(z.string(), z.unknown()).parse(value);
    if (Object.keys(input).some((key) => !(key in request.fields))) throw new Error("Unknown dialog field");
    return Object.fromEntries(Object.entries(request.fields).map(([key, field]) => [key, fieldValue(field, input[key])]));
  }
  return fieldValue({ ...request, type: request.kind }, value);
}
