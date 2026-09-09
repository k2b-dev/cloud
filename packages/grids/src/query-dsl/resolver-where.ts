import type { FilterTree, RecordFinalizationState, RecordMetaQuery, RecordMetaSortKey, RecordMetaUserKey } from "../contracts";
import type { Expr, Literal } from "../formula/types";
import { normalizeRefKey, parseQualifiedIdentifierRef } from "../ref-syntax";
import { validateFilterValue } from "../service/filter-compiler-validation";
import { compileFormulaAstToSql } from "../service/formula-sql-compiler";
import type { Field } from "../service/types";
import { type DslResolverDiagnostic, diagnostic, isResolverDiagnostic as isDiagnostic, spanForExpr } from "./resolver-diagnostics";
import { scopedFormulaResolverForScope } from "./resolver-formula-scope";
import { fieldByRef, type Scope } from "./resolver-scope";
import { isScopedFormulaFieldRef } from "./scoped-formula";
import type { DslQualifiedRef, DslQueryAst, DslSourceSpan } from "./types";

type DslFilterLeaf = { fieldId: string; op: string; value?: unknown; caseInsensitive?: boolean };

export type DslWherePredicate =
  | { kind: "and"; parts: DslWherePredicate[] }
  | { kind: "or"; parts: DslWherePredicate[] }
  | { kind: "not"; part: DslWherePredicate }
  | { kind: "filter"; leaf: DslFilterLeaf }
  | { kind: "recordMeta"; meta: RecordMetaQuery }
  | { kind: "publicRecordIds"; ids: string[] }
  | {
      kind: "publicRelationIds";
      fieldId: string;
      targetTableId: string;
      ids: string[];
      mode: "any" | "none" | "all";
    }
  /** Pre-built FilterTree (e.g. a view source's saved filter) folded in. */
  | { kind: "tree"; tree: FilterTree }
  /** Boolean SQL formula — cross-field / arithmetic / scalar-function predicate. */
  | { kind: "formula"; expression: Expr };

type WhereResolution =
  | { kind: "filter"; tree?: FilterTree; recordMeta?: RecordMetaQuery }
  | { kind: "predicate"; node: DslWherePredicate }
  | { kind: "error"; diagnostic: DslResolverDiagnostic };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_ID_RE = /^[A-Za-z0-9]{6}$/;
const COMPARISON_OPS = new Set(["=", "!=", "<", "<=", ">", ">="]);
const NUMBER_TYPES = new Set(["number", "percent", "duration"]);
const TEXT_TYPES = new Set(["text", "longtext", "id"]);
// Field types GQL can turn into a typed filter leaf. Everything else
// (json, file, formula, lookup, rollup) is rejected with a clear error
// instead of silently doing nothing.
const FILTERABLE_TYPES = new Set([...TEXT_TYPES, ...NUMBER_TYPES, "date", "boolean", "select", "relation", "principal"]);
const PREDICATE_FNS = new Set([
  "ONEOF",
  "NONEOF",
  "CONTAINS",
  "CONTAINSALL",
  "STARTSWITH",
  "ENDSWITH",
  "ICONTAINS",
  "ISTARTSWITH",
  "IENDSWITH",
]);
const REMOVED_EMPTY_PREDICATE_FNS = new Set(["ISEMPTY", "ISNOTEMPTY"]);
const REMOVED_MEMBERSHIP_PREDICATE_FNS = new Set(["ANYOF", "CONTAINSANY"]);
const RECORD_SCOPE = "record";
const RECORD_META_USER_KEYS = new Set<RecordMetaUserKey>(["createdBy", "updatedBy", "deletedBy"]);

const normalizeRecordRef = (ref: string): string => ref.replaceAll("_", "").toLowerCase();

const recordMetaUserKeyForRef = (ref: string): RecordMetaUserKey | null => {
  const parsed = parseQualifiedIdentifierRef(ref);
  if (!parsed?.scope || normalizeRefKey(parsed.scope) !== RECORD_SCOPE) return null;
  const normalized = normalizeRecordRef(parsed.ref);
  for (const key of RECORD_META_USER_KEYS) {
    if (normalizeRecordRef(key) === normalized) return key;
  }
  return null;
};

const isRecordIdRef = (ref: string): boolean => {
  const parsed = parseQualifiedIdentifierRef(ref);
  return Boolean(parsed?.scope && normalizeRefKey(parsed.scope) === RECORD_SCOPE && normalizeRecordRef(parsed.ref) === "id");
};

const isRecordFinalizationStateRef = (ref: string): boolean => {
  const parsed = parseQualifiedIdentifierRef(ref);
  return Boolean(parsed?.scope && normalizeRefKey(parsed.scope) === RECORD_SCOPE && normalizeRecordRef(parsed.ref) === "finalizationstate");
};

export const recordMetaSortKeyForRef = (ref: DslQualifiedRef): RecordMetaSortKey | null => {
  if (!ref.scope || normalizeRefKey(ref.scope) !== RECORD_SCOPE) return null;
  const normalized = normalizeRecordRef(ref.ref);
  if (normalized === "createdat") return "createdAt";
  if (normalized === "updatedat") return "updatedAt";
  if (normalized === "deletedat") return "deletedAt";
  return null;
};

export const isRecordScopedRef = (ref: DslQualifiedRef): boolean => Boolean(ref.scope && normalizeRefKey(ref.scope) === RECORD_SCOPE);

const recordIdPredicate = (values: Literal[], span?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !SHORT_ID_RE.test(value)) return diagnostic("record.id expects public record ids", span);
    ids.push(value);
  }
  if (ids.length === 0) return diagnostic("record.id needs at least one record id", span);
  return { kind: "publicRecordIds", ids: [...new Set(ids)] };
};

const publicRelationPredicate = (
  field: Field,
  ids: string[],
  mode: "any" | "none" | "all",
  span?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic => {
  const targetTableId = (field.config as { targetTableId?: unknown }).targetTableId;
  if (typeof targetTableId !== "string" || !UUID_RE.test(targetTableId)) {
    return diagnostic(`relation field "${field.name}" has no valid target table`, span);
  }
  return { kind: "publicRelationIds", fieldId: field.id, targetTableId, ids: [...new Set(ids)], mode };
};

const recordMetaPredicate = (
  key: RecordMetaUserKey,
  values: Literal[],
  span?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic => {
  const ids: string[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !UUID_RE.test(value)) return diagnostic(`record.${key} expects user ids (uuid)`, span);
    ids.push(value);
  }
  if (ids.length === 0) return diagnostic(`record.${key} needs at least one user id`, span);
  return { kind: "recordMeta", meta: { users: { [key]: [...new Set(ids)] } } };
};

const finalizationStatePredicate = (values: Literal[], span?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  const allowed = new Set<RecordFinalizationState>(["draft", "awaitingReview", "finalized"]);
  const states: RecordFinalizationState[] = [];
  for (const value of values) {
    if (typeof value !== "string" || !allowed.has(value as RecordFinalizationState)) {
      return diagnostic("record.finalizationState expects draft, awaitingReview, or finalized", span);
    }
    states.push(value as RecordFinalizationState);
  }
  if (states.length === 0) return diagnostic("record.finalizationState needs at least one state", span);
  return { kind: "recordMeta", meta: { finalizationStates: [...new Set(states)] } };
};

export const mergeRecordMeta = (...items: Array<RecordMetaQuery | null | undefined>): RecordMetaQuery | undefined => {
  const ids = new Set<string>();
  const users: NonNullable<RecordMetaQuery["users"]> = {};
  const finalizationStates = new Set<RecordFinalizationState>();
  for (const item of items) {
    for (const id of item?.ids ?? []) ids.add(id);
    for (const state of item?.finalizationStates ?? []) finalizationStates.add(state);
    for (const key of ["createdBy", "updatedBy", "deletedBy"] as const) {
      const values = item?.users?.[key] ?? [];
      if (values.length > 0) users[key] = [...new Set([...(users[key] ?? []), ...values])];
    }
  }
  return ids.size > 0 || finalizationStates.size > 0 || Object.keys(users).length > 0
    ? {
        ...(ids.size > 0 ? { ids: [...ids] } : {}),
        ...(finalizationStates.size > 0 ? { finalizationStates: [...finalizationStates] } : {}),
        ...(Object.keys(users).length > 0 ? { users } : {}),
      }
    : undefined;
};

const invertComparison = (op: string): string => {
  switch (op) {
    case "<":
      return ">";
    case "<=":
      return ">=";
    case ">":
      return "<";
    case ">=":
      return "<=";
    default:
      return op;
  }
};

const literalKind = (value: Literal): string =>
  value === null ? "null" : typeof value === "number" ? "a number" : typeof value === "boolean" ? "true/false" : "text";

const filterLeaf = (fieldId: string, op: string, value?: unknown, options: { caseInsensitive?: boolean } = {}): DslWherePredicate => ({
  kind: "filter",
  leaf: {
    fieldId,
    op,
    ...(value !== undefined ? { value } : {}),
    ...(options.caseInsensitive ? { caseInsensitive: true } : {}),
  },
});

const formulaLeaf = (expr: Expr, scope: Scope, baseSpan?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  const compiled = compileFormulaAstToSql(expr, {
    fields: scope.fields,
    computedFieldSql: scope.computedStub,
    resolveField: scopedFormulaResolverForScope(scope),
  });
  if (!compiled.ok) return diagnostic(`where: ${compiled.error}`, spanForExpr(baseSpan, expr));
  if (compiled.expression.type !== "boolean")
    return diagnostic("where condition must be a true/false expression", spanForExpr(baseSpan, expr));
  return { kind: "formula", expression: expr };
};

const unsupportedOp = (field: Field, op: string, span?: DslSourceSpan): DslResolverDiagnostic =>
  diagnostic(`operator "${op}" is not supported for ${field.type} field "${field.name}"`, span);

const emptinessLeaf = (field: Field, empty: boolean, span?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  if (!FILTERABLE_TYPES.has(field.type)) return diagnostic(`field "${field.name}" (type "${field.type}") cannot be filtered`, span);
  return filterLeaf(field.id, empty ? "isEmpty" : "isNotEmpty");
};

/** Resolve a select literal (option id or case-insensitive label) to its
 *  stored option id. Fields without configured options accept the raw value
 *  (forward-compatible for templated/empty configs). */
const resolveSelectOption = (field: Field, raw: string, span?: DslSourceSpan): string | DslResolverDiagnostic => {
  const options = (field.config as { options?: Array<{ id: string; label?: string }> }).options;
  if (!options || options.length === 0) return raw;
  const byId = options.find((option) => option.id === raw);
  if (byId) return byId.id;
  const key = normalizeRefKey(raw);
  const byLabel = options.filter((option) => normalizeRefKey(option.label ?? "") === key);
  if (byLabel.length === 1) return byLabel[0]!.id;
  if (byLabel.length > 1) return diagnostic(`option "${raw}" is ambiguous in "${field.name}"`, span);
  const labels = options.map((option) => option.label || option.id).join(", ");
  return diagnostic(`unknown option "${raw}" for "${field.name}"; expected one of: ${labels}`, span);
};

/** `field <op> literal` -> typed filter leaf, per field type. */
const typedComparisonLeaf = (
  field: Field,
  op: string,
  value: Literal,
  scope: Scope,
  span?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic => {
  if (value === null) {
    if (op === "=") return emptinessLeaf(field, true, span);
    if (op === "!=") return emptinessLeaf(field, false, span);
    return diagnostic(`cannot compare "${field.name}" to null with "${op}"`, span);
  }
  if (!FILTERABLE_TYPES.has(field.type)) return diagnostic(`field "${field.name}" (type "${field.type}") cannot be filtered`, span);

  if (TEXT_TYPES.has(field.type)) {
    if (op === "=") return typeof value === "string" ? filterLeaf(field.id, "equals", value) : expectedTextError(field, value, span);
    if (op === "!=") return typeof value === "string" ? filterLeaf(field.id, "notEquals", value) : expectedTextError(field, value, span);
    return unsupportedOp(field, op, span);
  }
  if (NUMBER_TYPES.has(field.type)) {
    if (!COMPARISON_OPS.has(op)) return unsupportedOp(field, op, span);
    if (typeof value !== "number") return diagnostic(`"${field.name}" expects a number, got ${literalKind(value)}`, span);
    return filterLeaf(field.id, op, value);
  }
  if (field.type === "date") return dateComparisonLeaf(field, op, value, span);
  if (field.type === "boolean") {
    if (op !== "=" && op !== "!=") return unsupportedOp(field, op, span);
    if (typeof value !== "boolean") return diagnostic(`"${field.name}" expects true or false, got ${literalKind(value)}`, span);
    return filterLeaf(field.id, "=", op === "=" ? value : !value);
  }
  if (field.type === "select") {
    if (op !== "=" && op !== "!=") return unsupportedOp(field, op, span);
    if (typeof value !== "string") return diagnostic(`"${field.name}" expects an option label or id, got ${literalKind(value)}`, span);
    const optionId = resolveSelectOption(field, value, span);
    if (isDiagnostic(optionId)) return optionId;
    return filterLeaf(field.id, op === "=" ? "is" : "isNot", optionId);
  }
  // relation / principal
  if (op !== "=" && op !== "!=") return unsupportedOp(field, op, span);
  if (field.type === "relation") {
    if (typeof value !== "string" || !SHORT_ID_RE.test(value)) {
      return diagnostic(`"${field.name}" is a relation; compare it to a public record id`, span);
    }
    return publicRelationPredicate(field, [value], op === "=" ? "any" : "none", span);
  }
  if (typeof value !== "string" || !UUID_RE.test(value)) return diagnostic(`"${field.name}" expects a user or group id (uuid)`, span);
  return filterLeaf(field.id, op === "=" ? "containsAny" : "notContainsAny", [value]);
};

const expectedTextError = (field: Field, value: Literal, span?: DslSourceSpan): DslResolverDiagnostic =>
  diagnostic(`"${field.name}" expects text, got ${literalKind(value)}`, span);

const dateComparisonLeaf = (field: Field, op: string, value: Literal, span?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  if (typeof value !== "string") return diagnostic(`"${field.name}" expects a date string, got ${literalKind(value)}`, span);
  const mapped =
    op === "="
      ? "="
      : op === "!="
        ? "notEquals"
        : op === "<"
          ? "before"
          : op === "<="
            ? "onOrBefore"
            : op === ">"
              ? "after"
              : op === ">="
                ? "onOrAfter"
                : null;
  if (!mapped) return unsupportedOp(field, op, span);
  const includeTime = Boolean((field.config as { includeTime?: boolean }).includeTime);
  const valueError = validateFilterValue(field.type, mapped, value, includeTime);
  if (valueError) return diagnostic(`"${field.name}" ${valueError.replace(/^expected/, "expects")}`, span);
  return filterLeaf(field.id, mapped, value);
};

/** Membership: `oneof(field, a, b, ...)` and friends, per field type. */
const membershipLeaf = (
  field: Field,
  values: Literal[],
  scope: Scope,
  mode: "any" | "all" | "none",
  span?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic => {
  if (!FILTERABLE_TYPES.has(field.type)) return diagnostic(`field "${field.name}" (type "${field.type}") cannot be filtered`, span);

  if (field.type === "select") {
    const ids: string[] = [];
    for (const value of values) {
      if (typeof value !== "string") return diagnostic(`"${field.name}" options must be text`, span);
      const id = resolveSelectOption(field, value, span);
      if (isDiagnostic(id)) return id;
      ids.push(id);
    }
    if (mode === "any") return filterLeaf(field.id, "isAnyOf", ids);
    if (mode === "none") return filterLeaf(field.id, "isNoneOf", ids);
    return { kind: "and", parts: ids.map((id) => filterLeaf(field.id, "is", id)) };
  }
  if (field.type === "relation") {
    const ids: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !SHORT_ID_RE.test(value)) return diagnostic(`"${field.name}" expects public record ids`, span);
      ids.push(value);
    }
    return publicRelationPredicate(field, ids, mode, span);
  }
  if (field.type === "principal") {
    const ids: string[] = [];
    for (const value of values) {
      if (typeof value !== "string" || !UUID_RE.test(value)) return diagnostic(`"${field.name}" expects ids (uuid)`, span);
      ids.push(value);
    }
    if (mode === "any") return filterLeaf(field.id, "containsAny", ids);
    if (mode === "none") return filterLeaf(field.id, "notContainsAny", ids);
    return { kind: "and", parts: ids.map((id) => filterLeaf(field.id, "containsAny", [id])) };
  }
  if (mode === "all")
    return diagnostic(
      `CONTAINSALL is only valid on select, relation, and principal fields; use explicit comparisons for "${field.name}"`,
      span,
    );
  // Scalar types: OR of equals (any), AND of not-equals (none), AND of equals (all).
  const op = mode === "none" ? "!=" : "=";
  const parts: DslWherePredicate[] = [];
  for (const value of values) {
    const leaf = typedComparisonLeaf(field, op, value, scope, span);
    if (isDiagnostic(leaf)) return leaf;
    parts.push(leaf);
  }
  if (parts.length === 1) return parts[0]!;
  return { kind: mode === "any" ? "or" : "and", parts };
};

const textMatchLeaf = (
  field: Field,
  op: "contains" | "startsWith" | "endsWith",
  label: string,
  value: Literal,
  span?: DslSourceSpan,
  options: { caseInsensitive?: boolean } = {},
): DslWherePredicate | DslResolverDiagnostic => {
  if (!TEXT_TYPES.has(field.type)) return diagnostic(`"${field.name}" must be a text field for ${label}`, span);
  if (typeof value !== "string") return diagnostic(`"${field.name}" ${label} expects text`, span);
  return filterLeaf(field.id, op, value, options);
};

/** Predicate functions like `oneof(status, 'Open', 'Closed')`. Returns
 *  `null` when the call is not a recognised predicate over (field, literals)
 *  so the caller can fall back to compiling it as a boolean SQL formula. */
const buildPredicateFunction = (
  expr: Extract<Expr, { kind: "call" }>,
  scope: Scope,
  baseSpan?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic | null => {
  if (REMOVED_EMPTY_PREDICATE_FNS.has(expr.fn)) {
    const replacement = expr.fn === "ISEMPTY" ? "= null" : "!= null";
    return diagnostic(`use field ${replacement} instead of ${expr.fn}(field) in GQL predicates`, spanForExpr(baseSpan, expr));
  }
  if (REMOVED_MEMBERSHIP_PREDICATE_FNS.has(expr.fn)) {
    return diagnostic(`use oneof(field, ...) instead of ${expr.fn}(field, ...) in GQL predicates`, spanForExpr(baseSpan, expr));
  }
  if (!PREDICATE_FNS.has(expr.fn)) return null;
  const [first, ...rest] = expr.args;
  if (!first || first.kind !== "field") return null;
  const metaKey = recordMetaUserKeyForRef(first.fieldId);
  if (isRecordIdRef(first.fieldId)) {
    if (expr.fn !== "ONEOF") return diagnostic("record.id supports oneof(record.id, ...) only", spanForExpr(baseSpan, expr));
    const values: Literal[] = [];
    for (const arg of rest) {
      if (arg.kind !== "literal") return diagnostic("record.id expects literal record ids", spanForExpr(baseSpan, arg));
      values.push(arg.value);
    }
    return recordIdPredicate(values, spanForExpr(baseSpan, expr));
  }
  if (isRecordFinalizationStateRef(first.fieldId)) {
    if (expr.fn !== "ONEOF") {
      return diagnostic("record.finalizationState supports oneof(record.finalizationState, ...) only", spanForExpr(baseSpan, expr));
    }
    const values: Literal[] = [];
    for (const arg of rest) {
      if (arg.kind !== "literal") return diagnostic("record.finalizationState expects literal states", spanForExpr(baseSpan, arg));
      values.push(arg.value);
    }
    return finalizationStatePredicate(values, spanForExpr(baseSpan, expr));
  }
  if (metaKey) {
    if (expr.fn !== "ONEOF")
      return diagnostic(`record.${metaKey} supports oneof(record.${metaKey}, ...) only`, spanForExpr(baseSpan, expr));
    const values: Literal[] = [];
    for (const arg of rest) {
      if (arg.kind !== "literal") return diagnostic(`record.${metaKey} expects literal user ids`, spanForExpr(baseSpan, arg));
      values.push(arg.value);
    }
    return recordMetaPredicate(metaKey, values, spanForExpr(baseSpan, expr));
  }
  if (isScopedFormulaFieldRef(first.fieldId)) {
    if (expr.fn === "ONEOF" || expr.fn === "NONEOF" || expr.fn === "CONTAINSALL") {
      return diagnostic(`membership predicate ${expr.fn} on joined field "${first.fieldId}" is not supported`, spanForExpr(baseSpan, expr));
    }
    return null;
  }
  const fieldSpan = spanForExpr(baseSpan, first);
  const callSpan = spanForExpr(baseSpan, expr);
  const field = fieldByRef(scope, first.fieldId, fieldSpan);
  if (isDiagnostic(field)) return field;
  // Computed/unstorable fields have no typed filter leaf — decline so the call
  // compiles as a boolean SQL formula instead.
  if (!FILTERABLE_TYPES.has(field.type)) return null;

  const values: Literal[] = [];
  for (const arg of rest) {
    if (arg.kind !== "literal") return null; // dynamic argument -> compile as formula
    values.push(arg.value);
  }

  switch (expr.fn) {
    case "ONEOF":
      return membershipLeaf(field, values, scope, "any", callSpan);
    case "NONEOF":
      return membershipLeaf(field, values, scope, "none", callSpan);
    case "CONTAINSALL":
      return membershipLeaf(field, values, scope, "all", callSpan);
    case "CONTAINS": {
      if (values.length !== 1) return diagnostic("CONTAINS takes a field and one value", callSpan);
      const value = values[0]!;
      if (field.type === "select" || field.type === "relation" || field.type === "principal")
        return diagnostic(`use oneof for membership filters on ${field.type} field "${field.name}"`, callSpan);
      return textMatchLeaf(field, "contains", "contains", value, callSpan);
    }
    case "STARTSWITH":
      if (values.length !== 1) return diagnostic("STARTSWITH takes a field and one value", callSpan);
      return textMatchLeaf(field, "startsWith", "startswith", values[0]!, callSpan);
    case "ENDSWITH":
      if (values.length !== 1) return diagnostic("ENDSWITH takes a field and one value", callSpan);
      return textMatchLeaf(field, "endsWith", "endswith", values[0]!, callSpan);
    case "ICONTAINS": {
      if (values.length !== 1) return diagnostic("ICONTAINS takes a field and one value", callSpan);
      const value = values[0]!;
      if (field.type === "select" || field.type === "relation" || field.type === "principal")
        return diagnostic(`use oneof for membership filters on ${field.type} field "${field.name}"`, callSpan);
      return textMatchLeaf(field, "contains", "icontains", value, callSpan, { caseInsensitive: true });
    }
    case "ISTARTSWITH":
      if (values.length !== 1) return diagnostic("ISTARTSWITH takes a field and one value", callSpan);
      return textMatchLeaf(field, "startsWith", "istartswith", values[0]!, callSpan, { caseInsensitive: true });
    case "IENDSWITH":
      if (values.length !== 1) return diagnostic("IENDSWITH takes a field and one value", callSpan);
      return textMatchLeaf(field, "endsWith", "iendswith", values[0]!, callSpan, { caseInsensitive: true });
    default:
      return null;
  }
};

const buildComparisonPredicate = (
  expr: Extract<Expr, { kind: "binop" }>,
  scope: Scope,
  baseSpan?: DslSourceSpan,
): DslWherePredicate | DslResolverDiagnostic => {
  const leftField = expr.left.kind === "field";
  const rightField = expr.right.kind === "field";
  // Exactly one field side + a literal other side -> typed filter leaf.
  if (leftField !== rightField) {
    const fieldExpr = (leftField ? expr.left : expr.right) as Extract<Expr, { kind: "field" }>;
    const valueExpr = leftField ? expr.right : expr.left;
    const metaKey = recordMetaUserKeyForRef(fieldExpr.fieldId);
    if (isRecordIdRef(fieldExpr.fieldId)) {
      if (valueExpr.kind !== "literal") return diagnostic("record.id expects a literal record id", spanForExpr(baseSpan, valueExpr));
      const op = leftField ? expr.op : invertComparison(expr.op);
      if (op !== "=") return diagnostic('record.id supports "=" or oneof(...) only', spanForExpr(baseSpan, expr));
      return recordIdPredicate([valueExpr.value], spanForExpr(baseSpan, expr));
    }
    if (isRecordFinalizationStateRef(fieldExpr.fieldId)) {
      if (valueExpr.kind !== "literal") {
        return diagnostic("record.finalizationState expects a literal state", spanForExpr(baseSpan, valueExpr));
      }
      const op = leftField ? expr.op : invertComparison(expr.op);
      if (op !== "=") return diagnostic('record.finalizationState supports "=" or oneof(...) only', spanForExpr(baseSpan, expr));
      return finalizationStatePredicate([valueExpr.value], spanForExpr(baseSpan, expr));
    }
    if (metaKey) {
      if (valueExpr.kind !== "literal") return diagnostic(`record.${metaKey} expects a literal user id`, spanForExpr(baseSpan, valueExpr));
      const op = leftField ? expr.op : invertComparison(expr.op);
      if (op !== "=") return diagnostic(`record.${metaKey} supports "=" or oneof(...) only`, spanForExpr(baseSpan, expr));
      return recordMetaPredicate(metaKey, [valueExpr.value], spanForExpr(baseSpan, expr));
    }
    if (isScopedFormulaFieldRef(fieldExpr.fieldId)) return formulaLeaf(expr, scope, baseSpan);
    if (valueExpr.kind !== "literal") return formulaLeaf(expr, scope, baseSpan); // field vs expression -> formula
    const fieldSpan = spanForExpr(baseSpan, fieldExpr);
    const valueSpan = spanForExpr(baseSpan, valueExpr);
    const field = fieldByRef(scope, fieldExpr.fieldId, fieldSpan);
    if (isDiagnostic(field)) return field;
    // Computed / unstorable fields (formula, lookup, rollup, json) have no
    // typed filter leaf; let the formula compiler handle them in SQL. Formula
    // fields inline their own expression, so `computed > 5` works.
    if (!FILTERABLE_TYPES.has(field.type)) return formulaLeaf(expr, scope, baseSpan);
    const op = leftField ? expr.op : invertComparison(expr.op);
    return typedComparisonLeaf(field, op, valueExpr.value, scope, valueSpan);
  }
  // field vs field, literal vs literal, expression vs expression -> formula.
  return formulaLeaf(expr, scope, baseSpan);
};

const buildPredicate = (expr: Expr, scope: Scope, baseSpan?: DslSourceSpan): DslWherePredicate | DslResolverDiagnostic => {
  if (expr.kind === "binop" && (expr.op === "&&" || expr.op === "||")) {
    const left = buildPredicate(expr.left, scope, baseSpan);
    if (isDiagnostic(left)) return left;
    const right = buildPredicate(expr.right, scope, baseSpan);
    if (isDiagnostic(right)) return right;
    const targetKind = expr.op === "&&" ? "and" : "or";
    const flatten = (node: DslWherePredicate): DslWherePredicate[] =>
      node.kind === targetKind ? (node as { parts: DslWherePredicate[] }).parts : [node];
    return { kind: targetKind, parts: [...flatten(left), ...flatten(right)] };
  }
  if (expr.kind === "unop" && expr.op === "!") {
    const inner = buildPredicate(expr.operand, scope, baseSpan);
    if (isDiagnostic(inner)) return inner;
    return { kind: "not", part: inner };
  }
  if (expr.kind === "binop" && COMPARISON_OPS.has(expr.op)) return buildComparisonPredicate(expr, scope, baseSpan);
  if (expr.kind === "field") {
    if (isRecordIdRef(expr.fieldId)) return diagnostic("record.id must be compared to a record id", spanForExpr(baseSpan, expr));
    if (isRecordFinalizationStateRef(expr.fieldId)) {
      return diagnostic("record.finalizationState must be compared to a state", spanForExpr(baseSpan, expr));
    }
    const metaKey = recordMetaUserKeyForRef(expr.fieldId);
    if (metaKey) return diagnostic(`record.${metaKey} must be compared to a user id`, spanForExpr(baseSpan, expr));
    if (isScopedFormulaFieldRef(expr.fieldId)) return formulaLeaf(expr, scope, baseSpan);
    const field = fieldByRef(scope, expr.fieldId, spanForExpr(baseSpan, expr));
    if (isDiagnostic(field)) return field;
    if (field.type === "boolean") return filterLeaf(field.id, "=", true);
    return formulaLeaf(expr, scope, baseSpan);
  }
  if (expr.kind === "call") {
    const predicate = buildPredicateFunction(expr, scope, baseSpan);
    if (predicate !== null) return predicate;
    return formulaLeaf(expr, scope, baseSpan);
  }
  return formulaLeaf(expr, scope, baseSpan);
};

const isPurePredicate = (node: DslWherePredicate): boolean => {
  switch (node.kind) {
    case "and":
    case "or":
      return node.parts.every(isPurePredicate);
    case "filter":
    case "tree":
    case "recordMeta":
      return true;
    default:
      return false;
  }
};

const purePredicateParts = (
  node: DslWherePredicate,
): { ok: true; filter?: FilterTree; recordMeta?: RecordMetaQuery } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  switch (node.kind) {
    case "filter":
      return { ok: true, filter: node.leaf as FilterTree };
    case "tree":
      return { ok: true, filter: node.tree };
    case "recordMeta":
      return { ok: true, recordMeta: node.meta };
    case "and": {
      const filters: FilterTree[] = [];
      let recordMeta: RecordMetaQuery | undefined;
      for (const part of node.parts) {
        const split = purePredicateParts(part);
        if (!split.ok) return split;
        if (split.filter) filters.push(split.filter);
        recordMeta = mergeRecordMeta(recordMeta, split.recordMeta);
      }
      return {
        ok: true,
        ...(filters.length === 1 ? { filter: filters[0] } : filters.length > 1 ? { filter: { op: "AND", filters } as FilterTree } : {}),
        ...(recordMeta ? { recordMeta } : {}),
      };
    }
    case "or": {
      const filters: FilterTree[] = [];
      for (const part of node.parts) {
        const split = purePredicateParts(part);
        if (!split.ok) return split;
        if (split.recordMeta) return { ok: false, diagnostic: diagnostic("record metadata predicates can only be combined with and") };
        if (split.filter) filters.push(split.filter);
      }
      return { ok: true, filter: filters.length === 1 ? filters[0] : ({ op: "OR", filters } as FilterTree) };
    }
    default:
      return { ok: false, diagnostic: diagnostic("predicate cannot be represented as a RecordQuery filter") };
  }
};

export const resolveWhere = (where: NonNullable<DslQueryAst["where"]>, scope: Scope): WhereResolution => {
  const built = buildPredicate(where.expression, scope, where.span);
  if (isDiagnostic(built)) return { kind: "error", diagnostic: built };
  if (isPurePredicate(built)) {
    const split = purePredicateParts(built);
    if (!split.ok) return { kind: "error", diagnostic: split.diagnostic };
    return {
      kind: "filter",
      ...(split.filter ? { tree: split.filter } : {}),
      ...(split.recordMeta ? { recordMeta: split.recordMeta } : {}),
    };
  }
  return { kind: "predicate", node: built };
};
