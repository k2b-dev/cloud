import { ErrorResponseSchema } from "@k2b/cloud/contracts";
import { auth, expectUserBackedActor, getLocale, jsonResponse, requiresAuth, v } from "@k2b/cloud/server";
import { settingsService } from "@k2b/cloud/services";
import { type Context, Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import { contactDirectoryMessages } from "../contact-directory-messages";
import {
  MAIL_CONTACT_DIRECTORY_SETTING_KEYS,
  mailContactDirectoryPatchSchema,
  mailContactDirectoryUpdateSchema,
  requestContactDirectoryConfig,
} from "../contact-directory-settings";
import { contactDirectory } from "../service";
import type { MailApiContext } from "./public-resource-boundary";
import { WORKFLOW_AI_BODY_MAX_CHARS_KEY } from "./workflow-ai-settings";

const requestContext = (c: Context<MailApiContext>) => {
  const authority = auth.getAuthority(c);
  return { actor: authority.actor, accessSubject: authority.accessSubject, authority, requestId: c.req.header("x-request-id") ?? null };
};

const contactDirectoryIssueSchema = z.object({
  field: z.enum(["appId", "suggest", "resolve", "read", "listWritableBooks", "create"]),
  code: z.string(),
  message: z.string(),
});

const contactDirectoryInvalidResponseSchema = ErrorResponseSchema.extend({ issues: z.array(contactDirectoryIssueSchema) });

const capabilityOptionsSchema = z.array(z.object({ id: z.string(), title: z.string() }));
const contactDirectoryAdminViewSchema = z.object({
  config: mailContactDirectoryUpdateSchema,
  unreadable: z.record(z.string(), z.boolean()),
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
    .describe(
      "Apps the acting administrator can use with their compatible capabilities per function; null when the capability catalog is unavailable",
    ),
  issues: z.array(contactDirectoryIssueSchema).describe("Why Mail cannot fully use the stored mapping"),
});

// Mounted below the Cloud-admin guard of the Mail admin API. The 400 body adds field-level `issues`.
export default new Hono<MailApiContext>()
  .put(
    "/admin/settings/:key",
    describeRoute({
      tags: ["Mail:Admin"],
      summary: "Set one Mail setting through its owning validator",
      description: "Validates contact-directory changes against the complete current mapping before storing them.",
      ...requiresAuth,
      responses: {
        200: jsonResponse(z.object({ saved: z.literal(true) }), "Setting saved"),
        400: jsonResponse(ErrorResponseSchema, "Unknown setting or invalid value"),
        403: jsonResponse(ErrorResponseSchema, "Cloud administration access is required"),
        409: jsonResponse(
          z.object({ code: z.literal("setting_unreadable"), message: z.string() }),
          "Stored value needs explicit replacement",
        ),
        503: jsonResponse(ErrorResponseSchema, "Capability catalog unavailable"),
      },
    }),
    v("json", z.object({ value: z.unknown(), replaceUnreadable: z.boolean().optional() })),
    async (c) => {
      const key = c.req.param("key");
      const body = c.req.valid("json");
      const mapping = Object.entries(MAIL_CONTACT_DIRECTORY_SETTING_KEYS).find(([, settingKey]) => settingKey === key);
      if (mapping) {
        const [field, settingKey] = mapping;
        if (typeof body.value !== "string") return c.json({ message: "Expected a string setting value" }, 400);
        const result = await contactDirectory.saveContactDirectory(
          requestContext(c),
          {
            [field]: body.value,
            ...(body.replaceUnreadable ? { replaceUnreadable: [settingKey] } : {}),
          },
          getLocale(c),
        );
        if (result.ok) return c.json({ saved: true });
        if (result.status === 400)
          return c.json(
            {
              message: contactDirectoryMessages.resolve([getLocale(c)]).t.singleSettingInvalid,
              code: "CONTACT_DIRECTORY_INVALID",
              issues: result.issues,
            },
            400,
          );
        return c.json({ message: result.message }, result.status);
      }
      if (key !== WORKFLOW_AI_BODY_MAX_CHARS_KEY) return c.json({ message: "Unknown application setting" }, 400);
      const result = await settingsService.entry.update({
        key,
        value: body.value,
        replaceUnreadable: body.replaceUnreadable,
        audit: {
          action: "settings.update",
          outcome: "allowed",
          actor: { userId: expectUserBackedActor(c).id },
          target: { type: "setting", id: key },
        },
      });
      if (!result.ok) return c.json({ message: result.error.message }, result.error.status === 400 ? 400 : 500);
      return c.json({ saved: true });
    },
  )
  .get(
    "/admin/contact-directory",
    describeRoute({
      tags: ["Mail:Admin"],
      summary: "Show the contact directory mapping and compatible capabilities",
      description:
        "Returns the stored mapping, each app the acting administrator can use with its compatible contact-directory capabilities, and problems with the stored mapping.",
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
        409: jsonResponse(
          z.object({ code: z.literal("setting_unreadable"), message: z.string() }),
          "Stored key needs explicit replacement",
        ),
        503: jsonResponse(ErrorResponseSchema, "Capability catalog unavailable"),
      },
    }),
    v("json", mailContactDirectoryPatchSchema),
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
