import { createHash } from "node:crypto";
import { sql } from "bun";
import { ObjectListConfigSchema } from "../field-types/object-list";
import { formulaFunctionForName } from "../formula/function-catalog";
import { collectFieldRefs, parseFormula } from "../formula/parser";
import { bindFormulaSelects } from "../formula/select-binding";
import type { Expr } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import { scalarSqlTypeForField, storageOf } from "./field-storage";
import { compileFormulaAstToSql, type FormulaSqlExpression, type FormulaSqlType } from "./formula-sql-compiler";
import type { Field } from "./types";

export type LocalCalculationStep = { field: Field; ast: Expr; type: FormulaSqlType };
export type LocalCalculationPlan = {
  /** Changes only when the calculation contract changes, not when records or UI layout change. */
  signature: string;
  formulaIds: ReadonlySet<string>;
  objectListIds: ReadonlySet<string>;
  types: Readonly<Record<string, FormulaSqlType>>;
  /** Dependencies precede their consumers. Evaluate with the authoritative SQL compiler. */
  steps: readonly LocalCalculationStep[];
  objectLists: readonly Field[];
};

// Date functions depend on the request's clock/time zone. Keeping their dependents
// live also avoids silently pinning a user's date preferences in persisted values.
// Bump when persisted SQL calculation semantics change; startup refreshes old drafts.
const STORAGE_VERSION = 1;
const CONTEXT_FUNCTIONS = new Set(["NOW", "TODAY", "YEAR", "MONTH", "DAY", "DATEADD", "DATEDIFF"]);
const COMPARISONS = new Set(["=", "!=", "<", "<=", ">", ">="]);

const fieldReferences = (fields: readonly Field[]): Map<string, Field | null> => {
  const references = new Map<string, Field | null>();
  for (const field of fields) {
    for (const ref of [field.shortId, field.name]) {
      const key = normalizeRefKey(ref);
      const existing = references.get(key);
      references.set(key, existing === undefined || existing?.id === field.id ? field : null);
    }
  }
  return references;
};

const scalarIsLocal = (field: Field): boolean => {
  const kind = storageOf(field).kind;
  return kind === "text" || kind === "numeric" || kind === "boolean" || kind === "date" || field.type === "select";
};

const placeholder = (type: FormulaSqlType): FormulaSqlExpression => ({ type, sql: sql`NULL` });

/** Validate with the same compiler used at read/write time; do not duplicate its type rules. */
const expressionIsLocal = (ast: Expr, fields: Field[], computedFieldSql: Map<string, FormulaSqlExpression>): boolean => {
  const types = new Map<Expr, FormulaSqlType | null>();
  const typeOf = (node: Expr): FormulaSqlType | null => {
    if (types.has(node)) return types.get(node)!;
    const compiled = compileFormulaAstToSql(node, { fields, computedFieldSql, useFinalizedFormulaValues: false });
    const type = compiled.ok ? compiled.expression.type : null;
    types.set(node, type);
    return type;
  };
  const temporal = (type: FormulaSqlType | null) => type === "text" || type === "date" || type === "datetime";
  const visit = (node: Expr): boolean => {
    if (node.kind === "call") {
      if (!formulaFunctionForName(node.fn) || CONTEXT_FUNCTIONS.has(node.fn)) return false;
      return node.args.every(visit);
    }
    if (node.kind === "unop") return visit(node.operand);
    if (node.kind !== "binop") return true;
    // Text comparisons can recognize ISO timestamps at runtime. Two temporal
    // operands may therefore change meaning with the reader's time zone.
    if (COMPARISONS.has(node.op) && temporal(typeOf(node.left)) && temporal(typeOf(node.right))) return false;
    return visit(node.left) && visit(node.right);
  };
  return visit(ast) && typeOf(ast) !== null;
};

const stable = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
};

/** Only validation/interpretation settings belong in a calculation signature. */
const scalarConfig = (type: string, config: Record<string, unknown>): unknown => {
  const keys =
    type === "number"
      ? ["min", "max", "precision", "decimalPlaces", "integerOnly"]
      : type === "text" || type === "longtext"
        ? ["minLength", "maxLength", "regex", "multiline"]
        : type === "date"
          ? ["includeTime", "min", "max"]
          : type === "percent"
            ? ["range", "decimals"]
            : type === "select"
              ? ["multiple", "minSelected", "maxSelected"]
              : [];
  const selected = Object.fromEntries(keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]));
  return type === "select" && Array.isArray(config.options)
    ? { ...selected, options: config.options.map((option: { id: string; label: string }) => ({ id: option.id, label: option.label })) }
    : selected;
};

const astSignature = (ast: Expr, references: Map<string, Field | null>): unknown => {
  if (ast.kind === "literal") return { kind: ast.kind, value: ast.value, numericSource: ast.numericSource };
  if (ast.kind === "field") return { kind: ast.kind, id: references.get(normalizeRefKey(ast.fieldId))!.id };
  if (ast.kind === "unop") return { kind: ast.kind, op: ast.op, operand: astSignature(ast.operand, references) };
  if (ast.kind === "binop")
    return { kind: ast.kind, op: ast.op, left: astSignature(ast.left, references), right: astSignature(ast.right, references) };
  return { kind: ast.kind, fn: ast.fn, args: ast.args.map((arg) => astSignature(arg, references)) };
};

/**
 * Automatic, transitive materialization eligibility for one stored record.
 * Relations, principals, system columns and request-dependent expressions stay live.
 * Generated ID fields are ordinary stored data and are eligible after ID allocation.
 * The caller excludes virtual/Combined tables; they do not own persisted records.
 */
export const planLocalCalculations = (inputFields: Field[]): LocalCalculationPlan => {
  const fields = inputFields.filter((field) => !field.deletedAt);
  const references = fieldReferences(fields);
  const computed = new Map<string, FormulaSqlExpression>();
  const types: Record<string, FormulaSqlType> = {};
  const objectLists: Field[] = [];
  const signatures = new Map<string, unknown>();

  for (const field of fields) {
    if (field.type !== "object_list") continue;
    const parsed = ObjectListConfigSchema.safeParse(field.config);
    if (!parsed.success) continue;
    const columns: Field[] = parsed.data.fields.map((column) => ({
      ...field,
      id: column.id,
      shortId: column.id,
      name: column.name,
      type: column.type,
      config: column.config,
    }));
    const columnRefs = fieldReferences(columns);
    const formulas = new Map<string, Expr>();
    let local = true;
    for (const column of parsed.data.fields) {
      if (!column.formula) continue;
      const expression = parseFormula(column.formula.expression ?? "");
      if (!expression.ok) {
        local = false;
        break;
      }
      const bound = bindFormulaSelects(expression.ast, (ref) => {
        const target = columnRefs.get(normalizeRefKey(ref));
        return target?.type === "select" ? target : undefined;
      });
      if (!bound.ok || !expressionIsLocal(bound.ast, columns, new Map())) {
        local = false;
        break;
      }
      formulas.set(column.id, bound.ast);
    }
    if (!local) continue;
    objectLists.push(field);
    types[field.id] = "json";
    computed.set(field.id, placeholder("json"));
    signatures.set(field.id, {
      id: field.id,
      type: field.type,
      required: field.required,
      minItems: parsed.data.minItems,
      maxItems: parsed.data.maxItems,
      fields: parsed.data.fields
        .map((column) => ({
          id: column.id,
          // LIST_SUM and its siblings accept column names, so renames/rebinding
          // can change record formulas even when the list's own values do not.
          name: column.name,
          type: column.type,
          required: column.required,
          config: scalarConfig(column.type, column.config),
          formula: formulas.has(column.id) ? astSignature(formulas.get(column.id)!, columnRefs) : undefined,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  const steps: LocalCalculationStep[] = [];
  const resolved = new Map<string, boolean>();
  const visiting = new Set<string>();
  const visit = (field: Field): boolean => {
    if (field.type === "object_list") return computed.has(field.id);
    if (field.type !== "formula") return scalarIsLocal(field);
    if (resolved.has(field.id)) return resolved.get(field.id)!;
    if (visiting.has(field.id)) return false;
    visiting.add(field.id);
    const prepare = (): boolean => {
      const source = field.config.expression;
      if (typeof source !== "string" || !source.trim()) return false;
      const parsed = parseFormula(source);
      if (!parsed.ok) return false;
      const dependencies: Field[] = [];
      for (const ref of collectFieldRefs(parsed.ast)) {
        const dependency = references.get(normalizeRefKey(ref));
        if (!dependency || !visit(dependency)) return false;
        dependencies.push(dependency);
      }
      const bound = bindFormulaSelects(parsed.ast, (ref) => {
        const target = references.get(normalizeRefKey(ref));
        return target?.type === "select" ? target : undefined;
      });
      if (!bound.ok || !expressionIsLocal(bound.ast, fields, computed)) return false;
      const compiled = compileFormulaAstToSql(bound.ast, { fields, computedFieldSql: computed, useFinalizedFormulaValues: false });
      if (!compiled.ok) return false;
      const type = compiled.expression.type;
      types[field.id] = type;
      computed.set(field.id, placeholder(type));
      steps.push({ field, ast: bound.ast, type });
      signatures.set(field.id, {
        id: field.id,
        type,
        ast: astSignature(bound.ast, references),
        inputs: dependencies
          .map((dependency) => ({
            id: dependency.id,
            type: dependency.type,
            scalarType: scalarSqlTypeForField(dependency),
            ...(dependency.type === "select" ? { config: scalarConfig(dependency.type, dependency.config) } : {}),
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      });
      return true;
    };
    const local = prepare();
    visiting.delete(field.id);
    resolved.set(field.id, local);
    return local;
  };
  for (const field of fields) if (field.type === "formula") visit(field);

  const signature = createHash("sha256")
    .update(
      JSON.stringify(
        stable({
          version: STORAGE_VERSION,
          calculations: [...signatures].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value),
        }),
      ),
    )
    .digest("hex");
  return {
    signature,
    types,
    steps,
    objectLists,
    formulaIds: new Set(steps.map((step) => step.field.id)),
    objectListIds: new Set(objectLists.map((field) => field.id)),
  };
};
