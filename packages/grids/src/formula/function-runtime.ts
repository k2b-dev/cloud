import type { DateContext } from "@k2b/stdlib";
import { isNullish, toNumber } from "./numeric";
import type { formulaError, Literal } from "./types";

export type FormulaFunctionReturn = Literal | ReturnType<typeof formulaError>;
export type FormulaRuntimeContext = { dateConfig?: DateContext; now?: Date; maxStringLength?: number };
export type FormulaFunction = (args: unknown[], context: FormulaRuntimeContext) => FormulaFunctionReturn;

export const formulaNumber = (value: unknown): number | null => toNumber(value);

export const formulaString = (value: unknown): string => {
  if (isNullish(value)) return "";
  return typeof value === "string" ? value : String(value);
};

export const formulaBoolean = (value: unknown): boolean => {
  if (isNullish(value)) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.length > 0;
  return Boolean(value);
};
