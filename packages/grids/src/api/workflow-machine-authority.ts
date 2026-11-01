import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { type AuthContext, auth, jsonResponse, respond } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { configureWorkflowMachineAuthority, getWorkflowMachineAuthority } from "../service/workflow-machine-authority";
import { getWorkflow } from "../service/workflow-read";
import { WorkflowMachineAuthorityChangeSchema, WorkflowMachineAuthoritySchema } from "../workflows/contracts";
import { gateAt } from "./permissions";
import { resolvePublicIdParam } from "./route-params";
import { v } from "./validator";

const presentation = (value: NonNullable<Awaited<ReturnType<typeof getWorkflowMachineAuthority>>>, canConfigure: boolean) => ({
  hasHumanOwner: value.ownerUserId !== null,
  serviceAccountId: value.serviceAccountId,
  name: value.name,
  kind: value.kind,
  accountStatus: value.accountStatus,
  canConfigure,
  mandate: value.mandate
    ? { id: value.mandate.id, state: value.mandate.state, revision: value.mandate.revision, permissionCap: "write" as const }
    : null,
});
export const workflowMachineAuthorityRoutes = new Hono<AuthContext>()
  .get(
    "/:workflowId/machine-authority",
    describeRoute({
      tags: ["Grids:Workflow"],
      summary: "Read the automatic machine execution owner",
      responses: {
        200: jsonResponse(WorkflowMachineAuthoritySchema, "Machine execution authority"),
        403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      },
    }),
    async (c) => {
      const id = await resolvePublicIdParam(c, "workflowId", "workflow");
      const workflow = id ? await getWorkflow(id) : null;
      if (!workflow) return c.json({ message: "Workflow not found" }, 404);
      const gate = await gateAt(c, { baseId: workflow.baseId }, "read");
      if (!gate.ok) return respond(c, gate);
      const value = await getWorkflowMachineAuthority(workflow.id);
      if (!value) return c.json({ message: "Workflow not found" }, 404);
      const actor = c.get("actor");
      const canConfigure =
        actor.kind === "user" &&
        actor.sessionKind !== "app" &&
        actor.user.roles.includes("admin") &&
        (await gateAt(c, { baseId: workflow.baseId }, "admin")).ok;
      return c.json(presentation(value, canConfigure));
    },
  )
  .put(
    "/:workflowId/machine-authority",
    auth.requireOAuthScope("write", "admin"),
    describeRoute({
      tags: ["Grids:Workflow"],
      summary: "Assign, pause or revoke a machine workflow mandate",
      responses: {
        200: jsonResponse(WorkflowMachineAuthoritySchema, "Current machine authority"),
        403: jsonResponse(ErrorResponseSchema, "Administrator and workflow management required"),
        409: jsonResponse(ErrorResponseSchema, "Execution authority changed; reload before trying again"),
      },
    }),
    v("json", WorkflowMachineAuthorityChangeSchema),
    async (c) => {
      const id = await resolvePublicIdParam(c, "workflowId", "workflow");
      if (!id) return c.json({ message: "Workflow not found" }, 404);
      const workflow = await getWorkflow(id);
      if (!workflow) return c.json({ message: "Workflow not found" }, 404);
      const gate = await gateAt(c, { baseId: workflow.baseId }, "admin");
      if (!gate.ok) return respond(c, gate);
      return respond(c, async () => {
        const result = await configureWorkflowMachineAuthority({ actor: c.get("actor"), workflowId: id, change: c.req.valid("json") });
        return result.ok ? ok(presentation(result.data, true)) : result;
      });
    },
  );
