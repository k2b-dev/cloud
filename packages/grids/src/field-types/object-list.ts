import { z } from "zod";
import { ShortIdSchema } from "../contracts";
import { evaluate } from "../formula/evaluator";
import { planObjectListCalculations } from "../formula/object-list-plan";
import { isFormulaError } from "../formula/types";
import { normalizeRefKey } from "../ref-syntax";
import { booleanHandler } from "./boolean";
import { dateHandler } from "./date";
import { FormulaConfigSchema } from "./formula";
import { numberHandler } from "./number";
import { selectHandler } from "./select";
import { longtextHandler, textHandler } from "./text";
import { durationHandler, percentHandler } from "./tier2";
import { type FieldValidationContext, fail, ok, type ValueFieldType } from "./types";
import { fieldValidationMessages } from "./validation-messages";

/** Operational budget for one atomic, editable record value (not a hidden child table). */
export const OBJECT_LIST_LIMITS = { rows: 1_000, fields: 200, bytes: 256 * 1024 } as const;

export const ObjectListScalarTypeSchema = z.enum(["text", "longtext", "number", "boolean", "date", "select", "percent", "duration"]);
export type ObjectListScalarType = z.infer<typeof ObjectListScalarTypeSchema>;
export const objectListScalarHandlers: Record<ObjectListScalarType, ValueFieldType> = {
  text: textHandler,
  longtext: longtextHandler,
  number: numberHandler,
  boolean: booleanHandler,
  date: dateHandler,
  select: selectHandler,
  percent: percentHandler,
  duration: durationHandler,
};

export const ObjectListColumnSchema = z
  .object({
    id: ShortIdSchema,
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2_000).optional(),
    type: ObjectListScalarTypeSchema,
    config: z.record(z.string(), z.unknown()).default({}),
    required: z.boolean().default(false),
    formula: FormulaConfigSchema.optional(),
  })
  .strict()
  .transform((column, ctx) => {
    const parsed = objectListScalarHandlers[column.type].configSchema.pipe(z.record(z.string(), z.unknown())).safeParse(column.config);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: ["config", ...issue.path], message: issue.message });
      return z.NEVER;
    }
    // Persist the scalar owner's normalized configuration, not the unchecked
    // input: SQL and UI must see the same defaults and supported properties.
    return { ...column, config: parsed.data };
  });

export const ObjectListConfigSchema = z
  .object({
    fields: z.array(ObjectListColumnSchema).min(1).max(OBJECT_LIST_LIMITS.fields),
    minItems: z.number().int().min(0).max(OBJECT_LIST_LIMITS.rows).default(0),
    maxItems: z.number().int().min(1).max(OBJECT_LIST_LIMITS.rows).default(100),
  })
  .strict()
  .superRefine((config, ctx) => {
    if (config.minItems > config.maxItems) ctx.addIssue({ code: "custom", path: ["minItems"], message: "minItems cannot exceed maxItems" });
    const ids = new Set<string>();
    const names = new Set<string>();
    const references = new Map<string, number>();
    for (const [index, field] of config.fields.entries()) {
      if (ids.has(field.id)) ctx.addIssue({ code: "custom", path: ["fields", index, "id"], message: "duplicate field id" });
      if (names.has(normalizeRefKey(field.name)))
        ctx.addIssue({ code: "custom", path: ["fields", index, "name"], message: "duplicate field name" });
      ids.add(field.id);
      names.add(normalizeRefKey(field.name));
      for (const key of ["id", "name"] as const) {
        const ref = normalizeRefKey(field[key]);
        const owner = references.get(ref);
        if (owner !== undefined && owner !== index)
          ctx.addIssue({ code: "custom", path: ["fields", index, key], message: "ambiguous field reference" });
        references.set(ref, index);
      }
    }
    const calculations = planObjectListCalculations(config.fields);
    if (!calculations.ok)
      ctx.addIssue({
        code: "custom",
        path: ["fields", config.fields.findIndex((field) => field.id === calculations.columnId), "formula", "expression"],
        message: calculations.error,
      });
  });
export type ObjectListConfig = z.infer<typeof ObjectListConfigSchema>;
export type ObjectListColumn = ObjectListConfig["fields"][number];
export type ObjectListValue = Array<Record<string, unknown>>;

export const objectListFormulaColumns = (
  fields: ReadonlyArray<{ id: string; type: string; config: unknown }>,
): Record<string, Record<string, string>> =>
  Object.fromEntries(
    fields
      .filter((field) => field.type === "object_list")
      .flatMap((field) => {
        const config = ObjectListConfigSchema.safeParse(field.config);
        return config.success
          ? [
              [
                field.id,
                Object.fromEntries(
                  config.data.fields
                    .filter((column) => column.type === "number" || column.type === "percent" || column.type === "duration")
                    .flatMap((column) => [
                      [normalizeRefKey(column.id), column.id],
                      [normalizeRefKey(column.name), column.id],
                    ]),
                ),
              ],
            ]
          : [];
      }),
  );

/** Build editable/default input from a calculated value; never used to accept client writes. */
export const objectListInputValue = (value: unknown, config: ObjectListConfig): unknown => {
  if (!Array.isArray(value)) return value;
  const computed = new Set(config.fields.filter((column) => column.formula).map((column) => column.id));
  return value.map((row: unknown) => (isRow(row) ? Object.fromEntries(Object.entries(row).filter(([key]) => !computed.has(key))) : row));
};

/** Prepare a trusted read/default snapshot for editing, never incoming write payloads. */
export const objectListRecordInputValues = (
  fields: ReadonlyArray<{ id: string; type: string; config: unknown }>,
  values: Record<string, unknown>,
): Record<string, unknown> => {
  const out = { ...values };
  for (const field of fields) {
    if (field.type !== "object_list" || !Object.hasOwn(values, field.id)) continue;
    const config = ObjectListConfigSchema.safeParse(field.config);
    if (config.success) out[field.id] = objectListInputValue(values[field.id], config.data);
  }
  return out;
};

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Only inspect the supported, shallow JSON shape. In particular, do not stringify
// arbitrary nested objects before rejecting them (including circular values).
const jsonLeafBytes = (value: unknown, remaining: number): number | null => {
  if (value === undefined || value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : null;
  if (typeof value !== "string") return null;
  if (value.length > remaining) return remaining + 1;
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
};

type ObjectListValidationResult =
  | { ok: true; value: ObjectListValue | null }
  | { ok: false; error: string; calculationError?: { field: string; detail: string } };

export const validateObjectList = (
  raw: unknown,
  configRaw: unknown,
  required: boolean,
  options: {
    stored?: boolean;
    context?: FieldValidationContext;
  } = {},
): ObjectListValidationResult => {
  const t = fieldValidationMessages(options.context?.locale);
  const parsed = ObjectListConfigSchema.safeParse(configRaw);
  if (!parsed.success) return fail(t.config);
  const config = parsed.data;
  const calculations = planObjectListCalculations(config.fields);
  if (!calculations.ok) return fail(calculations.error);
  if (raw === undefined || raw === null || raw === "") return required || config.minItems > 0 ? fail(t.required) : ok(null);
  if (!Array.isArray(raw)) return fail(t.list);
  if (raw.length > config.maxItems) return fail(t.maxItems({ count: config.maxItems }));
  if (raw.length < Math.max(required ? 1 : 0, config.minItems))
    return fail(t.minItems({ count: Math.max(required ? 1 : 0, config.minItems) }));
  const ids = new Set(config.fields.map((field) => field.id));
  const rows: ObjectListValue = [];
  let inputBytes = 2;
  let outputBytes = 2;
  const tooLarge = () => fail(t.bytes({ count: OBJECT_LIST_LIMITS.bytes }));
  for (const [index, item] of raw.entries()) {
    if (!isRow(item)) return fail(t.row({ row: index + 1, detail: t.object }));
    for (const key in item)
      if (Object.hasOwn(item, key) && !ids.has(key)) return fail(t.row({ row: index + 1, detail: t.unknownField({ field: key }) }));
    inputBytes += 2 + (index > 0 ? 1 : 0);
    const row: Record<string, unknown> = {};
    for (const [fieldIndex, field] of config.fields.entries()) {
      const value = item[field.id];
      if (field.formula) {
        if (!options.stored && Object.hasOwn(item, field.id))
          return fail(t.cell({ row: index + 1, field: field.name, detail: t.calculated }));
        continue;
      }
      const cells: unknown[] = field.type === "select" && Array.isArray(value) ? value : [value];
      inputBytes += field.id.length + 3 + (fieldIndex > 0 ? 1 : 0) + (cells === value ? 2 + Math.max(0, cells.length - 1) : 0);
      if (inputBytes > OBJECT_LIST_LIMITS.bytes) return tooLarge();
      for (const cell of cells) {
        const bytes = jsonLeafBytes(cell, OBJECT_LIST_LIMITS.bytes - inputBytes);
        if (bytes === null) return fail(t.cell({ row: index + 1, field: field.name, detail: t.scalar }));
        inputBytes += bytes;
        if (inputBytes > OBJECT_LIST_LIMITS.bytes) return tooLarge();
      }
      const result = objectListScalarHandlers[field.type].validate(value, field.config, field.required, options.context);
      if (!result.ok) return fail(t.cell({ row: index + 1, field: field.name, detail: result.error }));
      row[field.id] = result.value;
    }
    for (const step of calculations.plan.steps) {
      const field = config.fields.find((column) => column.id === step.id)!;
      const calculationFailure = (detail: string) => ({
        ok: false as const,
        error: t.cell({ row: index + 1, field: field.name, detail }),
        calculationError: { field: field.name, detail },
      });
      const value = evaluate(step.ast, {
        ...options.context,
        maxStringLength: OBJECT_LIST_LIMITS.bytes,
        fields: row,
        slugToId: calculations.plan.references,
      });
      if (isFormulaError(value)) return calculationFailure(value.code === "DIV_ZERO" ? t.divideByZero : value.code);
      const result = objectListScalarHandlers[field.type].validate(value, field.config, field.required, options.context);
      if (!result.ok) return calculationFailure(result.error);
      row[field.id] = result.value;
    }
    outputBytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + (index > 0 ? 1 : 0);
    if (outputBytes > OBJECT_LIST_LIMITS.bytes) return tooLarge();
    rows.push(row);
  }
  return ok(rows);
};

export const objectListHandler: ValueFieldType = {
  type: "object_list",
  kind: "value",
  configSchema: ObjectListConfigSchema,
  validate: (raw, config, required, context) => validateObjectList(raw, config, required, { context }),
};
