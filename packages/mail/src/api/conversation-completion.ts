import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { completeConversationsSchema, conversationCompletionResultSchema } from "../contracts";
import { collaboration, type MailRequestContext } from "../service";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, respondPublic } from "./public-resource-boundary";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

// Mounted before `conversations/:conversationId` can claim `completion` as an id.
export default new Hono<MailApiContext>().post(
  "/mailboxes/:mailboxId/conversations/completion",
  describeRoute({
    tags: ["Mail:Conversations"],
    summary: "Mark conversations done or reopen them",
    ...requiresAuth,
    responses: {
      200: jsonResponse(conversationCompletionResultSchema, "Conversation results"),
      400: jsonResponse(ErrorResponseSchema, "Invalid input"),
      401: jsonResponse(ErrorResponseSchema, "Authentication required"),
      403: jsonResponse(ErrorResponseSchema, "Forbidden"),
      404: jsonResponse(ErrorResponseSchema, "Mailbox not found"),
    },
  }),
  v("param", mailboxParamSchema),
  v("json", completeConversationsSchema),
  async (c) =>
    respondPublic(
      c,
      collaboration.applyConversationCompletions({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ...c.req.valid("json"),
      }),
    ),
);
