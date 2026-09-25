import { getLocale, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { assignConversationsSchema } from "../contracts";
import { conversationAssignments, type MailRequestContext } from "../service";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, respondPublic } from "./public-resource-boundary";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

// Mounted with the resource routes, before `conversations/:conversationId` would claim `assign` as an id.
export default new Hono<MailApiContext>().post(
  "/mailboxes/:mailboxId/conversations/assign",
  v("param", mailboxParamSchema),
  v("json", assignConversationsSchema),
  async (c) => {
    const input = c.req.valid("json");
    return respondPublic(
      c,
      conversationAssignments.assignConversations({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        conversationIds: input.conversationIds,
        assigneeUserId: input.assigneeUserId,
        locale: getLocale(c),
      }),
    );
  },
);
