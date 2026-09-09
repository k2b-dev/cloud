import { rateLimit, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { ResourceShortIdSchema, remoteContentRuleInputSchema } from "../contracts";
import { type MailRequestContext, remoteContent } from "../service";
import {
  internalMailboxId,
  internalParams,
  type MailApiContext,
  mailboxParamSchema,
  resolveMailboxResourceParam,
  respondPublic,
} from "./public-resource-boundary";

const ruleParamSchema = mailboxParamSchema.extend({ ruleId: z.string().uuid() });
const imageParamSchema = z.object({
  mailboxId: ResourceShortIdSchema,
  messageId: ResourceShortIdSchema,
  imageId: z.string().uuid(),
});
const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const resolveMessageParam = resolveMailboxResourceParam("messages", "messageId", "Message");

export default new Hono<MailApiContext>()
  .get("/mailboxes/:mailboxId/remote-content-rules", v("param", mailboxParamSchema), async (c) =>
    respondPublic(c, remoteContent.listRemoteContentRules(requestContext(c), internalMailboxId(c))),
  )
  .post("/mailboxes/:mailboxId/remote-content-rules", v("param", mailboxParamSchema), v("json", remoteContentRuleInputSchema), async (c) =>
    respondPublic(
      c,
      remoteContent.createRemoteContentRule({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        input: c.req.valid("json"),
      }),
    ),
  )
  .delete("/mailboxes/:mailboxId/remote-content-rules/:ruleId", v("param", ruleParamSchema), async (c) =>
    respondPublic(
      c,
      remoteContent.deleteRemoteContentRule({
        context: requestContext(c),
        mailboxId: internalMailboxId(c),
        ruleId: c.req.valid("param").ruleId,
      }),
    ),
  )
  .get(
    "/mailboxes/:mailboxId/messages/:messageId/remote-images/:imageId",
    resolveMessageParam,
    rateLimit({ keyBy: "user", limitPerSecond: 8 }),
    v("param", imageParamSchema),
    async (c) => {
      const image = await remoteContent.loadRemoteImage({
        context: requestContext(c),
        ...internalParams(c, c.req.valid("param")),
      });
      if (!image.ok) return respondPublic(c, image);
      return new Response(Uint8Array.from(image.data.bytes).buffer, {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Length": String(image.data.bytes.byteLength),
          "Content-Security-Policy": "default-src 'none'; sandbox",
          "Content-Type": image.data.contentType,
          "Cross-Origin-Resource-Policy": "same-origin",
          "X-Content-Type-Options": "nosniff",
        },
      });
    },
  );
