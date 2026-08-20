import { ok } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, jsonResponse, respond, v } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { z } from "zod";
import {
  admitBulkLauncher,
  invokeBulkLauncher,
  invokeCustomAppLauncher,
  invokeScannerLauncher,
} from "../service/workflow-launcher-invocations";
import { invokeGridsWorkflow } from "../service/workflow-runtime";
import { GridsWorkflowInvocationRequestSchema } from "../workflows/contracts";
import { resolvePublicIdParam } from "./route-params";
import {
  BulkLauncherRequestSchema,
  CustomAppLauncherRequestSchema,
  PublicWorkflowInvocationReceiptSchema,
  resolveBulkRecordIds,
  ScannerLauncherRequestSchema,
  toPublicWorkflowReceipt,
  workflowPrincipal,
} from "./workflow-api-shared";

type DirectInvocation = z.infer<typeof GridsWorkflowInvocationRequestSchema>;

export const DIRECT_WORKFLOW_CHANNEL = "api" as const;

const invokeDirect = (workflowId: string, body: DirectInvocation, principal: ReturnType<typeof workflowPrincipal>) =>
  invokeGridsWorkflow({
    workflowId,
    mode: body.mode,
    channel: DIRECT_WORKFLOW_CHANNEL,
    inputs: body.inputs,
    idempotencyKey: body.idempotencyKey,
    expectedRevision: body.expectedRevision,
    principal,
  });

const publicReceipt = async <T extends Awaited<ReturnType<typeof invokeDirect>>>(result: T) =>
  result.ok ? ok(await toPublicWorkflowReceipt(result.data)) : result;

export const createWorkflowTriggerRoutes = () =>
  new Hono<AuthContext>()
    .post(
      "/:workflowId/invoke",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a workflow from the external API",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", GridsWorkflowInvocationRequestSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: "Invalid workflow id" }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c))));
      },
    )
    .post(
      "/:workflowId/invoke/manual",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a workflow from the trusted UI",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", GridsWorkflowInvocationRequestSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: "Invalid workflow id" }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c))));
      },
    )
    .post(
      "/:workflowId/invoke/cli",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a workflow from the trusted CLI",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", GridsWorkflowInvocationRequestSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: "Invalid workflow id" }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c))));
      },
    )
    .post(
      "/launchers/:launcherId/invoke/scanner",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a scanner workflow launcher",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", ScannerLauncherRequestSchema),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: "Invalid workflow launcher id" }, 400);
        return respond(c, async () =>
          publicReceipt(
            await invokeScannerLauncher({
              ...c.req.valid("json"),
              launcherId,
              principal: workflowPrincipal(c),
            }),
          ),
        );
      },
    )
    .post(
      "/launchers/:launcherId/invoke/bulk",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a bulk workflow launcher",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", BulkLauncherRequestSchema),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: "Invalid workflow launcher id" }, 400);
        const body = c.req.valid("json");
        const principal = workflowPrincipal(c);
        const admission = await admitBulkLauncher({ launcherId, expectedRevision: body.expectedRevision, principal });
        if (!admission.ok) return respond(c, () => Promise.resolve(admission));
        const resolved = "recordIds" in body ? await resolveBulkRecordIds(body.recordIds) : undefined;
        if (resolved === null) return c.json({ message: "Record not found" }, 404);
        return respond(c, async () =>
          publicReceipt(
            await invokeBulkLauncher({
              ...body,
              ...(resolved ? { recordIds: resolved } : {}),
              launcherId,
              principal,
            }),
          ),
        );
      },
    )
    .post(
      "/launchers/:launcherId/invoke/custom-app",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a Grids App workflow launcher",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", CustomAppLauncherRequestSchema),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: "Invalid workflow launcher id" }, 400);
        return respond(c, async () =>
          publicReceipt(
            await invokeCustomAppLauncher({
              ...c.req.valid("json"),
              launcherId,
              principal: workflowPrincipal(c),
            }),
          ),
        );
      },
    );
