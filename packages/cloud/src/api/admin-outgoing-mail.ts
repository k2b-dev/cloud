import { type Context, Hono, type MiddlewareHandler } from "hono";
import { validator } from "hono-openapi";
import { z } from "zod";
import { MailAppAccessSchema, MailProfileInputSchema, MailProfileKeySchema } from "../contracts/outgoing-mail";
import { type AuthContext, auth } from "../server";
import { type MailAuditContext, OutgoingMailError, outgoingMailStore } from "../services/outgoing-mail/store";
import { outgoingMailTest } from "../services/outgoing-mail/test-send";

const validate = <Target extends "param" | "json", Schema extends z.ZodType>(target: Target, schema: Schema) =>
  validator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error?.[0];
      const path = issue?.path?.map((part) => (typeof part === "object" && "key" in part ? String(part.key) : String(part))).join(".");
      return c.json(
        {
          code: "invalid_profile" as const,
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
