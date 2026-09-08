export type FormulaValueType = "any" | "number" | "text" | "boolean" | "date";

type FormulaArg = {
  label: string;
  type: FormulaValueType;
};

export type FormulaFunction = {
  name: string;
  signature: string;
  description: string;
  args: readonly FormulaArg[];
  returnType: FormulaValueType;
  variadic?: true;
  optionalArgs?: number;
};

type FormulaFunctionArity = { min: number; max: number };

export const formulaFunctionArity = (fn: FormulaFunction): FormulaFunctionArity => ({
  min: fn.args.length - (fn.optionalArgs ?? 0),
  max: fn.variadic ? Number.POSITIVE_INFINITY : fn.args.length,
});

const FORMULA_FUNCTION_DEFINITIONS = [
  {
    name: "SUM",
    signature: "SUM(value, ...)",
    description: "Add numeric values.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "AVG",
    signature: "AVG(value, ...)",
    description: "Average numeric values.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "MEAN",
    signature: "MEAN(value, ...)",
    description: "Alias for AVG.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "COUNT",
    signature: "COUNT(value, ...)",
    description: "Count non-empty values.",
    args: [{ label: "value", type: "any" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "MIN",
    signature: "MIN(value, ...)",
    description: "Smallest numeric value.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "MAX",
    signature: "MAX(value, ...)",
    description: "Largest numeric value.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "MEDIAN",
    signature: "MEDIAN(value, ...)",
    description: "Middle numeric value.",
    args: [{ label: "value", type: "number" }],
    returnType: "number",
    variadic: true,
  },
  {
    name: "ABS",
    signature: "ABS(number)",
    description: "Absolute value.",
    args: [{ label: "number", type: "number" }],
    returnType: "number",
  },
  {
    name: "ROUND",
    signature: "ROUND(number, digits?)",
    description: "Round a number.",
    args: [
      { label: "number", type: "number" },
      { label: "digits", type: "number" },
    ],
    returnType: "number",
    optionalArgs: 1,
  },
  {
    name: "FLOOR",
    signature: "FLOOR(number)",
    description: "Round down.",
    args: [{ label: "number", type: "number" }],
    returnType: "number",
  },
  { name: "CEIL", signature: "CEIL(number)", description: "Round up.", args: [{ label: "number", type: "number" }], returnType: "number" },
  {
    name: "SQRT",
    signature: "SQRT(number)",
    description: "Square root.",
    args: [{ label: "number", type: "number" }],
    returnType: "number",
  },
  {
    name: "POW",
    signature: "POW(base, exponent)",
    description: "Power.",
    args: [
      { label: "base", type: "number" },
      { label: "exponent", type: "number" },
    ],
    returnType: "number",
  },
  {
    name: "MOD",
    signature: "MOD(a, b)",
    description: "Remainder.",
    args: [
      { label: "a", type: "number" },
      { label: "b", type: "number" },
    ],
    returnType: "number",
  },
  {
    name: "PERCENT",
    signature: "PERCENT(part, total)",
    description: "Part as percent of total.",
    args: [
      { label: "part", type: "number" },
      { label: "total", type: "number" },
    ],
    returnType: "number",
  },
  {
    name: "IF",
    signature: "IF(condition, then, else)",
    description: "Choose by condition.",
    args: [
      { label: "condition", type: "any" },
      { label: "then", type: "any" },
      { label: "else", type: "any" },
    ],
    returnType: "any",
  },
  {
    name: "IFEMPTY",
    signature: "IFEMPTY(value, fallback)",
    description: "Fallback for empty values.",
    args: [
      { label: "value", type: "any" },
      { label: "fallback", type: "any" },
    ],
    returnType: "any",
  },
  {
    name: "IFERROR",
    signature: "IFERROR(value, fallback)",
    description: "Fallback for formula errors.",
    args: [
      { label: "value", type: "any" },
      { label: "fallback", type: "any" },
    ],
    returnType: "any",
  },
  {
    name: "AND",
    signature: "AND(value, ...)",
    description: "All values are truthy. In GQL where/having, prefer the `and` operator.",
    args: [{ label: "value", type: "any" }],
    returnType: "boolean",
    variadic: true,
  },
  {
    name: "OR",
    signature: "OR(value, ...)",
    description: "Any value is truthy. In GQL where/having, prefer the `or` operator.",
    args: [{ label: "value", type: "any" }],
    returnType: "boolean",
    variadic: true,
  },
  {
    name: "NOT",
    signature: "NOT(value)",
    description: "Invert truthiness. In GQL where/having, prefer the `not` operator.",
    args: [{ label: "value", type: "any" }],
    returnType: "boolean",
  },
  {
    name: "ISBLANK",
    signature: "ISBLANK(value)",
    description: "True when empty.",
    args: [{ label: "value", type: "any" }],
    returnType: "boolean",
  },
  {
    name: "CONTAINS",
    signature: "CONTAINS(text, search)",
    description: "Substring match.",
    args: [
      { label: "text", type: "text" },
      { label: "search", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "STARTSWITH",
    signature: "STARTSWITH(text, prefix)",
    description: "True when text starts with prefix.",
    args: [
      { label: "text", type: "text" },
      { label: "prefix", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "ENDSWITH",
    signature: "ENDSWITH(text, suffix)",
    description: "True when text ends with suffix.",
    args: [
      { label: "text", type: "text" },
      { label: "suffix", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "ICONTAINS",
    signature: "ICONTAINS(text, search)",
    description: "Case-insensitive substring match.",
    args: [
      { label: "text", type: "text" },
      { label: "search", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "ISTARTSWITH",
    signature: "ISTARTSWITH(text, prefix)",
    description: "Case-insensitive starts-with match.",
    args: [
      { label: "text", type: "text" },
      { label: "prefix", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "IENDSWITH",
    signature: "IENDSWITH(text, suffix)",
    description: "Case-insensitive ends-with match.",
    args: [
      { label: "text", type: "text" },
      { label: "suffix", type: "text" },
    ],
    returnType: "boolean",
  },
  {
    name: "CONCAT",
    signature: "CONCAT(value, ...)",
    description: "Join values as text.",
    args: [{ label: "value", type: "any" }],
    returnType: "text",
    variadic: true,
  },
  { name: "LEN", signature: "LEN(text)", description: "Text length.", args: [{ label: "text", type: "text" }], returnType: "number" },
  { name: "LOWER", signature: "LOWER(text)", description: "Lowercase text.", args: [{ label: "text", type: "text" }], returnType: "text" },
  { name: "UPPER", signature: "UPPER(text)", description: "Uppercase text.", args: [{ label: "text", type: "text" }], returnType: "text" },
  { name: "TRIM", signature: "TRIM(text)", description: "Trim whitespace.", args: [{ label: "text", type: "text" }], returnType: "text" },
  {
    name: "LEFT",
    signature: "LEFT(text, n)",
    description: "First n characters.",
    args: [
      { label: "text", type: "text" },
      { label: "n", type: "number" },
    ],
    returnType: "text",
  },
  {
    name: "RIGHT",
    signature: "RIGHT(text, n)",
    description: "Last n characters.",
    args: [
      { label: "text", type: "text" },
      { label: "n", type: "number" },
    ],
    returnType: "text",
  },
  {
    name: "SUBSTRING",
    signature: "SUBSTRING(text, start, length)",
    description: "Text slice with 0-based start.",
    args: [
      { label: "text", type: "text" },
      { label: "start", type: "number" },
      { label: "length", type: "number" },
    ],
    returnType: "text",
  },
  {
    name: "REPLACE",
    signature: "REPLACE(text, search, replacement)",
    description: "Replace all matches.",
    args: [
      { label: "text", type: "text" },
      { label: "search", type: "text" },
      { label: "replacement", type: "text" },
    ],
    returnType: "text",
  },
  { name: "TODAY", signature: "TODAY()", description: "Current date.", args: [], returnType: "date" },
  { name: "NOW", signature: "NOW()", description: "Current date and time.", args: [], returnType: "date" },
  { name: "YEAR", signature: "YEAR(date)", description: "Year number.", args: [{ label: "date", type: "date" }], returnType: "number" },
  { name: "MONTH", signature: "MONTH(date)", description: "Month number.", args: [{ label: "date", type: "date" }], returnType: "number" },
  { name: "DAY", signature: "DAY(date)", description: "Day number.", args: [{ label: "date", type: "date" }], returnType: "number" },
  {
    name: "DATEADD",
    signature: "DATEADD(date, count, unit?)",
    description: "Add time to a date; the unit defaults to days.",
    args: [
      { label: "date", type: "date" },
      { label: "count", type: "number" },
      { label: "unit", type: "text" },
    ],
    returnType: "date",
    optionalArgs: 1,
  },
  {
    name: "DATEDIFF",
    signature: "DATEDIFF(from, to, unit?)",
    description: "Difference between dates; the unit defaults to days.",
    args: [
      { label: "from", type: "date" },
      { label: "to", type: "date" },
      { label: "unit", type: "text" },
    ],
    returnType: "number",
    optionalArgs: 1,
  },
] as const satisfies readonly FormulaFunction[];

export type FormulaFunctionName = (typeof FORMULA_FUNCTION_DEFINITIONS)[number]["name"];
export const GRID_FORMULA_FUNCTIONS: readonly FormulaFunction[] = FORMULA_FUNCTION_DEFINITIONS;
const FORMULA_FUNCTION_BY_NAME: ReadonlyMap<string, FormulaFunction> = new Map(GRID_FORMULA_FUNCTIONS.map((fn) => [fn.name, fn]));

export const formulaFunctionForName = (name: string): FormulaFunction | undefined => FORMULA_FUNCTION_BY_NAME.get(name.toUpperCase());
