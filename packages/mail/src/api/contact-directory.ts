import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { getLocale, jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { contactDirectoryMessages } from "../contact-directory-messages";
import { mailContactDirectoryUpdateSchema, requestContactDirectoryConfig } from "../contact-directory-settings";
import { contactDirectory, type MailRequestContext } from "../service";
import type { MailApiContext } from "./public-resource-boundary";

const requestContext = (c: Context<MailApiContext>): MailRequestContext => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  requestId: c.req.header("x-request-id") ?? null,
});

const contactDirectoryIssueSchema = z.object({
  field: z.enum(["appId", "suggest", "resolve", "read", "listWritableBooks", "create"]),
  code: z.string(),
  message: z.string(),
});

const contactDirectoryInvalidResponseSchema = ErrorResponseSchema.extend({ issues: z.array(contactDirectoryIssueSchema) });

const capabilityOptionsSchema = z.array(z.object({ id: z.string(), title: z.string() }));
const contactDirectoryAdminViewSchema = z.object({
  config: mailContactDirectoryUpdateSchema,
  apps: z
    .array(
      z.object({
        appId: z.string(),
        appName: z.string(),
        appIcon: z.string(),
        capabilities: z.object({
          suggest: capabilityOptionsSchema,
          resolve: capabilityOptionsSchema,
          read: capabilityOptionsSchema,
          listWritableBooks: capabilityOptionsSchema,
          create: capabilityOptionsSchema,
        }),
      }),
    )
    .nullable()
    .describe("Installed apps with their compatible capabilities per function; null when the capability catalog is unavailable"),
  issues: z.array(contactDirectoryIssueSchema).describe("Why Mail cannot fully use the stored mapping"),
});

// Mounted below the Cloud-admin guard of the Mail admin API. The 400 body adds field-level `issues`.
export default new Hono<MailApiContext>()
  .get(
    "/admin/contact-directory",
    describeRoute({
      tags: ["Mail:Admin"],
      summary: "Show the contact directory mapping and compatible capabilities",
      description:
        "Returns the stored mapping, every installed app with the capabilities compatible with each contact-directory function, and problems with the stored mapping.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(contactDirectoryAdminViewSchema, "Contact directory mapping and candidates"),
        403: jsonResponse(ErrorResponseSchema, "Cloud administration access is required"),
      },
    }),
    async (c) => {
      const view = await contactDirectory.loadContactDirectoryAdmin(requestContext(c), requestContactDirectoryConfig(c), getLocale(c));
      if (view.ok) return c.json(view.data, 200);
      return c.json({ message: view.error.message }, 403);
    },
  )
  .put(
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
