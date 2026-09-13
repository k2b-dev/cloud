import { type FormulaFunction, formulaBoolean, formulaNumber, formulaString } from "./function-runtime";
import { isNullish } from "./numeric";
import { formulaError, type Literal } from "./types";

export const TEXT_LOGIC_FORMULA_FUNCTIONS: Record<string, FormulaFunction> = {
  CONCAT: (args) => args.map(formulaString).join(""),
  LEN: ([value]) => formulaString(value).length,
  LOWER: ([value]) => formulaString(value).toLowerCase(),
  UPPER: ([value]) => formulaString(value).toUpperCase(),
  TRIM: ([value]) => formulaString(value).trim(),
  LEFT: ([value, count]) => formulaString(value).slice(0, Math.max(0, Math.floor(formulaNumber(count) ?? 0))),
  RIGHT: ([value, count]) => {
    const take = Math.max(0, Math.floor(formulaNumber(count) ?? 0));
    return take === 0 ? "" : formulaString(value).slice(-take);
  },
  SUBSTRING: ([value, start, length]) => {
    const from = Math.max(0, Math.floor(formulaNumber(start) ?? 0));
    const size = Math.max(0, Math.floor(formulaNumber(length) ?? 0));
    return formulaString(value).slice(from, from + size);
  },
  REPLACE: ([value, search, replacement]) => {
    const needle = formulaString(search);
    return needle.length === 0 ? formulaString(value) : formulaString(value).replaceAll(needle, formulaString(replacement));
  },
  IF: ([condition, then, otherwise]) => (formulaBoolean(condition) ? (then as Literal) : (otherwise as Literal)),
  IFEMPTY: ([value, fallback]) => (isNullish(value) || value === "" ? (fallback as Literal) : (value as Literal)),
  IFERROR: ([value]) => value as Literal,
  AND: (args) => args.every(formulaBoolean),
  OR: (args) => args.some(formulaBoolean),
  NOT: ([value]) => !formulaBoolean(value),
  ISBLANK: ([value]) => isNullish(value) || value === "" || (Array.isArray(value) && value.length === 0),
  HAS_OPTION: ([value, option]) =>
    isNullish(value)
      ? false
      : Array.isArray(value) && typeof option === "string"
        ? value.includes(option)
        : formulaError("HAS_OPTION_BAD_ARGS"),
  CONTAINS: ([haystack, needle]) =>
    Array.isArray(haystack)
      ? formulaError("Use HAS_OPTION for Select membership")
      : formulaString(haystack).includes(formulaString(needle)),
  STARTSWITH: ([haystack, needle]) => formulaString(haystack).startsWith(formulaString(needle)),
  ENDSWITH: ([haystack, needle]) => formulaString(haystack).endsWith(formulaString(needle)),
  ICONTAINS: ([haystack, needle]) => formulaString(haystack).toLowerCase().includes(formulaString(needle).toLowerCase()),
  ISTARTSWITH: ([haystack, needle]) => formulaString(haystack).toLowerCase().startsWith(formulaString(needle).toLowerCase()),
  IENDSWITH: ([haystack, needle]) => formulaString(haystack).toLowerCase().endsWith(formulaString(needle).toLowerCase()),
};
