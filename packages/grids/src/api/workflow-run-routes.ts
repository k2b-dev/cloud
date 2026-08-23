import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, jsonResponse, respond, v } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { listDocumentsForWorkflow, renderWorkflowDocumentsPdf } from "../service/documents";
import { getWorkflow } from "../service/workflow-definitions";
import { listWorkflowEmailDeliveriesPage } from "../service/workflow-email-deliveries";
import {
  cancelWorkflowRun,
  getWorkflowRun,
  getWorkflowRunStats,
  listWorkflowRunsPage,
  listWorkflowStepRunsPage,
} from "../service/workflow-runs";
import { encodeHeaderValue, pdfResponse } from "./download-response";
import { currentActorUserId, gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import {
  baseExists,
  PublicWorkflowDocumentListSchema,
  PublicGridsWorkflowEmailDeliveryListSchema,
  PublicGridsWorkflowRunListSchema,
  PublicGridsWorkflowRunSchema,
  PublicGridsWorkflowRunStatsSchema,
  PublicGridsWorkflowStepRunListSchema,
  resolveWorkflowFilterId,
  toPublicDocuments,
  toPublicWorkflowDeliveries,
  toPublicWorkflowRun,
  toPublicWorkflowRunPage,
  toPublicWorkflowStats,
  toPublicWorkflowSteps,
  visibleWorkflowIdsForBase,
  WorkflowEmailDeliveriesQuerySchema,
  WorkflowRunDocumentsQuerySchema,
  WorkflowRunStatsQuerySchema,
  WorkflowRunsQuerySchema,
} from "./workflow-api-shared";

const loadReadableRun = async (c: Parameters<typeof gateAt>[0], runId: string) => {
  const run = await getWorkflowRun(runId);
  if (!run?.workflowId) return null;
  const workflow = await getWorkflow(run.workflowId, true);
  if (!workflow) return null;
  const gate = await gateAt(c, { baseId: workflow.baseId }, "read");
  return gate.ok ? { run, workflow } : gate;
};

const canReadDocument =
  (c: Parameters<typeof gateAt>[0]) => async (document: { baseId: string; tableId: string; templateId: string }) =>
    (await gateAt(c, { baseId: document.baseId }, "read")).ok;

export const createWorkflowRunRoutes = () =>
  new Hono<AuthContext>()
    .get(
      "/by-base/:baseId/runs",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflow runs visible on a base",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRunListSchema, "Workflow runs"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id or query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("query", WorkflowRunsQuerySchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: "Invalid base id" }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: "Base not found" }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const visibleIds = await visibleWorkflowIdsForBase(c, baseId, { includeDeleted: true });
        const query = c.req.valid("query");
        const workflowId = await resolveWorkflowFilterId(query.workflowId);
        if (workflowId === null || (workflowId && !visibleIds.includes(workflowId))) {
          return c.json({ message: "Workflow not found" }, 404);
        }
        return c.json(
          await toPublicWorkflowRunPage(
            await listWorkflowRunsPage({
              baseId,
              workflowIds: visibleIds,
              workflowId,
              status: query.status,
              mode: query.mode,
              channel: query.channel,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
        );
      },
    )
    .get(
      "/by-base/:baseId/run-stats",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Return workflow run stats visible on a base",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRunStatsSchema, "Workflow run stats"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id or query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("query", WorkflowRunStatsQuerySchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: "Invalid base id" }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: "Base not found" }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const visibleIds = await visibleWorkflowIdsForBase(c, baseId, { includeDeleted: true });
        return c.json(await toPublicWorkflowStats(await getWorkflowRunStats(baseId, visibleIds, { window: c.req.valid("query").window })));
      },
    )
    .get(
      "/by-base/:baseId/email-deliveries",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflow email deliveries visible on a base",
        responses: {
          200: jsonResponse(PublicGridsWorkflowEmailDeliveryListSchema, "Workflow email deliveries"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id or query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("query", WorkflowEmailDeliveriesQuerySchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: "Invalid base id" }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: "Base not found" }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const visibleIds = await visibleWorkflowIdsForBase(c, baseId, { includeDeleted: true });
        const query = c.req.valid("query");
        const workflowId = await resolveWorkflowFilterId(query.workflowId);
        if (workflowId === null || (workflowId && !visibleIds.includes(workflowId))) {
          return c.json({ message: "Workflow not found" }, 404);
        }
        return c.json(
          await toPublicWorkflowDeliveries(
            await listWorkflowEmailDeliveriesPage({
              baseId,
              workflowIds: visibleIds,
              workflowId,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
        );
      },
    )
    .get(
      "/:workflowId/runs",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflow runs",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRunListSchema, "Runs"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id or query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("query", WorkflowRunsQuerySchema.pick({ cursor: true, limit: true, status: true, mode: true, channel: true })),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: "Invalid workflow id" }, 400);
        const workflow = await getWorkflow(workflowId, true);
        if (!workflow) return c.json({ message: "Workflow not found" }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const query = c.req.valid("query");
        return c.json(
          await toPublicWorkflowRunPage(
            await listWorkflowRunsPage({
              baseId: workflow.baseId,
              workflowIds: [workflow.id],
              workflowId,
              status: query.status,
              mode: query.mode,
              channel: query.channel,
              cursor: query.cursor,
              limit: query.limit,
            }),
          ),
        );
      },
    )
    .get(
      "/runs/:runId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Get a workflow run",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRunSchema, "Workflow run"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow run id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
        if (!runId) return c.json({ message: "Invalid workflow run id" }, 400);
        const loaded = await loadReadableRun(c, runId);
        if (!loaded) return c.json({ message: "Workflow run not found" }, 404);
        if (!("run" in loaded)) return respond(c, () => Promise.resolve(loaded));
        return c.json(await toPublicWorkflowRun(loaded.run));
      },
    )
    .post(
      "/runs/:runId/cancel",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Cancel an active workflow run",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRunSchema, "Canceled workflow run"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow run id or run is already terminal"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
        if (!runId) return c.json({ message: "Invalid workflow run id" }, 400);
        const run = await getWorkflowRun(runId);
        if (!run?.workflowId) return c.json({ message: "Workflow run not found" }, 404);
        const workflow = await getWorkflow(run.workflowId, true);
        if (!workflow) return c.json({ message: "Workflow run not found" }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "write");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const outcome = await cancelWorkflowRun(runId, currentActorUserId(c));
        if (outcome.state === "notFound") return c.json({ message: "Workflow run not found" }, 404);
        if (outcome.state === "notCancelable") {
          return c.json({ message: "Only queued, running, or waiting runs can be canceled." }, 400);
        }
        return c.json(await toPublicWorkflowRun(outcome.run));
      },
    )
    .get(
      "/runs/:runId/steps",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflow run steps",
        responses: {
          200: jsonResponse(PublicGridsWorkflowStepRunListSchema, "Steps"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow run id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
        if (!runId) return c.json({ message: "Invalid workflow run id" }, 400);
        const loaded = await loadReadableRun(c, runId);
        if (!loaded) return c.json({ message: "Workflow run not found" }, 404);
        if (!("run" in loaded)) return respond(c, () => Promise.resolve(loaded));
        return c.json(await toPublicWorkflowSteps(await listWorkflowStepRunsPage(runId), c.req.param("runId")));
      },
    )
    .get(
      "/runs/:runId/documents",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List documents generated by a workflow run",
        responses: {
          200: jsonResponse(PublicWorkflowDocumentListSchema, "Generated documents"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow run id or query"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("query", WorkflowRunDocumentsQuerySchema),
      async (c) => {
        const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
        if (!runId) return c.json({ message: "Invalid workflow run id" }, 400);
        const loaded = await loadReadableRun(c, runId);
        if (!loaded) return c.json({ message: "Workflow run not found" }, 404);
        if (!("run" in loaded)) return respond(c, () => Promise.resolve(loaded));
        return c.json(await toPublicDocuments(await listDocumentsForWorkflow(runId, c.req.valid("query"), canReadDocument(c))));
      },
    )
    .get(
      "/runs/:runId/documents/download",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Download all documents generated by a workflow run as one PDF",
        responses: {
          200: { description: "Combined generated PDF" },
          400: jsonResponse(ErrorResponseSchema, "No generated documents or too many documents"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const runId = await resolvePublicIdParam(c, "runId", "workflowRun");
        if (!runId) return c.json({ message: "Invalid workflow run id" }, 400);
        const loaded = await loadReadableRun(c, runId);
        if (!loaded) return c.json({ message: "Workflow run not found" }, 404);
        if (!("run" in loaded)) return respond(c, () => Promise.resolve(loaded));
        const pdf = await renderWorkflowDocumentsPdf(runId, canReadDocument(c));
        if (!pdf.ok) return c.json({ message: pdf.error.message }, pdf.error.status);
        return pdfResponse(pdf.data.pdf, pdf.data.filename, {
          "X-Grids-Document-Count": String(pdf.data.documentCount),
          "X-Grids-Document-Filename": encodeHeaderValue(pdf.data.filename),
        });
      },
    );
