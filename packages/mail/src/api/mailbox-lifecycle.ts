import { v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type MailRequestContext, mailboxes } from "../service";
import { internalMailboxId, type MailApiContext, mailboxParamSchema, respondPublic } from "./public-resource-boundary";

const deletedMailboxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().min(1).max(1_000).optional(),
});

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

export default new Hono<MailApiContext>()
  .get("/mailboxes/deleted", v("query", deletedMailboxQuerySchema), async (c) => {
    const query = c.req.valid("query");
    return respondPublic(c, mailboxes.listDeletedMailboxes(requestContext(c), query), "mailboxes");
  })
  .get("/mailboxes/:mailboxId/deleted", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, mailboxes.getDeletedMailbox(requestContext(c), internalMailboxId(c)), "mailboxes"),
  )
  .post("/mailboxes/:mailboxId/restore", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, mailboxes.restoreMailbox(requestContext(c), internalMailboxId(c)), "mailboxes"),
  );
