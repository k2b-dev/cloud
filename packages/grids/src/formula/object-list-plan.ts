import { normalizeRefKey } from "../ref-syntax";
import { formulaFunctionArity, formulaFunctionForName, isListFormulaFunction } from "./function-catalog";
import { collectFieldRefs, parseFormula } from "./parser";
import type { Expr } from "./types";

type Column = { id: string; name: string; formula?: { expression?: string } };
export type ObjectListCalculationPlan = { steps: Array<{ id: string; ast: Expr }>; references: Record<string, string> };
type PlanResult = { ok: true; plan: ObjectListCalculationPlan } | { ok: false; columnId: string; error: string };

const functionError = (ast: Expr): string | null => {
  if (ast.kind === "call") {
    if (isListFormulaFunction(ast.fn)) return "List reductions require a record-level formula; nested lists are not supported";
    const spec = formulaFunctionForName(ast.fn);
    if (!spec) return `Unknown function ${ast.fn}`;
    const arity = formulaFunctionArity(spec);
    if (ast.args.length < arity.min || ast.args.length > arity.max) return `Invalid arguments for ${ast.fn}`;
    for (const argument of ast.args) {
      const error = functionError(argument);
      if (error) return error;
    }
  } else if (ast.kind === "binop") return functionError(ast.left) ?? functionError(ast.right);
  else if (ast.kind === "unop") return functionError(ast.operand);
  return null;
};

/** The existing formula language, scoped to one list row; no record identities or lookups. */
export const planObjectListCalculations = (columns: readonly Column[]): PlanResult => {
  const references: Record<string, string> = {};
  for (const column of columns) {
    for (const value of [column.id, column.name]) {
      const key = normalizeRefKey(value);
      if (Object.hasOwn(references, key) && references[key] !== column.id)
        return { ok: false, columnId: column.id, error: `Ambiguous field reference ${value}` };
      Object.defineProperty(references, key, { value: column.id, enumerable: true, configurable: true });
    }
  }
  const expressions = new Map<string, Expr>();
  const dependencies = new Map<string, string[]>();
  for (const column of columns) {
    if (!column.formula) continue;
    const parsed = parseFormula(column.formula.expression ?? "");
    if (!parsed.ok) return { ok: false, columnId: column.id, error: parsed.error };
    const error = functionError(parsed.ast);
    if (error) return { ok: false, columnId: column.id, error };
    const refs: string[] = [];
    for (const ref of collectFieldRefs(parsed.ast)) {
      const key = normalizeRefKey(ref);
      if (!Object.hasOwn(references, key)) return { ok: false, columnId: column.id, error: `Unknown list column ${ref}` };
      refs.push(references[key]!);
    }
    expressions.set(column.id, parsed.ast);
    dependencies.set(column.id, refs);
  }
  const steps: ObjectListCalculationPlan["steps"] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visited.has(id) || !expressions.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    steps.push({ id, ast: expressions.get(id)! });
    return true;
  };
  for (const id of expressions.keys()) if (!visit(id)) return { ok: false, columnId: id, error: "Circular list formula dependency" };
  return { ok: true, plan: { steps, references } };
};
