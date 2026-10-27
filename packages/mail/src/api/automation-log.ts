import { jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  automationLogDetailSchema,
  automationLogItemSchema,
  automationLogPageSchema,
  automationLogQuerySchema,
  automationLogUndoConflictSchema,
  ResourceShortIdSchema,
} from "../contracts";
import type { MailRequestContext } from "../service/auth";
import {
  changeAutomationLogAssignment,
  getAutomationLogItem,
  getConversationAutomationTrace,
  listAutomationLog,
} from "../service/automation-log";
import {
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  resolveMailboxParam,
  resolveMailboxResourceParam,
  respondPublic,
} from "./public-resource-boundary";
import { workflowOperation } from "./workflow-openapi";

const itemParams = mailboxParamSchema.extend({ itemId: z.string().uuid() });
const conversationParams = mailboxParamSchema.extend({ conversationId: ResourceShortIdSchema });
const context = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});
const mutationOperation = (operation: string) =>
  describeRoute({
    tags: ["Mail:Workflows"],
    summary: `${operation} a rule assignment`,
    ...requiresAuth,
    responses: {
      200: jsonResponse(z.object({ item: automationLogItemSchema }), "Updated rule assignment"),
      409: jsonResponse(automationLogUndoConflictSchema, "Assignment changed since the rule ran"),
    },
  });

const automationLogRoutes = new Hono<MailApiContext>()
  .use("/mailboxes/:mailboxId/*", resolveMailboxParam)
  .get(
    "/mailboxes/:mailboxId/automation-log",
    workflowOperation("Read the automation log", automationLogPageSchema, "Conversation-scoped automation log"),
    v("param", mailboxParamSchema),
    v("query", automationLogQuerySchema),
    (c) => respondPublic(c, listAutomationLog(context(c), internalMailboxId(c), c.req.valid("query"))),
  )
  .get(
    "/mailboxes/:mailboxId/automation-log/:itemId",
    workflowOperation("Read an automation audit chain", automationLogDetailSchema, "Audit chain and AI call counts", [404]),
    v("param", itemParams),
    (c) => respondPublic(c, getAutomationLogItem(context(c), internalMailboxId(c), c.req.valid("param").itemId)),
  )
  .post("/mailboxes/:mailboxId/automation-log/:itemId/undo", mutationOperation("Undo"), v("param", itemParams), async (c) => {
    const result = await changeAutomationLogAssignment(context(c), internalMailboxId(c), c.req.valid("param").itemId, "undo");
    if (!result.ok && result.error.code === "mail.automation.undo_not_possible")
      return c.json(automationLogUndoConflictSchema.parse(result.error), 409);
    return respondPublic(c, Promise.resolve(result));
  })
  .post("/mailboxes/:mailboxId/automation-log/:itemId/redo", mutationOperation("Redo"), v("param", itemParams), async (c) => {
    const result = await changeAutomationLogAssignment(context(c), internalMailboxId(c), c.req.valid("param").itemId, "redo");
    if (!result.ok && result.error.code === "mail.automation.undo_not_possible")
      return c.json(automationLogUndoConflictSchema.parse(result.error), 409);
    return respondPublic(c, Promise.resolve(result));
  })
  .get(
    "/mailboxes/:mailboxId/conversations/:conversationId/automation-trace",
    resolveMailboxResourceParam("conversations", "conversationId", "Conversation"),
    workflowOperation(
      "Read a conversation's recent automation effects",
      z.object({ items: z.array(automationLogItemSchema) }),
      "At most ten recent entries",
      [404],
    ),
    v("param", conversationParams),
    (c) =>
      respondPublic(
        c,
        getConversationAutomationTrace(context(c), internalMailboxId(c), internalParams(c, c.req.valid("param")).conversationId),
      ),
  );

export default automationLogRoutes;
