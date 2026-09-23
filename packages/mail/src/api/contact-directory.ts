import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { getLocale, jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { contactDirectoryMessages } from "../contact-directory-messages";
import { mailContactDirectoryUpdateSchema } from "../contact-directory-settings";
import { contactDirectory, type MailRequestContext } from "../service";
import type { MailApiContext } from "./public-resource-boundary";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const contactDirectoryInvalidResponseSchema = ErrorResponseSchema.extend({
  issues: z.array(
    z.object({
      field: z.enum(["appId", "suggest", "resolve", "read", "listWritableBooks", "create"]),
      code: z.string(),
      message: z.string(),
    }),
  ),
});

// Mounted below the Cloud-admin guard of the Mail admin API. The 400 body adds field-level `issues`.
export default new Hono<MailApiContext>().put(
  "/admin/contact-directory",
  describeRoute({
    tags: ["Mail:Admin"],
    summary: "Choose the contact directory app and capabilities",
    description:
      "Validates each mapped capability against the live capability catalog and the contact-directory contract before storing the Mail settings.",
    ...requiresAuth,
    responses: {
      200: jsonResponse(mailContactDirectoryUpdateSchema, "Stored contact directory mapping"),
      400: jsonResponse(contactDirectoryInvalidResponseSchema, "Mapping Mail cannot use, with field-level issues"),
      403: jsonResponse(ErrorResponseSchema, "Cloud administration access is required"),
      503: jsonResponse(ErrorResponseSchema, "Capability catalog unavailable"),
    },
  }),
  v("json", mailContactDirectoryUpdateSchema),
  async (c) => {
    const locale = getLocale(c);
    const result = await contactDirectory.saveContactDirectory(requestContext(c), c.req.valid("json"), locale);
    if (result.ok) return c.json(result.config, 200);
    if (result.status === 400) {
      const message = contactDirectoryMessages.resolve([locale]).t.fixBeforeSaving;
      return c.json({ message, code: "CONTACT_DIRECTORY_INVALID", issues: result.issues }, 400);
    }
    return c.json({ message: result.message }, result.status);
  },
);
