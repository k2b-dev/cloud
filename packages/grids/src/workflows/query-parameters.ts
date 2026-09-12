import { z } from "zod";
import {
  type DslQueryContextInput,
  type DslQueryParameterValue,
  GQL_PARAMETER_LIMITS,
  GqlParameterNameSchema,
  GqlParametersSchema,
} from "../query-dsl/parameters";
import { MAX_WORKFLOW_QUERY_ROWS } from "./query-contracts";

export const WORKFLOW_QUERY_PARAMETER_TYPES = ["text", "number", "decimal", "boolean", "date", "dateTime", "record", "recordList"] as const;
export const WorkflowQueryParametersSchema = z
  .record(GqlParameterNameSchema, z.object({ type: z.enum(WORKFLOW_QUERY_PARAMETER_TYPES), value: z.json() }).strict())
  .refine((value) => Object.keys(value).length <= GQL_PARAMETER_LIMITS.names, "At most 100 query parameters are allowed");
export type WorkflowQueryParameters = z.infer<typeof WorkflowQueryParametersSchema>;

const decimal = z
  .string()
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => Number.isFinite(Number(value)));
const record = z.object({ kind: z.literal("record"), tableId: z.string().uuid(), recordId: z.string().uuid() }).strict();
const plannedRecord = record.extend({ recordId: z.string().startsWith("dry-run:").min(9), planned: z.literal(true) });
export type WorkflowQueryRecordParameter = z.infer<typeof record> | z.infer<typeof plannedRecord>;

/** Publication uses values of the declared type, never a caller's sample data. */
export const workflowQueryParameterSamples = (parameters: WorkflowQueryParameters): DslQueryContextInput => {
  const samples: Record<string, DslQueryParameterValue> = {};
  for (const [name, parameter] of Object.entries(parameters)) {
    samples[`params.${name}`] =
      parameter.type === "decimal"
        ? { decimal: "0" }
        : parameter.type === "number"
          ? 0
          : parameter.type === "boolean"
            ? false
            : parameter.type === "recordList"
              ? ["REC001"]
              : parameter.type === "record"
                ? "REC001"
                : parameter.type === "date"
                  ? "2000-01-01"
                  : parameter.type === "dateTime"
                    ? "2000-01-01T00:00:00.000Z"
                    : "";
  }
  return samples;
};

/** Conversion is explicit: an exact decimal is text at the workflow boundary,
 * then a typed GQL literal. A record is authorized and projected by the caller. */
export const resolveWorkflowQueryParameters = async (
  parameters: WorkflowQueryParameters,
  resolveRecords: (records: readonly WorkflowQueryRecordParameter[]) => Promise<readonly string[]>,
  options: { allowPlannedRecords?: boolean } = {},
): Promise<{ ok: true; values: DslQueryContextInput } | { ok: false; parameter: string }> => {
  if (!WorkflowQueryParametersSchema.safeParse(parameters).success) return { ok: false, parameter: "" };
  // Only the planning caller can accept a not-yet-created record. Execution
  // and publication retain the strict persisted-record contract.
  const recordSchema = options.allowPlannedRecords ? z.union([record, plannedRecord]) : record;
  const values: Record<string, DslQueryParameterValue> = {};
  const pendingRecords: Array<{ key: string; references: WorkflowQueryRecordParameter[]; list: boolean }> = [];
  for (const [name, parameter] of Object.entries(parameters)) {
    const key = `params.${name}`;
    const value = parameter.value;
    switch (parameter.type) {
      case "text":
        if (typeof value !== "string" || value.length > GQL_PARAMETER_LIMITS.characters || value.includes("\0"))
          return { ok: false, parameter: name };
        values[key] = value;
        break;
      case "number":
        if (typeof value !== "number" || !Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
          return { ok: false, parameter: name };
        values[key] = value;
        break;
      case "decimal":
        if (!decimal.safeParse(value).success || typeof value !== "string") return { ok: false, parameter: name };
        values[key] = { decimal: value };
        break;
      case "boolean":
        if (typeof value !== "boolean") return { ok: false, parameter: name };
        values[key] = value;
        break;
      case "date":
      case "dateTime": {
        const parsed = (parameter.type === "date" ? z.iso.date() : z.iso.datetime({ offset: true })).safeParse(value);
        if (!parsed.success) return { ok: false, parameter: name };
        values[key] = parsed.data;
        break;
      }
      case "record": {
        const parsed = recordSchema.safeParse(value);
        if (!parsed.success) return { ok: false, parameter: name };
        values[key] = "REC001";
        pendingRecords.push({ key, references: [parsed.data], list: false });
        break;
      }
      case "recordList": {
        const parsed = z.array(recordSchema).max(MAX_WORKFLOW_QUERY_ROWS).safeParse(value);
        if (!parsed.success) return { ok: false, parameter: name };
        values[key] = parsed.data.map(() => "REC001");
        pendingRecords.push({ key, references: parsed.data, list: true });
        break;
      }
    }
  }
  const checked = GqlParametersSchema.safeParse(Object.fromEntries(Object.entries(values).map(([key, value]) => [key.slice(7), value])));
  if (!checked.success) {
    const name = checked.error.issues[0]?.path[0];
    return { ok: false, parameter: typeof name === "string" ? name : "" };
  }
  // Public record IDs all have six characters. Validate the complete resolved
  // size before any authorized lookup, not after thousands of reads.
  const references = [
    ...new Map(
      pendingRecords.flatMap((pending) =>
        pending.references.map((reference) => [`${reference.tableId}:${reference.recordId}`, reference] as const),
      ),
    ).values(),
  ];
  const publicIds = references.length > 0 ? await resolveRecords(references) : [];
  if (publicIds.length !== references.length) return { ok: false, parameter: pendingRecords[0]?.key.slice(7) ?? "" };
  const resolvedRecords = new Map(references.map((reference, index) => [`${reference.tableId}:${reference.recordId}`, publicIds[index]!]));
  for (const pending of pendingRecords) {
    const ids: string[] = [];
    for (const reference of pending.references) {
      const identity = `${reference.tableId}:${reference.recordId}`;
      const id = resolvedRecords.get(identity);
      if (id === undefined || !/^[A-Za-z0-9]{6}$/.test(id)) return { ok: false, parameter: pending.key.slice(7) };
      ids.push(id);
    }
    values[pending.key] = pending.list ? ids : ids[0]!;
  }
  return { ok: true, values };
};
