import { describe, expect, test } from "bun:test";
import type { AuthContext } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import {
  BulkLauncherRequestSchema,
  PublicGridsWorkflowEmailDeliveryListSchema,
  PublicGridsWorkflowRunSchema,
  PublicWorkflowInvocationReceiptSchema,
  RecordLauncherRequestSchema,
  toPublicWorkflowRuns,
  WorkflowRunsQuerySchema,
} from "./workflow-api-shared";
import { createWorkflowRunRoutes } from "./workflow-run-routes";
import { createWorkflowTriggerRoutes, DIRECT_WORKFLOW_CHANNEL } from "./workflow-trigger-routes";

const directInvocation = {
  idempotencyKey: "invalid-id-test",
  mode: "execute",
  inputs: {},
};

const app = () => new Hono<AuthContext>().route("/workflows", createWorkflowRunRoutes()).route("/workflows", createWorkflowTriggerRoutes());

describe("workflow route contracts", () => {
  test("uses one canonical channel for every direct external invocation route", () => {
    expect(DIRECT_WORKFLOW_CHANNEL).toBe("api");
  });

  test("rejects malformed public base, workflow, launcher, and run ids before service calls", async () => {
    const requests = [
      app().request("/workflows/by-base/not-a-uuid/runs"),
      app().request("/workflows/not-a-uuid/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(directInvocation),
      }),
      app().request("/workflows/launchers/not-a-uuid/invoke/scanner", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "invalid-id-test",
          mode: "execute",
          expectedRevision: 1,
          scannedText: "gsc_opaque",
          inputs: {},
        }),
      }),
      app().request("/workflows/launchers/not-a-uuid/invoke/record", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId: "invalid-id-test",
          mode: "execute",
          expectedRevision: 1,
          recordId: "Rec001",
          inputs: {},
        }),
      }),
      app().request("/workflows/runs/not-a-uuid"),
      app().request("/workflows/runs/not-a-uuid/cancel", { method: "POST" }),
    ];

    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400, 400, 400]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([
      { message: "Invalid base id" },
      { message: "Invalid workflow id" },
      { message: "Invalid workflow launcher id" },
      { message: "Invalid workflow launcher id" },
      { message: "Invalid workflow run id" },
      { message: "Invalid workflow run id" },
    ]);
  });

  test("publishes only six-character public IDs in workflow DTOs", async () => {
    const internalRunId = "11111111-1111-4111-8111-111111111111";
    const internalWorkflowId = "22222222-2222-4222-8222-222222222222";
    const internalUserId = "33333333-3333-4333-8333-333333333333";
    const internalRecordId = "44444444-4444-4444-8444-444444444444";
    const internalBaseId = "55555555-5555-4555-8555-555555555555";
    const internalTableId = "66666666-6666-4666-8666-666666666666";
    const run = {
      id: internalRunId,
      workflowId: internalWorkflowId,
      launcherId: null,
      baseId: internalBaseId,
      workflowRevision: 1,
      mode: "execute",
      channel: "api",
      actorUserId: internalUserId,
      serviceAccountId: null,
      inputs: { recordId: internalRecordId },
      status: "queued",
      result: { kind: "record", tableId: internalTableId, recordId: internalRecordId },
      error: null,
      resultMessage: null,
      createdAt: "2026-08-15T12:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    } as const;

    const projected = await toPublicWorkflowRuns([run], async (type, ids) => {
      const values: Partial<Record<typeof type, Record<string, string>>> = {
        workflowRun: { [internalRunId]: "run001" },
        workflow: { [internalWorkflowId]: "work01" },
        record: { [internalRecordId]: "rec001" },
        base: { [internalBaseId]: "base01" },
        table: { [internalTableId]: "tabl01" },
      };
      return new Map(ids.flatMap((id) => (values[type]?.[id] ? [[id, values[type]![id]!]] : [])));
    });

    expect(projected[0]).toMatchObject({
      id: "run001",
      workflowId: "work01",
      baseId: "base01",
      actorUserId: internalUserId,
      inputs: { recordId: "rec001" },
      result: { kind: "record", tableId: "tabl01", recordId: "rec001" },
    });
    expect(PublicGridsWorkflowRunSchema.safeParse(projected[0]).success).toBe(true);
    expect(PublicGridsWorkflowRunSchema.safeParse({ ...projected[0], id: internalRunId }).success).toBe(false);
    expect(
      RecordLauncherRequestSchema.safeParse({
        operationId: "correction-1",
        mode: "execute",
        expectedRevision: 3,
        recordId: "Rec001",
        inputs: {},
      }).success,
    ).toBe(true);
    expect(
      PublicWorkflowInvocationReceiptSchema.safeParse({
        runId: "run001",
        workflowId: "work01",
        revision: "1",
        mode: "execute",
        channel: "api",
        created: true,
        status: "queued",
      }).success,
    ).toBe(true);
    expect(
      PublicGridsWorkflowEmailDeliveryListSchema.safeParse({
        items: [
          {
            workflowId: "work01",
            workflowRunId: "run001",
            templateId: "mail01",
            subject: "Hello",
            recipients: [],
            status: "sent",
            error: null,
            createdAt: "2026-08-15T12:00:00.000Z",
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  test("accepts public workflow filters and bulk record IDs, never UUIDs", () => {
    expect(WorkflowRunsQuerySchema.safeParse({ workflowId: "work01" }).success).toBe(true);
    expect(WorkflowRunsQuerySchema.safeParse({ workflowId: "22222222-2222-4222-8222-222222222222" }).success).toBe(false);
    expect(
      BulkLauncherRequestSchema.safeParse({
        operationId: "bulk",
        mode: "execute",
        inputs: {},
        recordIds: ["rec001"],
      }).success,
    ).toBe(true);
    expect(
      BulkLauncherRequestSchema.safeParse({
        operationId: "bulk",
        mode: "execute",
        inputs: {},
        recordIds: ["44444444-4444-4444-8444-444444444444"],
      }).success,
    ).toBe(false);
  });

  test("publishes actual run-route error statuses in OpenAPI", async () => {
    const spec = await generateSpecs(app());

    expect(Object.keys(spec.paths?.["/workflows/by-base/{baseId}/runs"]?.get?.responses ?? {})).toEqual(["200", "400", "403", "404"]);
    expect(Object.keys(spec.paths?.["/workflows/runs/{runId}/steps"]?.get?.responses ?? {})).toEqual(["200", "400", "403", "404"]);
    expect(Object.keys(spec.paths?.["/workflows/runs/{runId}/cancel"]?.post?.responses ?? {})).toEqual(["200", "400", "403", "404"]);
  });

  test("publishes infrastructure failures for workflow invocation routes", async () => {
    const spec = await generateSpecs(app());

    expect(Object.keys(spec.paths?.["/workflows/{workflowId}/invoke"]?.post?.responses ?? {})).toEqual([
      "200",
      "400",
      "403",
      "404",
      "409",
      "500",
    ]);
    expect(Object.keys(spec.paths?.["/workflows/launchers/{launcherId}/invoke/scanner"]?.post?.responses ?? {})).toEqual([
      "200",
      "400",
      "403",
      "404",
      "409",
      "500",
    ]);
    expect(Object.keys(spec.paths?.["/workflows/launchers/{launcherId}/invoke/record"]?.post?.responses ?? {})).toEqual([
      "200",
      "400",
      "403",
      "404",
      "409",
      "500",
    ]);
  });
});
