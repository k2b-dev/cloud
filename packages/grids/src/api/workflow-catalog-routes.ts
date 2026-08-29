import { ok } from "@k2b/stdlib";
import { ErrorResponseSchema } from "@valentinkolb/cloud/contracts";
import { type AuthContext, getLocale, jsonResponse, respond } from "@valentinkolb/cloud/server";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  createWorkflow,
  getWorkflow,
  getWorkflowRevision,
  listWorkflowRevisions,
  removeWorkflow,
  restoreWorkflowRevision,
  updateWorkflow,
} from "../service/workflow-definitions";
import { createLauncher, getLauncher, listLaunchers, removeLauncher, updateLauncher } from "../service/workflow-launchers";
import { getWorkflowTriggerRuntimeState } from "../service/workflow-runtime";
import {
  CreateGridsWorkflowLauncherSchema,
  CreateGridsWorkflowSchema,
  RestoreGridsWorkflowRevisionSchema,
  UpdateGridsWorkflowLauncherSchema,
  UpdateGridsWorkflowSchema,
  WORKFLOW_REVISION_HEADER,
  WorkflowAutocompleteBodySchema,
  WorkflowAutocompleteResponseSchema,
} from "../workflows/contracts";
import { apiMessages } from "./messages";
import { currentActorUserId, gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import { v } from "./validator";
import {
  baseExists,
  buildWorkflowCompletions,
  canReadWorkflow,
  PublicGridsWorkflowLauncherListSchema,
  PublicGridsWorkflowLauncherSchema,
  PublicGridsWorkflowListSchema,
  PublicGridsWorkflowRevisionListSchema,
  PublicGridsWorkflowRevisionSchema,
  PublicGridsWorkflowSchema,
  PublicWorkflowTriggerRuntimeStateSchema,
  PublicWorkflowValidateResponseSchema,
  permissionedWorkflowCatalog,
  toPublicWorkflow,
  toPublicWorkflowLauncher,
  toPublicWorkflowLaunchers,
  toPublicWorkflowPlan,
  toPublicWorkflowRevision,
  toPublicWorkflowRevisionList,
  toPublicWorkflows,
  toPublicWorkflowTriggerState,
  validatePermissionedWorkflowSource,
  visibleWorkflowsForBase,
  WorkflowValidateSchema,
} from "./workflow-api-shared";

type WorkflowCatalogRouteDependencies = {
  getWorkflow: typeof getWorkflow;
  getWorkflowRevision: typeof getWorkflowRevision;
  getWorkflowTriggerRuntimeState: typeof getWorkflowTriggerRuntimeState;
  listWorkflowRevisions: typeof listWorkflowRevisions;
  restoreWorkflowRevision: typeof restoreWorkflowRevision;
  updateWorkflow: typeof updateWorkflow;
};

const loadReadableLauncher = async (c: Parameters<typeof canReadWorkflow>[0], launcherId: string, loadWorkflow: typeof getWorkflow) => {
  const launcher = await getLauncher(launcherId);
  if (!launcher) return null;
  const workflow = await loadWorkflow(launcher.workflowId);
  if (!workflow || !(await canReadWorkflow(c, workflow))) return null;
  return { launcher, workflow };
};

export const createWorkflowCatalogRoutes = (overrides: Partial<WorkflowCatalogRouteDependencies> = {}) => {
  const dependencies: WorkflowCatalogRouteDependencies = {
    getWorkflow,
    getWorkflowRevision,
    getWorkflowTriggerRuntimeState,
    listWorkflowRevisions,
    restoreWorkflowRevision,
    updateWorkflow,
    ...overrides,
  };
  return new Hono<AuthContext>()
    .post(
      "/by-base/:baseId/validate",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Compile and bind workflow YAML",
        responses: {
          200: jsonResponse(PublicWorkflowValidateResponseSchema, "Validation result"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", WorkflowValidateSchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await validatePermissionedWorkflowSource(c, baseId, c.req.valid("json").source);
        return c.json(result.ok ? { ok: true as const, plan: await toPublicWorkflowPlan(result.plan) } : result);
      },
    )
    .post(
      "/by-base/:baseId/autocomplete",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Return permission-safe workflow language completions and diagnostics",
        responses: {
          200: jsonResponse(WorkflowAutocompleteResponseSchema, "Workflow completions and diagnostics"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", WorkflowAutocompleteBodySchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const body = c.req.valid("json");
        const catalog = await permissionedWorkflowCatalog(c, baseId);
        const validation = await validatePermissionedWorkflowSource(c, baseId, body.source, catalog);
        return c.json({
          ok: true as const,
          diagnostics: validation.ok ? [] : validation.diagnostics,
          items: buildWorkflowCompletions(body.source, body.caret ?? body.source.length, catalog, getLocale(c)),
        });
      },
    )
    .get(
      "/by-base/:baseId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflows visible on a base",
        responses: {
          200: jsonResponse(PublicGridsWorkflowListSchema, "Workflows"),
          400: jsonResponse(ErrorResponseSchema, "Invalid base id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const gate = await gateAt(c, { baseId }, "read");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const visible = await visibleWorkflowsForBase(c, baseId);
        return c.json(await toPublicWorkflows(visible));
      },
    )
    .post(
      "/by-base/:baseId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Create a workflow",
        responses: {
          201: jsonResponse(PublicGridsWorkflowSchema, "Created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", CreateGridsWorkflowSchema),
      async (c) => {
        const baseId = await resolvePublicIdParam(c, "baseId", "base");
        if (!baseId) return c.json({ message: apiMessages(c).invalidBaseId }, 400);
        if (!(await baseExists(baseId))) return c.json({ message: apiMessages(c).baseNotFound }, 404);
        const gate = await gateAt(c, { baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return respond(
          c,
          async () => {
            const result = await createWorkflow(baseId, c.req.valid("json"), currentActorUserId(c), getLocale(c));
            return result.ok ? ok(await toPublicWorkflow(result.data)) : result;
          },
          201,
        );
      },
    )
    .get(
      "/:workflowId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Get a workflow",
        responses: {
          200: jsonResponse(PublicGridsWorkflowSchema, "Workflow"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow || !(await canReadWorkflow(c, workflow))) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        return c.json(await toPublicWorkflow(workflow));
      },
    )
    .get(
      "/:workflowId/trigger-state",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Get automatic workflow trigger runtime state",
        responses: {
          200: jsonResponse(PublicWorkflowTriggerRuntimeStateSchema, "Automatic trigger runtime state"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow || !(await canReadWorkflow(c, workflow))) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        return c.json(await toPublicWorkflowTriggerState(await dependencies.getWorkflowTriggerRuntimeState(workflow)));
      },
    )
    .patch(
      "/:workflowId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Update a workflow",
        parameters: [
          {
            name: WORKFLOW_REVISION_HEADER,
            in: "header",
            required: true,
            description: "Current workflow revision returned by the API.",
            schema: { type: "integer", minimum: 1 },
          },
        ],
        responses: {
          200: jsonResponse(PublicGridsWorkflowSchema, "Updated"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision conflict"),
        },
      }),
      v("json", UpdateGridsWorkflowSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const expectedRevision = Number(c.req.header(WORKFLOW_REVISION_HEADER));
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
          return c.json({ message: apiMessages(c).revisionHeaderRequired({ header: WORKFLOW_REVISION_HEADER }) }, 400);
        }
        return respond(c, async () => {
          const result = await dependencies.updateWorkflow(
            workflowId,
            c.req.valid("json"),
            currentActorUserId(c),
            expectedRevision,
            {},
            getLocale(c),
          );
          return result.ok ? ok(await toPublicWorkflow(result.data)) : result;
        });
      },
    )
    .get(
      "/:workflowId/revisions",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List immutable workflow revisions",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRevisionListSchema, "Workflow revisions"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id or query"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v(
        "query",
        z.object({
          beforeRevision: z.coerce.number().int().positive().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        }),
      ),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId, true);
        if (!workflow || !(await canReadWorkflow(c, workflow))) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const query = c.req.valid("query");
        return c.json(
          toPublicWorkflowRevisionList(
            await dependencies.listWorkflowRevisions(workflowId, query.beforeRevision ?? null, query.limit),
            workflow.shortId,
          ),
        );
      },
    )
    .post(
      "/:workflowId/revisions/:revision/restore",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Restore a workflow revision as a new revision",
        responses: {
          200: jsonResponse(PublicGridsWorkflowSchema, "Restored workflow"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow or revision"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
          409: jsonResponse(ErrorResponseSchema, "Revision conflict"),
        },
      }),
      v("json", RestoreGridsWorkflowRevisionSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        const revision = Number(c.req.param("revision"));
        if (!workflowId || !Number.isSafeInteger(revision) || revision < 1) {
          return c.json({ message: apiMessages(c).invalidWorkflowRevision }, 400);
        }
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const input = c.req.valid("json");
        return respond(c, async () => {
          const result = await dependencies.restoreWorkflowRevision(
            workflowId,
            revision,
            currentActorUserId(c),
            input.expectedRevision,
            getLocale(c),
          );
          return result.ok ? ok(await toPublicWorkflow(result.data)) : result;
        });
      },
    )
    .get(
      "/:workflowId/revisions/:revision",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Get an immutable workflow revision",
        responses: {
          200: jsonResponse(PublicGridsWorkflowRevisionSchema, "Workflow revision"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow or revision"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        const revision = Number(c.req.param("revision"));
        if (!workflowId || !Number.isSafeInteger(revision) || revision < 1) {
          return c.json({ message: apiMessages(c).invalidWorkflowRevision }, 400);
        }
        const workflow = await dependencies.getWorkflow(workflowId, true);
        if (!workflow || !(await canReadWorkflow(c, workflow))) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const snapshot = await dependencies.getWorkflowRevision(workflowId, revision);
        return snapshot
          ? c.json(await toPublicWorkflowRevision(snapshot, workflow.shortId))
          : c.json({ message: apiMessages(c).workflowRevisionNotFound }, 404);
      },
    )
    .delete(
      "/:workflowId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Delete a workflow",
        responses: {
          204: { description: "Deleted" },
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        const result = await removeWorkflow(workflowId, currentActorUserId(c), getLocale(c));
        if (!result.ok) return c.json({ message: result.error.message }, result.error.status);
        return c.body(null, 204);
      },
    )
    .get(
      "/:workflowId/launchers",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "List workflow launchers",
        responses: {
          200: jsonResponse(PublicGridsWorkflowLauncherListSchema, "Launchers"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow id"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow || !(await canReadWorkflow(c, workflow))) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        return c.json({ items: await toPublicWorkflowLaunchers(await listLaunchers(workflow.id)) });
      },
    )
    .post(
      "/:workflowId/launchers",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Create a workflow launcher",
        responses: {
          201: jsonResponse(PublicGridsWorkflowLauncherSchema, "Created"),
          400: jsonResponse(ErrorResponseSchema, "Invalid launcher"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", CreateGridsWorkflowLauncherSchema),
      async (c) => {
        const workflowId = await resolvePublicIdParam(c, "workflowId", "workflow");
        if (!workflowId) return c.json({ message: apiMessages(c).invalidWorkflowId }, 400);
        const workflow = await dependencies.getWorkflow(workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return respond(
          c,
          async () => {
            const result = await createLauncher(workflow, c.req.valid("json"), currentActorUserId(c), getLocale(c));
            return result.ok ? ok(await toPublicWorkflowLauncher(result.data)) : result;
          },
          201,
        );
      },
    )
    .get(
      "/launchers/:launcherId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Get a workflow launcher",
        responses: {
          200: jsonResponse(PublicGridsWorkflowLauncherSchema, "Launcher"),
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow launcher id"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        const loaded = await loadReadableLauncher(c, launcherId, dependencies.getWorkflow);
        return loaded
          ? c.json(await toPublicWorkflowLauncher(loaded.launcher))
          : c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
      },
    )
    .patch(
      "/launchers/:launcherId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Update and revalidate a workflow launcher",
        responses: {
          200: jsonResponse(PublicGridsWorkflowLauncherSchema, "Updated"),
          400: jsonResponse(ErrorResponseSchema, "Invalid launcher"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      v("json", UpdateGridsWorkflowLauncherSchema),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        const launcher = await getLauncher(launcherId);
        if (!launcher) return c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
        const workflow = await dependencies.getWorkflow(launcher.workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        return respond(c, async () => {
          const result = await updateLauncher(launcher, workflow, c.req.valid("json"), currentActorUserId(c), getLocale(c));
          return result.ok ? ok(await toPublicWorkflowLauncher(result.data)) : result;
        });
      },
    )
    .delete(
      "/launchers/:launcherId",
      describeRoute({
        tags: ["Grids:Workflow"],
        summary: "Delete a workflow launcher",
        responses: {
          204: { description: "Deleted" },
          400: jsonResponse(ErrorResponseSchema, "Invalid workflow launcher id"),
          403: jsonResponse(ErrorResponseSchema, "Forbidden"),
          404: jsonResponse(ErrorResponseSchema, "Not found"),
        },
      }),
      async (c) => {
        const launcherId = await resolvePublicIdParam(c, "launcherId", "workflowLauncher");
        if (!launcherId) return c.json({ message: apiMessages(c).invalidWorkflowLauncherId }, 400);
        const launcher = await getLauncher(launcherId);
        if (!launcher) return c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
        const workflow = await dependencies.getWorkflow(launcher.workflowId);
        if (!workflow) return c.json({ message: apiMessages(c).workflowLauncherNotFound }, 404);
        const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
        if (!gate.ok) return respond(c, () => Promise.resolve(gate));
        await removeLauncher(launcher, currentActorUserId(c));
        return c.body(null, 204);
      },
    );
};
