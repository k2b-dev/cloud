import { normalizeRefKey } from "../ref-syntax";
import { parseFormula } from "./parser";
import { formulaSelectText } from "./select-messages";
import type { Expr } from "./types";

export type FormulaSelect = { name: string; config: { multiple?: boolean; options?: Array<{ id: string; label?: string }> } };
type Bound = { ok: true; ast: Expr } | { ok: false; error: string };

/** Resolve labels at authoring time; evaluation always compares exact stored IDs. */
export const resolveFormulaOption = (
  field: FormulaSelect,
  value: string,
  locale?: string,
): { ok: true; id: string } | { ok: false; error: string } => {
  const options = field.config.options ?? [];
  const exact = options.find((option) => option.id === value);
  if (exact) return { ok: true, id: exact.id };
  const matches = value.trim() ? options.filter((option) => normalizeRefKey(option.label ?? "") === normalizeRefKey(value)) : [];
  if (matches.length === 1) return { ok: true, id: matches[0]!.id };
  const text = formulaSelectText(locale);
  return {
    ok: false,
    error: matches.length
      ? text.ambiguous({ value, field: field.name })
      : text.unknown({ value, field: field.name, options: options.map((option) => option.label || option.id).join(", ") }),
  };
};

/** Persist IDs without reformatting the author's expression or replacing unrelated literals. */
export const canonicalizeFormulaOptions = (
  source: string,
  resolve: (ref: string) => FormulaSelect | undefined,
  locale?: string,
): { ok: true; source: string } | { ok: false; error: string } => {
  if (!source.trim()) return { ok: true, source };
  const parsed = parseFormula(source);
  if (!parsed.ok) return parsed;
  const bound = bindFormulaSelects(parsed.ast, resolve, locale);
  if (!bound.ok) return bound;
  const replacements = new Map<number, { end: number; value: string }>();
  const visit = (node: Expr): void => {
    if (node.kind === "call") {
      if (node.fn === "HAS_OPTION") {
        const option = node.args[1];
        if (option?.kind === "literal" && typeof option.value === "string" && option.span) {
          replacements.set(option.span.start, {
            end: option.span.end,
            value: `'${option.value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`,
          });
        }
      }
      node.args.forEach(visit);
    } else if (node.kind === "binop") {
      visit(node.left);
      visit(node.right);
    } else if (node.kind === "unop") visit(node.operand);
  };
  visit(bound.ast);
  for (const [start, replacement] of [...replacements].sort(([a], [b]) => b - a))
    source = source.slice(0, start) + replacement.value + source.slice(replacement.end);
  return { ok: true, source };
};

export const bindFormulaSelects = (ast: Expr, resolve: (ref: string) => FormulaSelect | undefined, locale?: string): Bound => {
  const text = formulaSelectText(locale);
  const selected = (node: Expr): FormulaSelect | undefined => (node.kind === "field" ? resolve(node.fieldId) : undefined);
  const membership = (field: Expr, option: Expr, config: FormulaSelect): Bound => {
    if (option.kind !== "literal" || typeof option.value !== "string") return { ok: false, error: text.literal({ field: config.name }) };
    const resolved = resolveFormulaOption(config, option.value, locale);
    return resolved.ok
      ? { ok: true, ast: { kind: "call", fn: "HAS_OPTION", args: [field, { ...option, span: option.span, value: resolved.id }] } }
      : resolved;
  };
  if (ast.kind === "binop") {
    const left = selected(ast.left);
    const right = selected(ast.right);
    if (left || right) {
      const config = left ?? right!;
      if (ast.op !== "=" && ast.op !== "!=") return { ok: false, error: text.comparison({ field: config.name }) };
      const field = left ? ast.left : ast.right;
      const value = left ? ast.right : ast.left;
      const empty = value.kind === "literal" && value.value === null;
      if (config.config.multiple && !empty) return { ok: false, error: text.multiple({ field: config.name }) };
      const result: Bound = empty ? { ok: true, ast: { kind: "call", fn: "ISBLANK", args: [field] } } : membership(field, value, config);
      return result.ok && ast.op === "!=" ? { ok: true, ast: { kind: "unop", op: "!", operand: result.ast } } : result;
    }
    const a = bindFormulaSelects(ast.left, resolve, locale);
    if (!a.ok) return a;
    const b = bindFormulaSelects(ast.right, resolve, locale);
    return b.ok ? { ok: true, ast: { ...ast, left: a.ast, right: b.ast } } : b;
  }
  if (ast.kind === "call") {
    const config = ast.args[0] && selected(ast.args[0]);
    if (config && ast.fn === "HAS_OPTION" && ast.args.length === 2) return membership(ast.args[0]!, ast.args[1]!, config);
    if (config && ast.fn === "ISBLANK" && ast.args.length === 1) return { ok: true, ast };
    if (ast.fn === "HAS_OPTION") return { ok: false, error: text.membership };
    const args: Expr[] = [];
    for (const arg of ast.args) {
      const bound = bindFormulaSelects(arg, resolve, locale);
      if (!bound.ok) return bound;
      args.push(bound.ast);
    }
    return { ok: true, ast: { ...ast, args } };
  }
  if (ast.kind === "unop") {
    const operand = bindFormulaSelects(ast.operand, resolve, locale);
    return operand.ok ? { ok: true, ast: { ...ast, operand: operand.ast } } : operand;
  }
  const config = selected(ast);
  return config ? { ok: false, error: text.coercion({ field: config.name }) } : { ok: true, ast };
};
