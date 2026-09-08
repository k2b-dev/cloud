import { getEffectiveGroupIds } from "@valentinkolb/cloud/server";
import type { WorkflowBoundPlan, WorkflowInvocation, WorkflowIrInput, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { workflowPathKey } from "@valentinkolb/cloud/workflows";
import type { WorkflowValueResolution, WorkflowValueResolverPort, WorkflowVariableScope } from "@valentinkolb/cloud/workflows/runtime";
import { sql } from "bun";
import { z } from "zod";
import type { GridRecord } from "../contracts";
import type { GridsWorkflowChannel, GridsWorkflowPrincipal } from "../workflows/contracts";
import { createReader } from "./record-read";
import { SHORT_ID_REGEX } from "./short-id";
import { canAccessWorkflowBaseTable } from "./workflow-authorization";

export type WorkflowRecordReference = {
  kind: "record";
  tableId: string;
  recordId: string;
};

export type { GridsWorkflowPrincipal } from "../workflows/contracts";

type WorkflowInputPreparationDeps = {
  canReadTable: (tableId: string) => Promise<boolean>;
  resolveRecordIds: (tableId: string, publicIds: string[]) => Promise<Map<string, string>>;
};

type WorkflowInputPreparationOptions = {
  trustedRecordIds?: ReadonlyMap<string, ReadonlySet<string>>;
  canReadTable?: (tableId: string) => Promise<boolean>;
};

type WorkflowValueResolverDeps = {
  canReadTable: (tableId: string) => Promise<boolean>;
  readRecord: (tableId: string, recordId: string) => Promise<GridRecord | null>;
  recordShortId: (tableId: string, recordId: string) => Promise<string | null>;
};

export class WorkflowInputPreparationError extends Error {
  override readonly name = "WorkflowInputPreparationError";

  constructor(
    message: string,
    readonly status: 400 | 403 = 400,
  ) {
    super(message);
  }
}

const uuid = z.string().uuid();

export const loadWorkflowUserGroupIds = async (userId: string | null): Promise<string[]> => {
  return getEffectiveGroupIds({ userId });
};

const isRecordReference = (value: WorkflowJsonValue | undefined): value is WorkflowRecordReference =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.kind === "record" &&
      typeof value.tableId === "string" &&
      typeof value.recordId === "string",
  );

const inputTableId = (plan: WorkflowBoundPlan, inputName: string): string | null => {
  const value = plan.bindings[`inputs.${inputName}.table`];
  return typeof value === "string" ? value : null;
};

const requiredInput = (config: Record<string, WorkflowJsonValue>): boolean => config.required === true;

const validateScalar = (type: string, value: WorkflowJsonValue, config: Record<string, WorkflowJsonValue>): string | null => {
  if (type === "text") return typeof value === "string" ? null : "must be text";
  if (type === "number") return typeof value === "number" && Number.isFinite(value) ? null : "must be a finite number";
  if (type === "boolean") return typeof value === "boolean" ? null : "must be true or false";
  if (type === "date") return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? null : "must be a date in YYYY-MM-DD format";
  if (type === "dateTime") {
    return typeof value === "string" && Number.isFinite(Date.parse(value)) ? null : "must be an ISO date-time";
  }
  if (type === "select") {
    const options = Array.isArray(config.options) ? config.options.filter((option): option is string => typeof option === "string") : [];
    return typeof value === "string" && options.includes(value) ? null : "must be one of the configured options";
  }
  return `uses unsupported input type "${type}"`;
};

export const workflowInputShapeError = (input: WorkflowIrInput, value: WorkflowJsonValue | undefined): string | null => {
  if (value === undefined || value === null) return requiredInput(input.config) ? "is required" : null;
  if (input.type === "record") return typeof value === "string" && SHORT_ID_REGEX.test(value) ? null : "must be a record ID";
  if (input.type === "recordList") {
    if (!Array.isArray(value) || value.some((recordId) => typeof recordId !== "string" || !SHORT_ID_REGEX.test(recordId))) {
      return "must contain record IDs";
    }
    return value.length <= 10_000 ? null : "exceeds the 10000 record limit";
  }
  return validateScalar(input.type, value, input.config);
};

const recordReference = (tableId: string, recordId: string): WorkflowRecordReference => ({ kind: "record", tableId, recordId });

const prepareRecordIds = async (
  tableId: string,
  recordIds: string[],
  deps: WorkflowInputPreparationDeps,
): Promise<WorkflowRecordReference[]> => {
  if (!(await deps.canReadTable(tableId))) throw new WorkflowInputPreparationError("workflow actor cannot read the input table", 403);
  if (recordIds.some((recordId) => !SHORT_ID_REGEX.test(recordId) && !uuid.safeParse(recordId).success)) {
    throw new WorkflowInputPreparationError("contains an invalid record ID");
  }
  const uniqueIds = [...new Set(recordIds)];
  const resolvedIds = await deps.resolveRecordIds(tableId, uniqueIds);
  const missing = uniqueIds.find((recordId) => !resolvedIds.has(recordId));
  if (missing) throw new WorkflowInputPreparationError(`references missing record "${missing}"`);
  return recordIds.map((recordId) => recordReference(tableId, resolvedIds.get(recordId)!));
};

export const prepareWorkflowInputs = async (
  plan: WorkflowBoundPlan,
  rawInputs: Record<string, WorkflowJsonValue>,
  deps: WorkflowInputPreparationDeps,
): Promise<Record<string, WorkflowJsonValue>> => {
  const declaredNames = new Set(plan.inputs.map((input) => input.name));
  const unknownName = Object.keys(rawInputs).find((name) => !declaredNames.has(name));
  if (unknownName) throw new WorkflowInputPreparationError(`unknown workflow input "${unknownName}"`);

  const prepared: Record<string, WorkflowJsonValue> = {};
  for (const input of plan.inputs) {
    const value = rawInputs[input.name];
    const shapeError =
      value === undefined || value === null || (input.type !== "record" && input.type !== "recordList")
        ? workflowInputShapeError(input, value)
        : null;
    if (shapeError) throw new WorkflowInputPreparationError(`workflow input "${input.name}" ${shapeError}`);
    if (value === undefined || value === null) {
      continue;
    }
    if (input.type === "record" || input.type === "recordList") {
      if (input.type === "record" && typeof value !== "string") {
        throw new WorkflowInputPreparationError(`workflow input "${input.name}" must be a record ID`);
      }
      if (
        input.type === "recordList" &&
        (!Array.isArray(value) || value.some((recordId) => typeof recordId !== "string") || value.length > 10_000)
      ) {
        throw new WorkflowInputPreparationError(`workflow input "${input.name}" must contain record IDs`);
      }
      const tableId = inputTableId(plan, input.name);
      if (!tableId) throw new WorkflowInputPreparationError(`workflow input "${input.name}" has no bound table`);
      const rawRecordIds = input.type === "record" ? [value] : value;
      const recordIds = rawRecordIds as string[];
      const references = await prepareRecordIds(tableId, recordIds, deps);
      prepared[input.name] = input.type === "record" ? references[0]! : references;
      continue;
    }
    prepared[input.name] = value;
  }
  return prepared;
};

const rootValue = (
  invocation: WorkflowInvocation,
  variables: WorkflowVariableScope,
  reference: string,
): { value: WorkflowJsonValue | undefined; remaining: string[] } => {
  const remaining = reference.split(".");
  const root = remaining.shift() ?? "";
  if (root === "inputs") {
    const inputName = remaining.shift() ?? "";
    return { value: invocation.inputs[inputName], remaining };
  }
  if (root === "context") return { value: invocation.context ?? {}, remaining };
  return { value: variables.get(root), remaining };
};

const valueResolution = (value: WorkflowJsonValue | undefined): WorkflowValueResolution =>
  value === undefined ? { state: "missing" } : { state: "resolved", value };

const relationRecordIds = (value: WorkflowJsonValue, cardinality: "single" | "multiple"): string[] => {
  const values = value === null ? [] : Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string" || !uuid.safeParse(item).success)) {
    throw new Error("workflow relation contains an invalid record ID");
  }
  if (cardinality === "single" && values.length > 1) throw new Error("single workflow relation contains multiple records");
  return values as string[];
};

export class GridsWorkflowValueResolver implements WorkflowValueResolverPort {
  private readonly readableTables = new Map<string, Promise<boolean>>();
  private readonly records = new Map<string, Promise<GridRecord | null>>();
  private readonly recordShortIds = new Map<string, Promise<string | null>>();

  constructor(private readonly deps: WorkflowValueResolverDeps) {}

  private canReadTable(tableId: string): Promise<boolean> {
    let permission = this.readableTables.get(tableId);
    if (!permission) {
      permission = this.deps.canReadTable(tableId);
      this.readableTables.set(tableId, permission);
    }
    return permission;
  }

  private readRecord(tableId: string, recordId: string): Promise<GridRecord | null> {
    const key = `${tableId}:${recordId}`;
    let record = this.records.get(key);
    if (!record) {
      record = this.deps.readRecord(tableId, recordId);
      this.records.set(key, record);
    }
    return record;
  }

  private recordShortId(tableId: string, recordId: string): Promise<string | null> {
    const key = `${tableId}:${recordId}`;
    let shortId = this.recordShortIds.get(key);
    if (!shortId) {
      shortId = this.deps.recordShortId(tableId, recordId);
      this.recordShortIds.set(key, shortId);
    }
    return shortId;
  }

  async resolve(input: {
    reference: string;
    path: Array<string | number>;
    plan: WorkflowBoundPlan;
    invocation: WorkflowInvocation;
    variables: WorkflowVariableScope;
    fallback: () => WorkflowJsonValue | undefined;
  }): Promise<WorkflowValueResolution> {
    const { value, remaining } = rootValue(input.invocation, input.variables, input.reference);
    if (isRecordReference(value) && remaining.length === 1 && remaining[0] === "recordId") {
      if (!(await this.canReadTable(value.tableId))) throw new Error("workflow actor cannot read the referenced table");
      const shortId = await this.recordShortId(value.tableId, value.recordId);
      if (!shortId) throw new Error("referenced workflow record no longer exists");
      return { state: "resolved", value: shortId };
    }
    if (!isRecordReference(value) || remaining.length === 0) return valueResolution(input.fallback());
    const fieldId = input.plan.bindings[workflowPathKey(input.path)];
    if (typeof fieldId !== "string") throw new Error(`workflow field binding is unavailable at "${workflowPathKey(input.path)}"`);
    if (!(await this.canReadTable(value.tableId))) throw new Error("workflow actor cannot read the referenced table");
    let fieldValue: WorkflowJsonValue;
    const snapshots = input.invocation.context?.workflowRecordSnapshots;
    if (snapshots && typeof snapshots === "object" && !Array.isArray(snapshots)) {
      const snapshot = snapshots[`${value.tableId}:${value.recordId}`];
      if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        fieldValue = snapshot[fieldId] ?? null;
      } else {
        const record = await this.readRecord(value.tableId, value.recordId);
        if (!record) throw new Error("referenced workflow record no longer exists");
        fieldValue = (record.data[fieldId] ?? null) as WorkflowJsonValue;
      }
    } else {
      const record = await this.readRecord(value.tableId, value.recordId);
      if (!record) throw new Error("referenced workflow record no longer exists");
      fieldValue = (record.data[fieldId] ?? null) as WorkflowJsonValue;
    }
    const targetTableId = input.plan.bindings[workflowPathKey([...input.path, "$relationTarget"])];
    const cardinality = input.plan.bindings[workflowPathKey([...input.path, "$relationCardinality"])];
    if (typeof targetTableId !== "string" || (cardinality !== "single" && cardinality !== "multiple")) {
      return { state: "resolved", value: fieldValue };
    }
    if (!(await this.canReadTable(targetTableId))) throw new Error("workflow actor cannot read the related table");
    const recordIds = relationRecordIds(fieldValue, cardinality);
    for (const recordId of recordIds) {
      if (!(await this.readRecord(targetTableId, recordId))) throw new Error("related workflow record no longer exists");
    }
    const references = recordIds.map((recordId) => recordReference(targetTableId, recordId));
    const resolvedRelation = cardinality === "single" ? (references[0] ?? null) : references;
    if (remaining.length === 1) return { state: "resolved", value: resolvedRelation };
    if (remaining.length === 2 && remaining[1] === "recordId" && cardinality === "single") {
      const reference = references[0];
      if (!reference) return { state: "resolved", value: null };
      const shortId = await this.recordShortId(reference.tableId, reference.recordId);
      if (!shortId) throw new Error("related workflow record no longer exists");
      return { state: "resolved", value: shortId };
    }
    throw new Error(`workflow relation does not support path "${remaining.slice(1).join(".")}"`);
  }
}

const tableReadChecker = (baseId: string, principal: GridsWorkflowPrincipal, override?: (tableId: string) => Promise<boolean>) => {
  const cache = new Map<string, Promise<boolean>>();
  return (tableId: string): Promise<boolean> => {
    let access = cache.get(tableId);
    if (!access) {
      access = override ? override(tableId) : canAccessWorkflowBaseTable(principal, { baseId, tableId }, "read");
      cache.set(tableId, access);
    }
    return access;
  };
};

export const createWorkflowInputPreparationDeps = (
  baseId: string,
  principal: GridsWorkflowPrincipal,
  options: WorkflowInputPreparationOptions = {},
): WorkflowInputPreparationDeps => {
  const canReadTable = tableReadChecker(baseId, principal, options.canReadTable);
  return {
    canReadTable,
    resolveRecordIds: async (tableId, publicIds) => {
      if (publicIds.length === 0) return new Map();
      if (!(await canReadTable(tableId))) return new Map();
      const shortIds = publicIds.filter((id) => SHORT_ID_REGEX.test(id));
      const rows = await sql<Array<{ id: string; short_id: string }>>`
        SELECT r.id::text AS id, r.short_id
        FROM grids.records r
        JOIN grids.tables t ON t.id = r.table_id AND t.deleted_at IS NULL
        JOIN grids.bases b ON b.id = t.base_id AND b.deleted_at IS NULL
        WHERE r.table_id = ${tableId}::uuid
          AND r.short_id = ANY(${sql.array(shortIds, "TEXT")}::text[])
          AND r.deleted_at IS NULL
      `;
      const ids = new Map(rows.map((record) => [record.short_id, record.id]));
      const trusted = options.trustedRecordIds?.get(tableId);
      if (trusted) for (const recordId of publicIds) if (trusted.has(recordId)) ids.set(recordId, recordId);
      return ids;
    },
  };
};

export const createGridsWorkflowValueResolver = (
  baseId: string,
  principal: GridsWorkflowPrincipal,
  options: Pick<WorkflowInputPreparationOptions, "canReadTable"> = {},
): GridsWorkflowValueResolver => {
  const readers = new Map<string, ReturnType<typeof createReader>>();
  const canReadTable = tableReadChecker(baseId, principal, options.canReadTable);
  return new GridsWorkflowValueResolver({
    canReadTable,
    recordShortId: async (tableId, recordId) => {
      const [row] = await sql<Array<{ short_id: string }>>`
        SELECT short_id
        FROM grids.records
        WHERE table_id = ${tableId}::uuid AND id = ${recordId}::uuid AND deleted_at IS NULL
      `;
      return row?.short_id ?? null;
    },
    readRecord: async (tableId, recordId) => {
      let reader = readers.get(tableId);
      if (!reader) {
        if (!(await canReadTable(tableId))) return null;
        reader = createReader(tableId, {
          viewer: {
            userId: principal.userId,
            userGroups: principal.groupIds,
            serviceAccountId: principal.serviceAccountId,
          },
        });
        readers.set(tableId, reader);
      }
      return (await reader).get(recordId);
    },
  });
};

/**
 * A value resolver for a run whose scope has not been read yet.
 *
 * A worker builds one of these per run it claims, before it knows whose grants
 * the run acts under — that lives on the run row. So the real resolver is built
 * the first time a step asks for a value, and kept for the rest of the run: its
 * caches (which tables the actor may read, which records it already read) are
 * worth exactly one run and no longer.
 */
export const createGridsWorkflowValueResolverPort = (load: () => Promise<GridsWorkflowValueResolver>): WorkflowValueResolverPort => {
  let resolver: Promise<GridsWorkflowValueResolver> | null = null;
  return {
    resolve: async (input) => {
      resolver ??= load();
      return (await resolver).resolve(input);
    },
  };
};

export const workflowPrincipalFromInvocation = (invocation: WorkflowInvocation<GridsWorkflowChannel>): GridsWorkflowPrincipal => ({
  userId: invocation.actor.userId ?? null,
  groupIds: invocation.actor.groupIds ?? [],
  serviceAccountId: invocation.actor.serviceAccountId ?? null,
});
