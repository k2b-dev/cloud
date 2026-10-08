import { sql } from "bun";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";
import {
  AdminMailRecordSchema,
  MailAppAccessSchema,
  MailProfileInputSchema,
  MailProfileKeySchema,
  MailRetentionSchema,
  MailStatusSchema,
} from "../contracts/outgoing-mail";
import { type AuthContext, auth, jsonResponse, requiresAdmin } from "../server";
import { audit } from "../services/audit";
import { outgoingMailLog } from "../services/outgoing-mail/admin";
import { MAIL_RETENTION_KEYS, readMailRetention } from "../services/outgoing-mail/retention";
import { type MailAuditContext, OutgoingMailError, outgoingMailStore } from "../services/outgoing-mail/store";
import { outgoingMailTest } from "../services/outgoing-mail/test-send";
import * as settings from "../services/settings";

const retentionInput = MailRetentionSchema.refine((value) => value.recordDays >= value.contentDays, {
  message: "Record retention must be at least content retention.",
  path: ["recordDays"],
});

const validate = <Target extends "param" | "json" | "query", Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
  code: "invalid_profile" | "bad_input" = "invalid_profile",
) =>
  validator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error?.[0];
      const path = issue?.path?.map((part) => (typeof part === "object" && "key" in part ? String(part.key) : String(part))).join(".");
      return c.json(
        {
          code,
          message: issue ? `${path ? `${path}: ` : ""}${issue.message}` : "Invalid outgoing mail configuration.",
        },
        400,
      );
    }
  });
const context = (c: Context<AuthContext>): MailAuditContext => ({
  actor: { userId: c.get("user").id, uid: c.get("user").uid, provider: c.get("user").provider, roles: c.get("user").roles },
  requestId: c.req.header("x-request-id"),
});
const idParam = z.object({ id: z.uuid() });
const logQuery = z
  .object({
    app: z.string().min(1).optional(),
    profile: MailProfileKeySchema.optional(),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : typeof value === "string" ? value.split(",") : value.flatMap((part) => part.split(",")),
      )
      .pipe(z.array(MailStatusSchema).max(6).optional()),
    since: z.iso.datetime({ offset: true }).optional(),
    ref: z
      .string()
      .min(1)
      .optional()
      .transform((value) => {
        if (value === undefined) return undefined;
        const colon = value.indexOf(":");
        return colon < 0 ? { scope: value } : { scope: value.slice(0, colon), id: value.slice(colon + 1) };
      })
      .pipe(z.object({ scope: z.string().min(1), id: z.string().min(1).optional() }).optional()),
    recipient: z.string().max(320).optional(),
    cursor: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
const logPage = z.object({
  items: z.array(AdminMailRecordSchema),
  page: z.int(),
  perPage: z.int(),
  total: z.int(),
  hasNext: z.boolean(),
  nextCursor: z.string().optional(),
});
const contentResponse = z.union([
  z.object({ purged: z.literal(true), contentPurgedAt: z.string() }),
  z.object({
    purged: z.literal(false),
    text: z.string().nullable(),
    html: z.string().nullable(),
    headers: z.record(z.string(), z.string()).nullable(),
  }),
]);
export const createAdminOutgoingMailRoutes = (authenticate: MiddlewareHandler<AuthContext> = auth.requireRole("admin")) =>
  new Hono<AuthContext>()
    .use("*", authenticate)
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      await next();
    })
    .onError((error, c) => {
      if (error instanceof OutgoingMailError) return c.json({ error: error.code, code: error.code, message: error.message }, error.status);
      throw error;
    })
    .get(
      "/retention",
      describeRoute({
        summary: "Read outgoing mail retention",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: { 200: jsonResponse(MailRetentionSchema, "Effective retention in days") },
      }),
      async (c) => c.json(await readMailRetention()),
    )
    .put(
      "/retention",
      describeRoute({
        summary: "Update outgoing mail retention",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: {
          200: jsonResponse(MailRetentionSchema, "Updated retention in days"),
          400: jsonResponse(z.object({ code: z.literal("bad_input"), message: z.string() }), "Invalid retention"),
        },
      }),
      validate("json", retentionInput, "bad_input"),
      async (c) => {
        const next = c.req.valid("json");
        const old = await readMailRetention();
        await sql.begin(async (tx) => {
          await settings.set(MAIL_RETENTION_KEYS[0], next.contentDays, tx);
          await settings.set(MAIL_RETENTION_KEYS[1], next.recordDays, tx);
          await audit.record(
            {
              ...context(c),
              action: "outgoing_mail.retention.update",
              outcome: "allowed",
              target: { type: "outgoing_mail_retention" },
              metadata: { old, new: next },
            },
            tx,
          );
        });
        await settings.invalidateSettingsCache(MAIL_RETENTION_KEYS);
        return c.json(next);
      },
    )
    .get(
      "/messages",
      describeRoute({
        summary: "List outgoing mail metadata",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: { 200: jsonResponse(logPage, "Send log") },
      }),
      validate("query", logQuery, "bad_input"),
      async (c) => {
        const { cursor, limit, ...filter } = c.req.valid("query");
        return c.json(await outgoingMailLog.list(filter, { cursor, perPage: limit }));
      },
    )
    .get(
      "/messages/:id",
      describeRoute({
        summary: "Read outgoing mail metadata",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: { 200: jsonResponse(AdminMailRecordSchema, "Message metadata") },
      }),
      validate("param", idParam, "bad_input"),
      async (c) => c.json(await outgoingMailLog.get(c.req.valid("param").id)),
    )
    .get(
      "/messages/:id/content",
      describeRoute({
        summary: "Read outgoing mail content with audit",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: { 200: jsonResponse(contentResponse, "Message content or purge marker") },
      }),
      validate("param", idParam, "bad_input"),
      async (c) => c.json(await outgoingMailLog.content(c.req.valid("param").id, context(c))),
    )
    .post(
      "/messages/:id/cancel",
      describeRoute({
        summary: "Cancel queued outgoing mail",
        tags: ["Outgoing mail"],
        ...requiresAdmin,
        responses: {
          200: jsonResponse(AdminMailRecordSchema, "Cancelled message"),
          409: jsonResponse(
            z.object({ code: z.literal("message_not_queued"), error: z.literal("message_not_queued"), message: z.string() }),
            "Only queued mail can be cancelled",
          ),
        },
      }),
      validate("param", idParam, "bad_input"),
      async (c) => c.json(await outgoingMailLog.cancel(c.req.valid("param").id, context(c))),
    )
    .get("/profiles", async (c) => c.json({ items: await outgoingMailStore.list() }))
    .get("/profiles/:key", async (c) => c.json(await outgoingMailStore.get(c.req.param("key"))))
    .put(
      "/profiles/:key",
      validate("param", z.object({ key: MailProfileKeySchema })),
      validate("json", MailProfileInputSchema),
      async (c) => {
        const result = await outgoingMailStore.put(c.req.valid("param").key, c.req.valid("json"), context(c));
        return c.json(result.profile, result.created ? 201 : 200);
      },
    )
    .post("/profiles/:key/default", async (c) => c.json(await outgoingMailStore.setDefault(c.req.param("key")!, context(c))))
    .delete("/profiles/:key", async (c) => {
      await outgoingMailStore.delete(c.req.param("key")!, context(c));
      return c.body(null, 204);
    })
    .post("/profiles/:key/test", validate("json", z.object({ recipient: z.email() }).strict()), async (c) => {
      await outgoingMailTest.send(c.req.param("key")!, c.req.valid("json").recipient, context(c));
      return c.json({ ok: true as const });
    })
    .get("/apps", async (c) => c.json(await outgoingMailStore.apps()))
    .put("/apps/:appId", validate("json", MailAppAccessSchema), async (c) =>
      c.json(await outgoingMailStore.setAppAccess(c.req.param("appId")!, c.req.valid("json"), context(c))),
    );
export default createAdminOutgoingMailRoutes();
