import { numberHandler } from "../field-types/number";

/** Keep exact decimal input as text and use the ordinary number field's range. */
export const parseWorkflowDecimalInput = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const parsed = numberHandler.validate(value, {}, true);
  return parsed.ok && typeof parsed.value === "string" ? parsed.value : null;
};
