import { describe, expect, test } from "bun:test";
import type { WorkflowBoundPlan, WorkflowInvocation, WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import type { WorkflowVariableScope } from "@valentinkolb/cloud/workflows/runtime";
import type { GridRecord } from "../contracts";
import { GridsWorkflowValueResolver, prepareWorkflowInputs, WorkflowInputPreparationError } from "./workflow-values";

const recordId = "11111111-1111-4111-8111-111111111111";
const otherRecordId = "22222222-2222-4222-8222-222222222222";
const recordShortId = "REC001";
const otherRecordShortId = "REC002";
const tableId = "33333333-3333-4333-8333-333333333333";
const fieldId = "44444444-4444-4444-8444-444444444444";
const targetTableId = "55555555-5555-4555-8555-555555555555";
const relationFieldId = "66666666-6666-4666-8666-666666666666";

const plan: WorkflowBoundPlan = {
  schemaVersion: 2,
  languageId: "grids",
  languageVersion: 1,
  sourceHash: "source",
  manifestHash: "manifest",
  catalogHash: "catalog",
  actionPolicies: {},
  inputs: [
    { name: "item", type: "record", config: { table: "Items", required: true } },
    { name: "items", type: "recordList", config: { table: "Items" } },
    { name: "note", type: "text", config: {} },
  ],
  triggers: [],
  steps: [],
  bindings: {
    "inputs.item.table": tableId,
    "inputs.items.table": tableId,
    "steps.0.setVariable.value": fieldId,
  },
};

describe("workflow kernel inputs", () => {
  test("normalizes record inputs after permission and existence checks", async () => {
    const prepared = await prepareWorkflowInputs(
      plan,
      { item: recordShortId, items: [recordShortId, otherRecordShortId], note: "ready" },
      {
        canReadTable: async (id) => id === tableId,
        resolveRecordIds: async () =>
          new Map([
            [recordShortId, recordId],
            [otherRecordShortId, otherRecordId],
          ]),
      },
    );

    expect(prepared).toEqual({
      item: { kind: "record", tableId, recordId },
      items: [
        { kind: "record", tableId, recordId },
        { kind: "record", tableId, recordId: otherRecordId },
      ],
      note: "ready",
    });
  });

  test("rejects unknown, missing, inaccessible, and absent record inputs", async () => {
    const deps = { canReadTable: async () => true, resolveRecordIds: async () => new Map<string, string>() };
    await expect(prepareWorkflowInputs(plan, { note: "ready" }, deps)).rejects.toThrow('workflow input "item" is required');
    await expect(prepareWorkflowInputs(plan, { item: recordShortId, extra: true }, deps)).rejects.toThrow('unknown workflow input "extra"');
    await expect(prepareWorkflowInputs(plan, { item: recordShortId }, deps)).rejects.toThrow("references missing record");
    await expect(prepareWorkflowInputs(plan, { item: recordId }, deps)).rejects.toThrow("references missing record");
    await expect(prepareWorkflowInputs(plan, { item: recordShortId }, { ...deps, canReadTable: async () => false })).rejects.toThrow(
      "cannot read the input table",
    );
  });

  test("distinguishes invalid input, forbidden records, and infrastructure failures", async () => {
    const invalid = prepareWorkflowInputs(
      plan,
      { note: "ready" },
      {
        canReadTable: async () => true,
        resolveRecordIds: async () => new Map(),
      },
    );
    await expect(invalid).rejects.toMatchObject({ name: "WorkflowInputPreparationError", status: 400 });

    const forbidden = prepareWorkflowInputs(
      plan,
      { item: recordShortId },
      {
        canReadTable: async () => false,
        resolveRecordIds: async () => new Map(),
      },
    );
    await expect(forbidden).rejects.toMatchObject({ name: "WorkflowInputPreparationError", status: 403 });

    const databaseError = new Error("database unavailable");
    await expect(
      prepareWorkflowInputs(
        plan,
        { item: recordShortId },
        {
          canReadTable: async () => true,
          resolveRecordIds: async () => Promise.reject(databaseError),
        },
      ),
    ).rejects.toBe(databaseError);
    expect(databaseError).not.toBeInstanceOf(WorkflowInputPreparationError);
  });
});

describe("workflow kernel value resolver", () => {
  test("rejects direct record IDs from an inaccessible table before reading any record data", async () => {
    let shortIdReads = 0;
    let recordReads = 0;
    const resolver = new GridsWorkflowValueResolver({
      canReadTable: async () => false,
      recordShortId: async () => {
        shortIdReads += 1;
        return recordShortId;
      },
      readRecord: async () => {
        recordReads += 1;
        return null;
      },
    });
    const invocation = {
      workflowId: recordId,
      mode: "execute",
      channel: "api",
      actor: {},
      inputs: { item: { kind: "record", tableId, recordId } },
      idempotencyKey: "denied-record-id",
      occurredAt: new Date(0).toISOString(),
    } satisfies WorkflowInvocation;
    await expect(
      resolver.resolve({
        reference: "inputs.item.recordId",
        path: ["steps", 0, "if", "contains", 1],
        plan,
        invocation,
        variables: { get: () => undefined, has: () => false, set: () => undefined },
        fallback: () => undefined,
      }),
    ).rejects.toThrow("workflow actor cannot read the referenced table");
    expect(shortIdReads).toBe(0);
    expect(recordReads).toBe(0);
  });

  test("loads a bound record field once and leaves structured values to the kernel", async () => {
    let reads = 0;
    const record = {
      id: recordId,
      shortId: recordShortId,
      tableId,
      data: { [fieldId]: "Returned" },
      version: 1,
      deletedAt: null,
      createdBy: null,
      updatedBy: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    } satisfies GridRecord;
    const resolver = new GridsWorkflowValueResolver({
      canReadTable: async () => true,
      recordShortId: async () => recordShortId,
      readRecord: async () => {
        reads += 1;
        return record;
      },
    });
    const invocation = {
      workflowId: recordId,
      mode: "execute",
      channel: "api",
      actor: {},
      inputs: { item: { kind: "record", tableId, recordId }, note: { value: "plain" } },
      idempotencyKey: "run-1",
      occurredAt: new Date(0).toISOString(),
    } satisfies WorkflowInvocation;
    const variables: WorkflowVariableScope = {
      get: () => undefined,
      has: () => false,
      set: () => undefined,
    };
    const resolve = (reference: string, path: Array<string | number>, fallback: WorkflowJsonValue | undefined) =>
      resolver.resolve({ reference, path, plan, invocation, variables, fallback: () => fallback });

    expect(await resolve("inputs.item.Name", ["steps", 0, "setVariable", "value"], undefined)).toEqual({
      state: "resolved",
      value: "Returned",
    });
    expect(await resolve("inputs.item.recordId", ["steps", 0, "if", "contains", 1], undefined)).toEqual({
      state: "resolved",
      value: recordShortId,
    });
    expect(await resolve("inputs.item.Name", ["steps", 0, "setVariable", "value"], undefined)).toEqual({
      state: "resolved",
      value: "Returned",
    });
    expect(await resolve("inputs.note.value", ["steps", 1], "plain")).toEqual({ state: "resolved", value: "plain" });
    expect(await resolve("inputs.missing", ["steps", 2], undefined)).toEqual({ state: "missing" });
    expect(reads).toBe(1);
  });

  test("resolves single and multiple relation fields to authorized record references", async () => {
    const relationPath = ["steps", 0, "updateRecord", "record"];
    const listPath = ["steps", 1, "forEach"];
    const relationPlan: WorkflowBoundPlan = {
      ...plan,
      bindings: {
        ...plan.bindings,
        "steps.0.updateRecord.record": relationFieldId,
        "steps.0.updateRecord.record.$relationTarget": targetTableId,
        "steps.0.updateRecord.record.$relationCardinality": "single",
        "steps.1.forEach": relationFieldId,
        "steps.1.forEach.$relationTarget": targetTableId,
        "steps.1.forEach.$relationCardinality": "multiple",
      },
    };
    const records = new Map<string, GridRecord>([
      [
        `${tableId}:${recordId}`,
        {
          id: recordId,
          shortId: recordShortId,
          tableId,
          data: { [relationFieldId]: [otherRecordId] },
          version: 1,
          deletedAt: null,
          createdBy: null,
          updatedBy: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
      [
        `${targetTableId}:${otherRecordId}`,
        {
          id: otherRecordId,
          shortId: otherRecordShortId,
          tableId: targetTableId,
          data: {},
          version: 1,
          deletedAt: null,
          createdBy: null,
          updatedBy: null,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ],
    ]);
    const resolver = new GridsWorkflowValueResolver({
      canReadTable: async () => true,
      recordShortId: async (_resolvedTableId, resolvedRecordId) =>
        resolvedRecordId === otherRecordId ? otherRecordShortId : recordShortId,
      readRecord: async (resolvedTableId, resolvedRecordId) => records.get(`${resolvedTableId}:${resolvedRecordId}`) ?? null,
    });
    const invocation = {
      workflowId: recordId,
      mode: "execute",
      channel: "api",
      actor: {},
      inputs: { item: { kind: "record", tableId, recordId } },
      idempotencyKey: "relations-1",
      occurredAt: new Date(0).toISOString(),
    } satisfies WorkflowInvocation;
    const variables: WorkflowVariableScope = { get: () => undefined, has: () => false, set: () => undefined };

    expect(
      await resolver.resolve({
        reference: "inputs.item.Current archive",
        path: relationPath,
        plan: relationPlan,
        invocation,
        variables,
        fallback: () => undefined,
      }),
    ).toEqual({ state: "resolved", value: { kind: "record", tableId: targetTableId, recordId: otherRecordId } });
    expect(
      await resolver.resolve({
        reference: "inputs.item.Current archive.recordId",
        path: relationPath,
        plan: relationPlan,
        invocation,
        variables,
        fallback: () => undefined,
      }),
    ).toEqual({ state: "resolved", value: otherRecordShortId });
    expect(
      await resolver.resolve({
        reference: "inputs.item.Related archives",
        path: listPath,
        plan: relationPlan,
        invocation,
        variables,
        fallback: () => undefined,
      }),
    ).toEqual({
      state: "resolved",
      value: [{ kind: "record", tableId: targetTableId, recordId: otherRecordId }],
    });

    const deniedTarget = new GridsWorkflowValueResolver({
      canReadTable: async (resolvedTableId) => resolvedTableId !== targetTableId,
      recordShortId: async () => otherRecordShortId,
      readRecord: async (resolvedTableId, resolvedRecordId) => records.get(`${resolvedTableId}:${resolvedRecordId}`) ?? null,
    });
    expect(
      deniedTarget.resolve({
        reference: "inputs.item.Current archive",
        path: relationPath,
        plan: relationPlan,
        invocation,
        variables,
        fallback: () => undefined,
      }),
    ).rejects.toThrow("cannot read the related table");
  });
});
