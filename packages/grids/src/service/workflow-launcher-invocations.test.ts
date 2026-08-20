import { describe, expect, mock, test } from "bun:test";
import { err, fail, ok } from "@k2b/stdlib";
import type { WorkflowInvocationReceipt } from "@valentinkolb/cloud/workflows";
import type { GridsWorkflow, GridsWorkflowLauncher, GridsWorkflowLauncherConfig } from "../workflows/contracts";
import { ALL_RECORD_ACCESS } from "./record-access";
import {
  admitBulkLauncher,
  admitRecordLauncher,
  invokeBulkLauncher,
  invokeCustomAppLauncher,
  invokeRecordLauncher,
  invokeScannerLauncher,
  type WorkflowLauncherInvocationDeps,
} from "./workflow-launcher-invocations";

const baseId = "10000000-0000-4000-8000-000000000001";
const workflowId = "20000000-0000-4000-8000-000000000002";
const launcherId = "30000000-0000-4000-8000-000000000003";
const tableId = "40000000-0000-4000-8000-000000000004";
const recordId = "50000000-0000-4000-8000-000000000005";
const secondRecordId = "60000000-0000-4000-8000-000000000006";
const userId = "70000000-0000-4000-8000-000000000007";

const principal = {
  userId,
  groupIds: [],
  serviceAccountId: null,
  actorServiceAccountId: null,
  credential: null,
};

const workflow = (inputName = "record", inputType = "record"): GridsWorkflow =>
  ({
    id: workflowId,
    shortId: "W1234",
    baseId,
    name: "Kernel launcher workflow",
    description: null,
    source: "steps: []",
    plan: {
      schemaVersion: 2,
      languageId: "grids",
      languageVersion: 1,
      sourceHash: "source",
      manifestHash: "manifest",
      catalogHash: "catalog",
      actionPolicies: {},
      inputs: [{ name: inputName, type: inputType, config: { table: "Records", required: true } }],
      triggers: [],
      steps: [],
      bindings: { [`inputs.${inputName}.table`]: tableId },
    },
    diagnostics: [],
    enabled: true,
    position: 0,
    revision: 3,
    ownerUserId: userId,
    deletedAt: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  }) as GridsWorkflow;

const launcher = (config: GridsWorkflowLauncherConfig, overrides: Partial<GridsWorkflowLauncher> = {}): GridsWorkflowLauncher => ({
  id: launcherId,
  shortId: "L1234",
  baseId,
  workflowId,
  name: "Launcher",
  config,
  enabled: true,
  validatedRevision: 3,
  diagnostics: [],
  deletedAt: null,
  createdAt: "2026-07-14T00:00:00.000Z",
  updatedAt: "2026-07-14T00:00:00.000Z",
  ...overrides,
});

const receipt: WorkflowInvocationReceipt = {
  runId: "80000000-0000-4000-8000-000000000008",
  workflowId,
  revision: "3",
  mode: "execute",
  channel: "scanner",
  created: true,
  status: "queued",
};

const scannerInput = (overrides: Record<string, unknown> = {}) => ({
  launcherId,
  operationId: "scan-1",
  mode: "execute",
  expectedRevision: 3,
  principal,
  inputs: {},
  scannedText: "gsc_opaque",
  ...overrides,
});

const bulkInput = (overrides: Record<string, unknown> = {}) => ({
  launcherId,
  operationId: "bulk-1",
  mode: "execute",
  expectedRevision: 3,
  principal,
  inputs: {},
  recordIds: [recordId],
  ...overrides,
});

const customAppInput = (overrides: Record<string, unknown> = {}) => ({
  launcherId,
  operationId: "custom-app-1",
  mode: "execute",
  expectedRevision: 3,
  principal,
  inputs: {},
  ...overrides,
});

const recordInput = (overrides: Record<string, unknown> = {}) => ({
  launcherId,
  operationId: "record-1",
  mode: "execute",
  expectedRevision: 3,
  principal,
  inputs: {},
  recordId,
  ...overrides,
});

const setup = (
  configuredLauncher: GridsWorkflowLauncher,
  configuredWorkflow: GridsWorkflow,
  overrides: Partial<WorkflowLauncherInvocationDeps> = {},
) => {
  const invokeWorkflow = mock<WorkflowLauncherInvocationDeps["invokeWorkflow"]>(async () => ok(receipt));
  const authorize = mock(async () => ok(ALL_RECORD_ACCESS));
  const resolveScanCode = mock(async () => ok(recordId));
  const resolveUniqueField = mock(async () => ok(recordId));
  const resolveExplicitRecordIds = mock(async (_baseId: string, _tableId: string, ids: string[]) => ok(ids));
  const resolveQueryRecordIds = mock(async () => ok([recordId, secondRecordId]));
  const deps: WorkflowLauncherInvocationDeps = {
    getLauncher: mock(async () => configuredLauncher),
    getWorkflow: mock(async () => configuredWorkflow),
    authorize,
    resolveScanCode,
    resolveUniqueField,
    resolveExplicitRecordIds,
    resolveQueryRecordIds,
    invokeWorkflow,
    ...overrides,
  };
  return {
    deps,
    invokeWorkflow,
    authorize: deps.authorize,
    resolveScanCode,
    resolveUniqueField,
    resolveExplicitRecordIds,
    resolveQueryRecordIds,
  };
};

describe("workflow kernel scanner launchers", () => {
  test("resolves opaque scan URLs and uses stable per-operation idempotency", async () => {
    const item = setup(
      launcher({
        kind: "scanner",
        inputSources: {
          record: { kind: "scan", value: "record", resolve: { by: "scanCode" } },
          note: { kind: "session" },
        },
      }),
      workflow(),
    );
    const input = scannerInput({
      scannedText: "https://cloud.example/app/grids/scan?code=gsc_opaque",
      inputs: { note: "accepted" },
    });

    const first = await invokeScannerLauncher(input, item.deps);
    const second = await invokeScannerLauncher(input, item.deps);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(item.resolveScanCode).toHaveBeenCalledWith(baseId, tableId, "gsc_opaque", ALL_RECORD_ACCESS);
    expect(item.invokeWorkflow).toHaveBeenCalledTimes(2);
    const calls = item.invokeWorkflow.mock.calls;
    expect(calls[0]![0]).toMatchObject({
      workflowId,
      launcherId,
      channel: "scanner",
      expectedRevision: 3,
      idempotencyKey: `launcher:${launcherId}:scan-1`,
      inputs: { note: "accepted", record: recordId },
      trustedRecordIds: new Map([[tableId, new Set([recordId])]]),
      context: { launcher: { id: launcherId, kind: "scanner", operationId: "scan-1" } },
    });
    expect(calls[1]![0].idempotencyKey).toBe(calls[0]![0].idempotencyKey);
  });

  test("uses only the configured unique-field resolver", async () => {
    const item = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "field", field: "Asset code" } }), workflow());

    const result = await invokeScannerLauncher(scannerInput({ scannedText: "A-42" }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.resolveUniqueField).toHaveBeenCalledWith(baseId, tableId, "Asset code", "A-42", ALL_RECORD_ACCESS);
    expect(item.resolveScanCode).not.toHaveBeenCalled();
  });

  test("passes arbitrary session and after-scan values while protecting scan and fixed inputs", async () => {
    const item = setup(
      launcher({
        kind: "scanner",
        inputSources: {
          target: { kind: "scan", value: "text" },
          context: { kind: "session" },
          assessment: { kind: "afterScan" },
          station: { kind: "fixed", value: "north" },
        },
      }),
      workflow("target", "text"),
    );

    const result = await invokeScannerLauncher(
      scannerInput({
        scannedText: "  ITEM-42  ",
        inputs: { context: "agreement-1", assessment: "damaged" },
      }),
      item.deps,
    );
    const override = await invokeScannerLauncher(scannerInput({ inputs: { target: "forged" } }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.resolveScanCode).not.toHaveBeenCalled();
    expect(item.resolveUniqueField).not.toHaveBeenCalled();
    expect(item.invokeWorkflow.mock.calls[0]?.[0].inputs).toEqual({
      target: "ITEM-42",
      context: "agreement-1",
      assessment: "damaged",
      station: "north",
    });
    expect(override.ok).toBe(false);
    if (!override.ok) expect(override.error.message).toContain('"target" is not supplied by the scanner user');
  });

  test("checks current workflow and table permissions before resolution", async () => {
    const item = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "scanCode" } }), workflow(), {
      authorize: mock(async () => fail(err.forbidden("denied"))),
    });

    const result = await invokeScannerLauncher(scannerInput(), item.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(403);
    expect(item.resolveScanCode).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("rejects stale and structurally invalid launcher configs", async () => {
    const stale = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "scanCode" } }, { validatedRevision: 2 }), workflow());
    const invalid = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "scanCode", field: "unexpected" } }), workflow());

    const staleResult = await invokeScannerLauncher(scannerInput(), stale.deps);
    const invalidResult = await invokeScannerLauncher(scannerInput(), invalid.deps);

    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) expect(staleResult.error.status).toBe(409);
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) expect(invalidResult.error.message).toContain("does not accept a field");
  });

  test("strictly rejects unknown invocation properties", async () => {
    const item = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "scanCode" } }), workflow());

    const result = await invokeScannerLauncher(scannerInput({ unexpected: true }), item.deps);

    expect(result.ok).toBe(false);
    expect(item.authorize).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("passes exact Grids App scanner provenance to authorization", async () => {
    const item = setup(launcher({ kind: "scanner", input: "record", resolve: { by: "scanCode" } }), workflow());
    const authorization = {
      kind: "custom-app-scanner" as const,
      customAppId: "90000000-0000-4000-8000-000000000009",
      publishedAt: "2026-08-13T12:00:00.000Z",
      pageId: "returns",
      pageParams: {},
      timeZone: "Europe/Berlin",
      blockId: "scanner",
      revision: 3,
      configHash: "a".repeat(64),
    };

    const result = await invokeScannerLauncher(scannerInput({ authorization }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.authorize).toHaveBeenCalledWith({ launcherId, workflow: expect.anything(), principal, tableId, authorization });
  });
});

describe("workflow kernel bulk launchers", () => {
  test("admits the launcher principal before a public route resolves Record IDs", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"), {
      authorize: mock(async () => fail(err.forbidden("denied"))),
    });

    const result = await admitBulkLauncher({ launcherId, expectedRevision: 3, principal }, item.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.status).toBe(403);
    expect(item.authorize).toHaveBeenCalledTimes(1);
    expect(item.resolveExplicitRecordIds).not.toHaveBeenCalled();
  });

  test("enforces non-empty, UUID, and maximum-count boundaries", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));
    const tooManyIds = Array.from({ length: 10_001 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);

    const empty = await invokeBulkLauncher(bulkInput({ recordIds: [] }), item.deps);
    const invalidUuid = await invokeBulkLauncher(bulkInput({ recordIds: ["not-a-uuid"] }), item.deps);
    const tooMany = await invokeBulkLauncher(bulkInput({ recordIds: tooManyIds }), item.deps);

    expect(empty.ok).toBe(false);
    expect(invalidUuid.ok).toBe(false);
    expect(tooMany.ok).toBe(false);
    expect(item.resolveExplicitRecordIds).not.toHaveBeenCalled();
  });

  test("rejects duplicate UUIDs and missing records before invocation", async () => {
    const duplicate = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));
    const missing = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"), {
      resolveExplicitRecordIds: mock(async () => fail(err.notFound("bulk selection record"))),
    });

    const duplicateResult = await invokeBulkLauncher(bulkInput({ recordIds: [recordId, recordId] }), duplicate.deps);
    const missingResult = await invokeBulkLauncher(bulkInput({ recordIds: [recordId, secondRecordId] }), missing.deps);

    expect(duplicateResult.ok).toBe(false);
    if (!duplicateResult.ok) expect(duplicateResult.error.message).toContain("must be unique");
    expect(duplicate.resolveExplicitRecordIds).not.toHaveBeenCalled();
    expect(missingResult.ok).toBe(false);
    if (!missingResult.ok) expect(missingResult.error.status).toBe(404);
    expect(missing.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("uses the SQL-backed query selector without JavaScript target filtering", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));

    const { recordIds: _recordIds, ...queryInput } = bulkInput({ query: { limit: 2 } });
    const result = await invokeBulkLauncher(queryInput, item.deps);

    expect(result.ok).toBe(true);
    expect(item.resolveQueryRecordIds).toHaveBeenCalledWith(tableId, { limit: 2 }, principal, ALL_RECORD_ACCESS);
    expect(item.resolveExplicitRecordIds).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "bulk",
        idempotencyKey: `launcher:${launcherId}:bulk-1`,
        inputs: { records: [recordId, secondRecordId] },
        trustedRecordIds: new Map([[tableId, new Set([recordId, secondRecordId])]]),
      }),
    );
  });

  test("Close selection bulk launchers reject query-shaped runs", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records", profile: "closeSelection" }), workflow("records", "recordList"));
    const { recordIds: _recordIds, ...queryInput } = bulkInput({ query: { limit: 2 } });

    const result = await invokeBulkLauncher(queryInput, item.deps);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("explicit Record selection");
    expect(item.authorize).not.toHaveBeenCalled();
    expect(item.resolveQueryRecordIds).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("Close selection requires and forwards the previewed Finalization policy", async () => {
    const configuredWorkflow = workflow("records", "recordList");
    configuredWorkflow.plan.inputs.push(
      { name: "closeMode", type: "text", config: { required: true } },
      { name: "closePolicyRevision", type: "number", config: { required: true } },
    );
    const item = setup(
      launcher({
        kind: "bulk",
        input: "records",
        profile: "closeSelection",
      }),
      configuredWorkflow,
    );

    const missing = await invokeBulkLauncher(bulkInput({ recordIds: [recordId] }), item.deps);
    const missingRevision = await invokeBulkLauncher(bulkInput({ recordIds: [recordId], inputs: { closeMode: "fourEyes" } }), item.deps);
    const accepted = await invokeBulkLauncher(
      bulkInput({ recordIds: [recordId], inputs: { closeMode: "fourEyes", closePolicyRevision: 3 } }),
      item.deps,
    );

    expect(missing.ok).toBe(false);
    expect(missingRevision.ok).toBe(false);
    expect(accepted.ok).toBe(true);
    expect(item.invokeWorkflow).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputs: { records: [recordId], closeMode: "fourEyes", closePolicyRevision: 3 } }),
    );
  });

  test("passes exact Grids App bulk provenance to authorization and the runtime", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));
    const authorization = {
      kind: "custom-app-bulk-action" as const,
      customAppId: "90000000-0000-4000-8000-000000000009",
      publishedAt: "2026-08-13T12:00:00.000Z",
      pageId: "requests",
      pageParams: {},
      timeZone: "Europe/Berlin",
      blockId: "records",
      actionId: "approve",
      recordIds: [recordId],
      revision: 3,
    };

    const result = await invokeBulkLauncher(bulkInput({ recordIds: [recordId], authorization }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.authorize).toHaveBeenCalledWith(expect.objectContaining({ authorization }));
    expect(item.invokeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ launcherId, authorization }));
  });

  test("rejects a Grids App bulk payload outside its authorized selection", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));
    const authorization = {
      kind: "custom-app-bulk-action" as const,
      customAppId: "90000000-0000-4000-8000-000000000009",
      publishedAt: "2026-08-13T12:00:00.000Z",
      pageId: "requests",
      pageParams: {},
      timeZone: "UTC",
      blockId: "records",
      actionId: "approve",
      recordIds: [recordId],
      revision: 3,
    };

    const result = await invokeBulkLauncher(bulkInput({ recordIds: [secondRecordId], authorization }), item.deps);

    expect(result.ok).toBe(false);
    expect(item.authorize).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("rejects invalid UUIDs and selections above the 10000-record limit", async () => {
    const item = setup(launcher({ kind: "bulk", input: "records" }), workflow("records", "recordList"));
    const tooManyIds = Array.from(
      { length: 10_001 },
      (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
    );

    const invalidUuid = await invokeBulkLauncher(bulkInput({ recordIds: ["not-a-uuid"] }), item.deps);
    const tooMany = await invokeBulkLauncher(bulkInput({ recordIds: tooManyIds }), item.deps);

    expect(invalidUuid.ok).toBe(false);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error.message).toContain("10000");
    expect(item.resolveExplicitRecordIds).not.toHaveBeenCalled();
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflow kernel Record launchers", () => {
  test("admits access before Record resolution and invokes with only the controlled Record", async () => {
    const item = setup(launcher({ kind: "record", input: "record", profile: "correctionDraft" }), workflow());

    const admission = await admitRecordLauncher({ launcherId, expectedRevision: 3, principal }, item.deps);
    const result = await invokeRecordLauncher(recordInput(), item.deps);

    expect(admission.ok).toBe(true);
    expect(result.ok).toBe(true);
    expect(item.resolveExplicitRecordIds).toHaveBeenCalledWith(baseId, tableId, [recordId], ALL_RECORD_ACCESS);
    expect(item.invokeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "record",
        idempotencyKey: `launcher:${launcherId}:record-1`,
        inputs: { record: recordId },
        trustedRecordIds: new Map([[tableId, new Set([recordId])]]),
      }),
    );
  });

  test("rejects extra inputs and inaccessible Records before invocation", async () => {
    const item = setup(launcher({ kind: "record", input: "record", profile: "correctionDraft" }), workflow(), {
      resolveExplicitRecordIds: mock(async () => fail(err.notFound("Record"))),
    });

    const extra = await invokeRecordLauncher(recordInput({ inputs: { forged: "value" } }), item.deps);
    const missing = await invokeRecordLauncher(recordInput(), item.deps);

    expect(extra.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.status).toBe(404);
    expect(item.invokeWorkflow).not.toHaveBeenCalled();
  });

  test("hides inaccessible Record launchers before status and revision diagnostics", async () => {
    const variants = [
      launcher({ kind: "record", input: "record", profile: "correctionDraft" }),
      launcher({ kind: "record", input: "record", profile: "correctionDraft" }, { enabled: false }),
      launcher({ kind: "record", input: "record", profile: "correctionDraft" }, { validatedRevision: 2 }),
    ];

    for (const configuredLauncher of variants) {
      const item = setup(configuredLauncher, workflow(), {
        authorize: mock(async () => fail(err.forbidden("denied"))),
      });
      const result = await invokeRecordLauncher(recordInput({ expectedRevision: 99 }), item.deps);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.status).toBe(404);
        expect(result.error.message).toBe("Workflow launcher not found");
      }
      expect(item.resolveExplicitRecordIds).not.toHaveBeenCalled();
      expect(item.invokeWorkflow).not.toHaveBeenCalled();
    }

    const unknown = setup(launcher({ kind: "record", input: "record", profile: "correctionDraft" }), workflow(), {
      getLauncher: mock(async () => null),
    });
    const missing = await invokeRecordLauncher(recordInput({ expectedRevision: 99 }), unknown.deps);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.status).toBe(404);
      expect(missing.error.message).toBe("Workflow launcher not found");
    }
    expect(unknown.authorize).not.toHaveBeenCalled();
    expect(unknown.resolveExplicitRecordIds).not.toHaveBeenCalled();
    expect(unknown.invokeWorkflow).not.toHaveBeenCalled();
  });
});

describe("workflow kernel Grids App launchers", () => {
  test("uses only stored bindings for fixed launchers", async () => {
    const configuredWorkflow = workflow("message", "text");
    configuredWorkflow.plan.inputs.push({ name: "count", type: "number", config: {} });
    const item = setup(
      launcher({ kind: "customApp", inputMode: "fixed", inputBindings: { message: "Run report", count: 2 } }),
      configuredWorkflow,
    );

    const result = await invokeCustomAppLauncher(customAppInput(), item.deps);

    expect(result.ok).toBe(true);
    expect(item.invokeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "customApp",
        idempotencyKey: `launcher:${launcherId}:custom-app-1`,
        inputs: { message: "Run report", count: 2 },
      }),
    );
  });

  test("uses only runtime inputs for prompt launchers", async () => {
    const item = setup(launcher({ kind: "customApp", inputMode: "prompt" }), workflow("message", "text"));

    const result = await invokeCustomAppLauncher(customAppInput({ inputs: { message: "Run report" } }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.invokeWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: { message: "Run report" },
      }),
    );
  });

  test("passes server-trusted Grids App action authorization to the runtime", async () => {
    const item = setup(launcher({ kind: "customApp", inputMode: "prompt" }), workflow("message", "text"));
    const authorization = {
      kind: "custom-app-action" as const,
      customAppId: "90000000-0000-4000-8000-000000000009",
      publishedAt: "2026-08-13T12:00:00.000Z",
      pageId: "request",
      pageParams: { request_id: "90000000-0000-4000-8000-000000000008" },
      timeZone: "Europe/Berlin",
      blockId: "actions",
      actionId: "approve",
      revision: 3,
    };

    const result = await invokeCustomAppLauncher(customAppInput({ inputs: { message: "Approve" }, authorization }), item.deps);

    expect(result.ok).toBe(true);
    expect(item.authorize).toHaveBeenCalledWith(expect.objectContaining({ authorization }));
    expect(item.invokeWorkflow).toHaveBeenCalledWith(expect.objectContaining({ launcherId, authorization }));
  });

  test("rejects unknown bindings and runtime inputs for fixed launchers", async () => {
    const unknown = setup(
      launcher({ kind: "customApp", inputMode: "fixed", inputBindings: { missing: true } }),
      workflow("message", "text"),
    );
    const fixed = setup(
      launcher({ kind: "customApp", inputMode: "fixed", inputBindings: { message: "configured" } }),
      workflow("message", "text"),
    );

    const unknownResult = await invokeCustomAppLauncher(customAppInput(), unknown.deps);
    const fixedResult = await invokeCustomAppLauncher(customAppInput({ inputs: { message: "override" } }), fixed.deps);

    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) expect(unknownResult.error.message).toContain("unknown workflow input");
    expect(fixedResult.ok).toBe(false);
    if (!fixedResult.ok) expect(fixedResult.error.message).toContain("do not accept runtime inputs");
    expect(unknown.invokeWorkflow).not.toHaveBeenCalled();
    expect(fixed.invokeWorkflow).not.toHaveBeenCalled();
  });
});
