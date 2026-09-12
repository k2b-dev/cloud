/**
 * AST node types for the grids formula engine. Phase-5 scope: display
 * formulas only — no relation aggregates, no filter/sort by formula.
 */

export type Literal = number | string | boolean | null;

export type SourceSpan = { start: number; end: number };

export type Expr =
  | { kind: "literal"; value: Literal; numericSource?: string; parameterTypeOnly?: true; span?: SourceSpan }
  | { kind: "field"; fieldId: string; span?: SourceSpan }
  | { kind: "binop"; op: BinOp; left: Expr; right: Expr; span?: SourceSpan }
  | { kind: "unop"; op: UnOp; operand: Expr; span?: SourceSpan }
  | { kind: "call"; fn: string; args: Expr[]; span?: SourceSpan };

export type BinOp = "+" | "-" | "*" | "/" | "%" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "&&" | "||";

type UnOp = "-" | "!";

/** Sentinel for runtime errors (division by zero, etc). Renderable as "#ERROR". */
const FORMULA_ERROR = Symbol.for("grids.formula.error");
type FormulaError = { [FORMULA_ERROR]: true; code: string };

export const formulaError = (code: string): FormulaError => ({ [FORMULA_ERROR]: true, code });

export const isFormulaError = (v: unknown): v is FormulaError =>
  typeof v === "object" && v !== null && (v as { [k: symbol]: unknown })[FORMULA_ERROR] === true;
