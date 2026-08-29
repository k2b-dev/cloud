import { ok } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { z } from "zod";
import {
  admitBulkLauncher,
  admitRecordLauncher,
  invokeBulkLauncher,
  invokeCustomAppLauncher,
  invokeRecordLauncher,
  invokeScannerLauncher,
} from "../service/workflow-launcher-invocations";
import { invokeGridsWorkflow } from "../service/workflow-runtime";
import { GridsWorkflowInvocationRequestSchema } from "../workflows/contracts";
import { apiMessages } from "./messages";
import { publicIdParam, resolvePublicIdParam } from "./route-params";
import { v } from "./validator";
import {
  BulkLauncherRequestSchema,
  CustomAppLauncherRequestSchema,
  PublicWorkflowInvocationReceiptSchema,
  RecordLauncherRequestSchema,
  resolveBulkRecordIds,
  ScannerLauncherRequestSchema,
  toPublicWorkflowReceipt,
  workflowPrincipal,
} from "./workflow-api-shared";

type DirectInvocation = z.infer<typeof GridsWorkflowInvocationRequestSchema>;

export const DIRECT_WORKFLOW_CHANNEL = "api" as const;

const invokeDirect = (workflowId: string, body: DirectInvocation, principal: ReturnType<typeof workflowPrincipal>, locale: string) =>
  invokeGridsWorkflow({
    workflowId,
    mode: body.mode,
    channel: DIRECT_WORKFLOW_CHANNEL,
    inputs: body.inputs,
    idempotencyKey: body.idempotencyKey,
    expectedRevision: body.expectedRevision,
    principal,
    context: { locale },
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
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c), getLocale(c))));
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
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c), getLocale(c))));
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
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const body = c.req.valid("json");
        return respond(c, async () => publicReceipt(await invokeDirect(workflowId, body, workflowPrincipal(c), getLocale(c))));
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
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        return respond(c, async () =>
          publicReceipt(
            await invokeScannerLauncher({
              ...c.req.valid("json"),
              launcherId,
              principal: workflowPrincipal(c),
              locale: getLocale(c),
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
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        const body = c.req.valid("json");
        const principal = workflowPrincipal(c);
        const admission = await admitBulkLauncher({ launcherId, expectedRevision: body.expectedRevision, principal, locale: getLocale(c) });
        if (!admission.ok) return respond(c, () => Promise.resolve(admission));
        const resolved = "recordIds" in body ? await resolveBulkRecordIds(body.recordIds) : undefined;
        if (resolved === null) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        return respond(c, async () =>
          publicReceipt(
            await invokeBulkLauncher({
              ...body,
              ...(resolved ? { recordIds: resolved } : {}),
              launcherId,
              principal,
              locale: getLocale(c),
            }),
          ),
        );
      },
    )
    .post(
      "/launchers/:launcherId/invoke/record",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Invoke a single-Record workflow launcher",
        responses: {
          200: jsonResponse(PublicWorkflowInvocationReceiptSchema, "Invocation accepted"),
          400: jsonResponse(ErrorResponseSchema, "Invalid invocation"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision or idempotency conflict"),
          500: jsonResponse(ErrorResponseSchema, "Invocation failed"),
        },
      }),
      v("json", RecordLauncherRequestSchema),
      async (c) => {
        if (!publicIdParam(c, "launcherId")) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
        const body = c.req.valid("json");
        const principal = workflowPrincipal(c);
        const admission = await admitRecordLauncher({
          launcherId,
          expectedRevision: body.expectedRevision,
          principal,
          locale: getLocale(c),
        });
        if (!admission.ok) return respond(c, () => Promise.resolve(admission));
        const [recordId] = (await resolveBulkRecordIds([body.recordId])) ?? [];
        if (!recordId) return c.json({ message: apiMessages(c).recordNotFound }, 404);
        return respond(c, async () =>
          publicReceipt(
            await invokeRecordLauncher({
              ...body,
              launcherId,
              recordId,
              principal,
              locale: getLocale(c),
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
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        return respond(c, async () =>
          publicReceipt(
            await invokeCustomAppLauncher({
              ...c.req.valid("json"),
              launcherId,
              principal: workflowPrincipal(c),
              locale: getLocale(c),
            }),
          ),
        );
      },
    );
