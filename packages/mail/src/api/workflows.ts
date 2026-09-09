import { v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  activateWorkflowInputSchema,
  autocompleteWorkflowInputSchema,
  createWorkflowInputSchema,
  createWorkflowVersionInputSchema,
  deactivateWorkflowInputSchema,
  ResourceShortIdSchema,
  restoreWorkflowVersionInputSchema,
  updateWorkflowMetadataInputSchema,
  validateWorkflowInputSchema,
} from "../contracts";
import { type MailRequestContext, workflows } from "../service";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, resolveMailboxParam, respondPublic } from "./public-resource-boundary";
import {
  mailWorkflowDetailSchema,
  mailWorkflowSchema,
  mailWorkflowVersionSchema,
  workflowAutocompleteSchema,
  workflowOperation,
  workflowValidationSchema,
} from "./workflow-openapi";

const workflowParamSchema = z.object({ mailboxId: ResourceShortIdSchema, workflowId: z.string().uuid() });
const workflowVersionParamSchema = workflowParamSchema.extend({ versionId: z.string().uuid() });
const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});
const workflowParams = <T extends { mailboxId: string }>(c: Context<MailApiContext>, params: T): T => ({
  ...params,
  mailboxId: internalMailboxId(c),
});

const workflowRoutes = new Hono<MailApiContext>()
  .use("/mailboxes/:mailboxId/*", resolveMailboxParam)
  .post(
    "/mailboxes/:mailboxId/workflows/autocomplete",
    workflowOperation("Complete Mail workflow YAML", workflowAutocompleteSchema, "Workflow completions and diagnostics"),
    v("param", mailboxParamSchema),
    v("json", autocompleteWorkflowInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.autocompleteWorkflow({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/workflows/validate",
    workflowOperation("Validate Mail workflow YAML", workflowValidationSchema, "Workflow validation result"),
    v("param", mailboxParamSchema),
    v("json", validateWorkflowInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.validateWorkflow({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          source: c.req.valid("json").source,
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/workflows",
    workflowOperation("List Mail workflows", z.array(mailWorkflowSchema), "Mail workflows"),
    v("param", mailboxParamSchema),
    async (c) => respondPublic(c, workflows.listWorkflows(requestContext(c), internalMailboxId(c))),
  )
  .post(
    "/mailboxes/:mailboxId/workflows",
    workflowOperation("Create a Mail workflow", mailWorkflowDetailSchema, "Created Mail workflow", [409]),
    v("param", mailboxParamSchema),
    v("json", createWorkflowInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.createWorkflow({
          context: requestContext(c),
          mailboxId: internalMailboxId(c),
          input: c.req.valid("json"),
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/workflows/:workflowId",
    workflowOperation("Get a Mail workflow", mailWorkflowDetailSchema, "Mail workflow", [404]),
    v("param", workflowParamSchema),
    async (c) => {
      const params = workflowParams(c, c.req.valid("param"));
      return respondPublic(c, workflows.getWorkflow(requestContext(c), params.mailboxId, params.workflowId));
    },
  )
  .patch(
    "/mailboxes/:mailboxId/workflows/:workflowId",
    workflowOperation("Update Mail workflow metadata", mailWorkflowDetailSchema, "Updated Mail workflow", [404, 409]),
    v("param", workflowParamSchema),
    v("json", updateWorkflowMetadataInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.updateWorkflowMetadata({
          context: requestContext(c),
          ...workflowParams(c, c.req.valid("param")),
          input: c.req.valid("json"),
        }),
      ),
  )
  .get(
    "/mailboxes/:mailboxId/workflows/:workflowId/versions",
    workflowOperation("List Mail workflow versions", z.array(mailWorkflowVersionSchema), "Mail workflow versions", [404]),
    v("param", workflowParamSchema),
    async (c) =>
      respondPublic(c, workflows.listWorkflowVersions({ context: requestContext(c), ...workflowParams(c, c.req.valid("param")) })),
  )
  .get(
    "/mailboxes/:mailboxId/workflows/:workflowId/versions/:versionId",
    workflowOperation("Get a Mail workflow version", mailWorkflowVersionSchema, "Mail workflow version", [404]),
    v("param", workflowVersionParamSchema),
    async (c) => respondPublic(c, workflows.getWorkflowVersion({ context: requestContext(c), ...workflowParams(c, c.req.valid("param")) })),
  )
  .post(
    "/mailboxes/:mailboxId/workflows/:workflowId/versions/:versionId/restore",
    workflowOperation("Restore a Mail workflow version", mailWorkflowDetailSchema, "Restored Mail workflow", [404, 409]),
    v("param", workflowVersionParamSchema),
    v("json", restoreWorkflowVersionInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.restoreWorkflowVersion({
          context: requestContext(c),
          ...workflowParams(c, c.req.valid("param")),
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/workflows/:workflowId/versions",
    workflowOperation("Create a Mail workflow version", mailWorkflowDetailSchema, "Versioned Mail workflow", [404]),
    v("param", workflowParamSchema),
    v("json", createWorkflowVersionInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.createWorkflowVersion({
          context: requestContext(c),
          ...workflowParams(c, c.req.valid("param")),
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/workflows/:workflowId/activate",
    workflowOperation("Activate a Mail workflow version", mailWorkflowDetailSchema, "Activated Mail workflow", [404, 409]),
    v("param", workflowParamSchema),
    v("json", activateWorkflowInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.activateWorkflow({
          context: requestContext(c),
          ...workflowParams(c, c.req.valid("param")),
          input: c.req.valid("json"),
        }),
      ),
  )
  .post(
    "/mailboxes/:mailboxId/workflows/:workflowId/deactivate",
    workflowOperation("Deactivate a Mail workflow", mailWorkflowDetailSchema, "Deactivated Mail workflow", [404, 409]),
    v("param", workflowParamSchema),
    v("json", deactivateWorkflowInputSchema),
    async (c) =>
      respondPublic(
        c,
        workflows.deactivateWorkflow({
          context: requestContext(c),
          ...workflowParams(c, c.req.valid("param")),
          input: c.req.valid("json"),
        }),
      ),
  );

export default workflowRoutes;
