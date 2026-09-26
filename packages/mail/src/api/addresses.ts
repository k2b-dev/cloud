import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { getLocale, jsonResponse, requiresAuth, respond, v } from "@k2b/cloud/server";
import { ok } from "@k2b/stdlib";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { addresses, type MailRequestContext } from "../service";
import { type MailApiContext, projectPublicResult, projectRootRelation } from "./public-resource-boundary";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const resolveQuerySchema = z.object({
  mailbox: z.string().trim().min(1).max(200).describe("Mailbox ID or exact name"),
  folder: z.string().trim().min(1).max(1000).optional().describe("Folder ID or path such as `Projekte / 2025`"),
});

// The ambiguity and not-found messages are already localized; they bypass the generic Mail error wording.
export default new Hono<MailApiContext>().get(
  "/resolve",
  describeRoute({
    tags: ["Mail:Mailboxes"],
    summary: "Resolve a mailbox name and an optional folder path",
    ...requiresAuth,
    responses: {
      200: { description: "The mailbox and, when requested, the folder with its path" },
      404: jsonResponse(ErrorResponseSchema, "No mailbox or folder matches"),
      409: jsonResponse(ErrorResponseSchema, "Several mailboxes or folders match; the message lists them as path (id)"),
    },
  }),
  v("query", resolveQuerySchema),
  async (c) => {
    const query = c.req.valid("query");
    const result = await addresses.resolveMailAddress({ context: requestContext(c), ...query, locale: getLocale(c) });
    if (!result.ok) return respond(c, result);
    const mailbox = await projectPublicResult(ok(result.data.mailbox), "mailboxes");
    const folder = result.data.folder
      ? await projectPublicResult(await projectRootRelation(ok(result.data.folder), "parentId", "folders"), "folders")
      : null;
    if (!mailbox.ok || (folder && !folder.ok)) throw new Error("Mail address projection failed");
    return c.json({ mailbox: mailbox.data, folder: folder?.ok ? folder.data : null });
  },
);
