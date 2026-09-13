import { normalizeRefKey } from "../ref-syntax";
import type { Expr } from "./types";

export type FormulaSelect = { name: string; config: { multiple?: boolean; options?: Array<{ id: string; label?: string }> } };
type Bound = { ok: true; ast: Expr } | { ok: false; error: string };

/** Resolve labels at authoring time; evaluation always compares exact stored IDs. */
export const resolveFormulaOption = (field: FormulaSelect, value: string): { ok: true; id: string } | { ok: false; error: string } => {
  const options = field.config.options ?? [];
  const exact = options.find((option) => option.id === value);
  if (exact) return { ok: true, id: exact.id };
  const matches = options.filter((option) => normalizeRefKey(option.label ?? "") === normalizeRefKey(value));
  if (matches.length === 1) return { ok: true, id: matches[0]!.id };
  return { ok: false, error: `${matches.length ? "Ambiguous" : "Unknown"} option "${value}" in "${field.name}"` };
};

export const bindFormulaSelects = (ast: Expr, resolve: (ref: string) => FormulaSelect | undefined): Bound => {
  const selected = (node: Expr): FormulaSelect | undefined => (node.kind === "field" ? resolve(node.fieldId) : undefined);
  const membership = (field: Expr, option: Expr, config: FormulaSelect): Bound => {
    if (option.kind !== "literal" || typeof option.value !== "string")
      return { ok: false, error: `Select "${config.name}" needs a literal option ID or label` };
    const resolved = resolveFormulaOption(config, option.value);
    return resolved.ok ? { ok: true, ast: { kind: "call", fn: "HAS_OPTION", args: [field, { ...option, value: resolved.id }] } } : resolved;
  };
  if (ast.kind === "binop") {
    const left = selected(ast.left);
    const right = selected(ast.right);
    if (left || right) {
      const config = left ?? right!;
      if (ast.op !== "=" && ast.op !== "!=") return { ok: false, error: `Select "${config.name}" only supports =, != or HAS_OPTION` };
      const field = left ? ast.left : ast.right;
      const value = left ? ast.right : ast.left;
      const empty = value.kind === "literal" && value.value === null;
      if (config.config.multiple && !empty) return { ok: false, error: `Use HAS_OPTION for multiple-select "${config.name}"` };
      const result: Bound = empty ? { ok: true, ast: { kind: "call", fn: "ISBLANK", args: [field] } } : membership(field, value, config);
      return result.ok && ast.op === "!=" ? { ok: true, ast: { kind: "unop", op: "!", operand: result.ast } } : result;
    }
    const a = bindFormulaSelects(ast.left, resolve);
    if (!a.ok) return a;
    const b = bindFormulaSelects(ast.right, resolve);
    return b.ok ? { ok: true, ast: { ...ast, left: a.ast, right: b.ast } } : b;
  }
  if (ast.kind === "call") {
    const config = ast.args[0] && selected(ast.args[0]);
    if (config && ast.fn === "HAS_OPTION" && ast.args.length === 2) return membership(ast.args[0]!, ast.args[1]!, config);
    if (config && ast.fn === "ISBLANK" && ast.args.length === 1) return { ok: true, ast };
    if (ast.fn === "HAS_OPTION") return { ok: false, error: "HAS_OPTION needs a Select field and a literal option ID or label" };
    const args: Expr[] = [];
    for (const arg of ast.args) {
      const bound = bindFormulaSelects(arg, resolve);
      if (!bound.ok) return bound;
      args.push(bound.ast);
    }
    return { ok: true, ast: { ...ast, args } };
  }
  if (ast.kind === "unop") {
    const operand = bindFormulaSelects(ast.operand, resolve);
    return operand.ok ? { ok: true, ast: { ...ast, operand: operand.ast } } : operand;
  }
  const config = selected(ast);
  return config
    ? { ok: false, error: `Use =, !=, ISBLANK or HAS_OPTION for Select "${config.name}"; text functions are not membership tests` }
    : { ok: true, ast };
};
