import type { Expr, Literal } from "../formula/types";
import { normalizeRefKey, parseQualifiedIdentifierRef } from "../ref-syntax";
import type { Field } from "../service/types";
import type { DslDerivedViewColumn, DslResolvedRelationJoin, DslResolverDiagnostic } from "./resolver";
import { gqlFieldRef, gqlLiteralSource, gqlQuotedRef } from "./source-format";
import type { DslQualifiedRef } from "./types";

export type CanonicalScope = {
  tableId: string;
  sourceAlias?: string;
  derivedColumns?: DslDerivedViewColumn[];
  fieldsByTableId: Record<string, Field[]>;
  joinsByAlias: Map<string, DslResolvedRelationJoin>;
};

type FormulaPrintOptions = {
  aggregateAliases?: ReadonlySet<string>;
};

const GQL_PREDICATE_FUNCTIONS = new Set([
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
const SELECT_MEMBERSHIP_FUNCTIONS = new Set(["ONEOF", "NONEOF", "CONTAINSALL"]);
const COMPARISON_OPS = new Set(["=", "!="]);
const RECORD_SCOPE = "record";
const RECORD_META_REFS = new Map(
  [
    "id",
    "createdBy",
    "updatedBy",
    "deletedBy",
    "createdAt",
    "updatedAt",
    "deletedAt",
    "finalizedAt",
    "finalizedBy",
    "finalizationState",
  ].map((ref) => [ref.replaceAll("_", "").toLowerCase(), `record.${ref}`]),
);

const isAlive = (field: Field): boolean => !field.deletedAt;

const lookupField = (fields: Field[], ref: string): Field | null | "ambiguous" => {
  const key = normalizeRefKey(ref);
  const matches = fields.filter(
    (field) => isAlive(field) && (normalizeRefKey(field.shortId) === key || normalizeRefKey(field.name) === key),
  );
  if (matches.length === 0) return null;
  if (matches.length > 1) return "ambiguous";
  return matches[0]!;
};

const scopeTableId = (scope: CanonicalScope, alias: string | undefined): string | null => {
  if (!alias) return scope.tableId;
  if (scope.sourceAlias && normalizeRefKey(scope.sourceAlias) === normalizeRefKey(alias)) return scope.tableId;
  return scope.joinsByAlias.get(normalizeRefKey(alias))?.tableId ?? null;
};

export const recordMetaRef = (ref: DslQualifiedRef): string | null => {
  if (!ref.scope || normalizeRefKey(ref.scope) !== RECORD_SCOPE) return null;
  return RECORD_META_REFS.get(ref.ref.replaceAll("_", "").toLowerCase()) ?? null;
};

const canonicalScopeAlias = (scope: CanonicalScope, alias: string | undefined): string | undefined => {
  if (!alias) return undefined;
  if (scope.sourceAlias && normalizeRefKey(scope.sourceAlias) === normalizeRefKey(alias)) return scope.sourceAlias;
  return scope.joinsByAlias.get(normalizeRefKey(alias))?.alias ?? alias;
};

const fieldForRef = (
  ref: DslQualifiedRef,
  scope: CanonicalScope,
): { ok: true; field: Field } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  if (scope.derivedColumns && !ref.scope) {
    const key = normalizeRefKey(ref.ref);
    const matches = scope.derivedColumns.filter((column) => column.refs.some((candidate) => normalizeRefKey(candidate) === key));
    if (matches.length === 0) return { ok: false, diagnostic: { message: `unknown derived column "${ref.ref}"`, ...ref.span } };
    return { ok: false, diagnostic: { message: `derived column "${matches[0]!.label}" is not a source field`, ...ref.span } };
  }
  const tableId = scopeTableId(scope, ref.scope);
  if (!tableId) return { ok: false, diagnostic: { message: `unknown scope "${ref.scope}"`, ...ref.span } };
  const field = lookupField(scope.fieldsByTableId[tableId] ?? [], ref.ref);
  if (field === "ambiguous") return { ok: false, diagnostic: { message: `ambiguous field "${ref.ref}"`, ...ref.span } };
  if (!field) return { ok: false, diagnostic: { message: `unknown field "${ref.ref}"`, ...ref.span } };
  return { ok: true, field };
};

export const resolveFieldRef = (
  ref: DslQualifiedRef,
  scope: CanonicalScope,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  if (scope.derivedColumns && !ref.scope) {
    const key = normalizeRefKey(ref.ref);
    const matches = scope.derivedColumns.filter((column) => column.refs.some((candidate) => normalizeRefKey(candidate) === key));
    if (matches.length === 0) return { ok: false, diagnostic: { message: `unknown derived column "${ref.ref}"`, ...ref.span } };
    if (matches.length > 1) return { ok: false, diagnostic: { message: `ambiguous derived column "${ref.ref}"`, ...ref.span } };
    return { ok: true, text: gqlQuotedRef(matches[0]!.publicKey ?? matches[0]!.key) };
  }
  const resolved = fieldForRef(ref, scope);
  if (!resolved.ok) return { ok: false, diagnostic: resolved.diagnostic };
  const field = resolved.field;
  const alias = canonicalScopeAlias(scope, ref.scope);
  return { ok: true, text: alias ? `${alias}.${gqlFieldRef(field.shortId)}` : gqlFieldRef(field.shortId) };
};

const fieldForFormulaFieldRef = (
  ref: string,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
): { ok: true; field: Field } | { ok: true; field: null } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const qualified = parseQualifiedIdentifierRef(ref) ?? { ref };
  if (recordMetaRef(qualified)) return { ok: true, field: null };
  if (!qualified.scope && options.aggregateAliases?.has(normalizeRefKey(qualified.ref))) return { ok: true, field: null };
  if (scope.derivedColumns && !qualified.scope) return { ok: true, field: null };
  const resolved = fieldForRef(qualified, scope);
  return resolved.ok ? { ok: true, field: resolved.field } : resolved;
};

const resolveFormulaFieldRef = (
  ref: string,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const qualified = parseQualifiedIdentifierRef(ref) ?? { ref };
  const metaRef = recordMetaRef(qualified);
  if (metaRef) return { ok: true, text: metaRef };
  if (!qualified.scope && options.aggregateAliases?.has(normalizeRefKey(qualified.ref))) return { ok: true, text: qualified.ref };
  return resolveFieldRef(qualified, scope);
};

const canonicalSelectValue = (
  field: Field,
  value: Literal,
): { ok: true; value: Literal } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  if (field.type !== "select" || typeof value !== "string") return { ok: true, value };
  const options = (field.config as { options?: Array<{ id: string; label?: string }> }).options;
  if (!options || options.length === 0) return { ok: true, value };
  const byId = options.find((option) => option.id === value);
  if (byId) return { ok: true, value: byId.id };
  const key = normalizeRefKey(value);
  const byLabel = options.filter((option) => normalizeRefKey(option.label ?? "") === key);
  if (byLabel.length === 1) return { ok: true, value: byLabel[0]!.id };
  if (byLabel.length > 1) return { ok: false, diagnostic: { message: `option "${value}" is ambiguous in "${field.name}"` } };
  const labels = options.map((option) => option.label || option.id).join(", ");
  return { ok: false, diagnostic: { message: `unknown option "${value}" for "${field.name}"; expected one of: ${labels}` } };
};

const BINOP_PRECEDENCE: Record<string, number> = {
  "||": 10,
  "&&": 20,
  "=": 30,
  "!=": 30,
  "<": 40,
  "<=": 40,
  ">": 40,
  ">=": 40,
  "+": 50,
  "-": 50,
  "*": 60,
  "/": 60,
  "%": 60,
};

const publicBinop = (op: string): string => {
  if (op === "&&") return "and";
  if (op === "||") return "or";
  return op;
};

const publicCallName = (fn: string): string => (GQL_PREDICATE_FUNCTIONS.has(fn) ? fn.toLowerCase() : fn.toUpperCase());

const parenthesize = (text: string, ownPrecedence: number, parentPrecedence: number): string =>
  ownPrecedence < parentPrecedence ? `(${text})` : text;

export const formulaSource = (
  expr: Expr,
  scope: CanonicalScope,
  options: FormulaPrintOptions = {},
  parentPrecedence = 0,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  switch (expr.kind) {
    case "literal":
      return { ok: true, text: gqlLiteralSource(expr.value) };
    case "field":
      return resolveFormulaFieldRef(expr.fieldId, scope, options);
    case "call":
      return formulaCallSource(expr, scope, options);
    case "unop":
      return formulaUnarySource(expr, scope, options, parentPrecedence);
    case "binop":
      return formulaBinarySource(expr, scope, options, parentPrecedence);
  }
};

const formulaCallSource = (
  expr: Extract<Expr, { kind: "call" }>,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const args: string[] = [];
  const fieldArg = expr.args[0]?.kind === "field" ? fieldForFormulaFieldRef(expr.args[0].fieldId, scope, options) : null;
  if (fieldArg && !fieldArg.ok) return fieldArg;
  for (const [index, arg] of expr.args.entries()) {
    if (index > 0 && SELECT_MEMBERSHIP_FUNCTIONS.has(expr.fn) && fieldArg?.ok && fieldArg.field && arg.kind === "literal") {
      const stable = canonicalSelectValue(fieldArg.field, arg.value);
      if (!stable.ok) return stable;
      args.push(gqlLiteralSource(stable.value));
      continue;
    }
    const printed = formulaSource(arg, scope, options);
    if (!printed.ok) return printed;
    args.push(printed.text);
  }
  return { ok: true, text: `${publicCallName(expr.fn)}(${args.join(", ")})` };
};

const formulaUnarySource = (
  expr: Extract<Expr, { kind: "unop" }>,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
  parentPrecedence: number,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const ownPrecedence = 70;
  const operand = formulaSource(expr.operand, scope, options, ownPrecedence);
  if (!operand.ok) return operand;
  const text = expr.op === "!" ? `not ${operand.text}` : `-${operand.text}`;
  return { ok: true, text: parenthesize(text, ownPrecedence, parentPrecedence) };
};

const formulaBinarySource = (
  expr: Extract<Expr, { kind: "binop" }>,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
  parentPrecedence: number,
): { ok: true; text: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  const ownPrecedence = BINOP_PRECEDENCE[expr.op] ?? 0;
  const left = formulaSource(expr.left, scope, options, ownPrecedence);
  if (!left.ok) return left;
  const right = formulaSource(expr.right, scope, options, ownPrecedence + 1);
  if (!right.ok) return right;
  const stable = stableComparisonText(expr, scope, options, left.text, right.text);
  if (!stable.ok) return stable;
  const text = `${stable.leftText} ${publicBinop(expr.op)} ${stable.rightText}`;
  return { ok: true, text: parenthesize(text, ownPrecedence, parentPrecedence) };
};

const stableComparisonText = (
  expr: Extract<Expr, { kind: "binop" }>,
  scope: CanonicalScope,
  options: FormulaPrintOptions,
  leftText: string,
  rightText: string,
): { ok: true; leftText: string; rightText: string } | { ok: false; diagnostic: DslResolverDiagnostic } => {
  if (!COMPARISON_OPS.has(expr.op)) return { ok: true, leftText, rightText };
  const leftField = expr.left.kind === "field" ? fieldForFormulaFieldRef(expr.left.fieldId, scope, options) : null;
  if (leftField && !leftField.ok) return leftField;
  const rightField = expr.right.kind === "field" ? fieldForFormulaFieldRef(expr.right.fieldId, scope, options) : null;
  if (rightField && !rightField.ok) return rightField;
  if (leftField?.ok && leftField.field && expr.right.kind === "literal") {
    const stable = canonicalSelectValue(leftField.field, expr.right.value);
    return stable.ok ? { ok: true, leftText, rightText: gqlLiteralSource(stable.value) } : stable;
  }
  if (rightField?.ok && rightField.field && expr.left.kind === "literal") {
    const stable = canonicalSelectValue(rightField.field, expr.left.value);
    return stable.ok ? { ok: true, leftText: gqlLiteralSource(stable.value), rightText } : stable;
  }
  return { ok: true, leftText, rightText };
};
