import { ShortIdSchema } from "./contracts";
import { VALUE_FIELD_TYPES } from "./field-types";
import { objectListFormulaColumns, validateObjectList } from "./field-types/object-list";
import { SelectConfigSchema } from "./field-types/select";
import { evaluate, renderResult } from "./formula/evaluator";
import type { FormulaRuntimeContext } from "./formula/function-runtime";
import { collectFieldRefs, parseFormula } from "./formula/parser";
import { type Expr, isFormulaError } from "./formula/types";
import { normalizeRefKey } from "./ref-syntax";

export type FormComputedField = {
  id: string;
  shortId?: string;
  name: string;
  type: string;
  config: unknown;
  required: boolean;
  deletedAt?: string | null;
};

/** A summary can only derive from visible inputs, never hidden/server data. */
export type FormComputedDiagnostic = "missing" | "ambiguous" | "hidden" | "unsupported" | "cycle" | "syntax" | "duplicate" | "target";

type FormComputedPlan = {
  fields: FormComputedField[];
  steps: Array<{ fieldId: string; ast: Expr }>;
  refs: Record<string, string>;
};

export function inspectFormComputedFields(
  targets: readonly string[],
  inputIds: ReadonlySet<string>,
  fields: readonly FormComputedField[],
): { ok: true; plan: FormComputedPlan } | { ok: false; code: FormComputedDiagnostic } {
  const active = fields.filter((field) => !field.deletedAt);
  const byId = new Map(active.map((field) => [field.id, field]));
  const names = new Map<string, Set<string>>();
  for (const field of active) {
    // Public DTOs expose the short ID as id; internal UUIDs are not formula aliases.
    const shortId = field.shortId ?? (ShortIdSchema.safeParse(field.id).success ? field.id : undefined);
    for (const ref of [shortId, field.name]) {
      if (!ref) continue;
      const key = normalizeRefKey(ref);
      const matches = names.get(key) ?? new Set<string>();
      matches.add(field.id);
      names.set(key, matches);
    }
  }
  const refs: Record<string, string> = Object.fromEntries(
    [...names].flatMap(([key, ids]) => (ids.size === 1 ? [[key, [...ids][0]!]] : [])),
  );
  const needed = new Set<string>();
  const visiting = new Set<string>();
  const steps: Array<{ fieldId: string; ast: Expr }> = [];
  let diagnostic: FormComputedDiagnostic = "missing";
  const reject = (code: FormComputedDiagnostic): false => {
    diagnostic = code;
    return false;
  };
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return reject("cycle");
    if (needed.has(id)) return true;
    const field = byId.get(id);
    if (!field) return reject("missing");
    if (field.type !== "formula") {
      if (!VALUE_FIELD_TYPES[field.type]) return reject("unsupported");
      if (!inputIds.has(id)) return reject("hidden");
      needed.add(id);
      return true;
    }
    const expression = field.config && typeof field.config === "object" && "expression" in field.config ? field.config.expression : null;
    if (typeof expression !== "string") return reject("syntax");
    const parsed = parseFormula(expression);
    if (!parsed.ok) return reject("syntax");
    visiting.add(id);
    for (const ref of collectFieldRefs(parsed.ast)) {
      const dependency = refs[normalizeRefKey(ref)];
      if (!dependency) return reject((names.get(normalizeRefKey(ref))?.size ?? 0) > 1 ? "ambiguous" : "missing");
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    needed.add(id);
    steps.push({ fieldId: id, ast: parsed.ast });
    return true;
  };
  if (new Set(targets).size !== targets.length) return { ok: false as const, code: "duplicate" as const };
  for (const id of targets) {
    if (!byId.has(id)) return { ok: false as const, code: "missing" as const };
    if (byId.get(id)?.type !== "formula") return { ok: false as const, code: "target" as const };
    if (!visit(id)) return { ok: false as const, code: diagnostic };
  }
  return {
    ok: true as const,
    plan: {
      fields: active.filter((field) => needed.has(field.id)),
      steps,
      refs: Object.fromEntries(Object.entries(refs).filter(([, id]) => needed.has(id))),
    },
  };
}

export function planFormComputedFields(targets: readonly string[], inputIds: ReadonlySet<string>, fields: readonly FormComputedField[]) {
  const result = inspectFormComputedFields(targets, inputIds, fields);
  return result.ok ? result.plan : null;
}

/** No result from this preview is submitted. Canonical writes calculate again. */
type FormComputedPreview = { kind: "values"; values: Record<string, unknown> } | { kind: "incomplete" } | { kind: "error" };

export function previewFormComputedFields(
  targets: readonly string[],
  inputIds: ReadonlySet<string>,
  fields: readonly FormComputedField[],
  values: Readonly<Record<string, unknown>>,
  context: FormulaRuntimeContext & { locale?: string } = {},
): FormComputedPreview {
  const plan = planFormComputedFields(targets, inputIds, fields);
  if (!plan) return { kind: "error" };
  const scratch: Record<string, unknown> = {};
  for (const field of plan.fields) {
    if (field.type === "formula") continue;
    const handler = VALUE_FIELD_TYPES[field.type];
    if (!handler || !handler.configSchema.safeParse(field.config).success) return { kind: "error" };
    const validated =
      field.type === "object_list"
        ? validateObjectList(values[field.id], field.config, field.required, { stored: true, context })
        : handler.validate(values[field.id], field.config, field.required, context);
    if (!validated.ok) return { kind: "calculationError" in validated ? "error" : "incomplete" };
    scratch[field.id] = validated.value;
  }
  const listColumns = objectListFormulaColumns(plan.fields);
  const selectFields = Object.fromEntries(
    plan.fields
      .filter((field) => field.type === "select")
      .flatMap((field) => {
        const config = SelectConfigSchema.safeParse(field.config);
        return config.success ? [[field.id, { name: field.name, config: config.data }]] : [];
      }),
  );
  for (const step of plan.steps) {
    const result = evaluate(step.ast, { ...context, fields: scratch, slugToId: plan.refs, listColumns, selectFields });
    if (isFormulaError(result)) return { kind: "error" };
    scratch[step.fieldId] = result;
  }
  return { kind: "values", values: Object.fromEntries(targets.map((id) => [id, renderResult(scratch[id])])) };
}
