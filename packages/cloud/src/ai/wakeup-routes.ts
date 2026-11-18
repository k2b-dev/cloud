import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";
import { type AuthContext, err, fail, getLocale, ok, respond, v } from "../server";
import { catchUpAiWakeup } from "./wakeup-catch-up";
import { aiWakeupMessages } from "./wakeup-messages";
import { AiWakeupInputSchema, AiWakeupPatchSchema } from "./wakeup-contracts";
import { AiWakeupError, aiWakeups } from "./wakeups";

/** Mounted under the authenticated /api/ai/conversations API; services check owner and Project again. */
export const aiWakeupRoutes = new Hono<AuthContext>()
  .use("/:conversationId/wakeups/*", bodyLimit({ maxSize: CAPABILITY_MAX_RESULT_BYTES }))
  .onError((error, c) => {
    if (!(error instanceof AiWakeupError)) throw error;
    const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
    return c.json({ code: `wakeup_${error.code}`, message: aiWakeupMessages(getLocale(c))[error.code] }, status);
  })
  .get("/:conversationId/wakeups", async (c) => {
    const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
    return respond(c, ok(await aiWakeups.list(c.req.param("conversationId"), subject, getLocale(c))));
  })
  .post("/:conversationId/wakeups", bodyLimit({ maxSize: CAPABILITY_MAX_RESULT_BYTES }), v("json", AiWakeupInputSchema), async (c) => {
    const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
    if (subject.actor.kind !== "user" || subject.actor.delegation || c.get("credentialKind") !== "session")
      return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
    return respond(c, ok(await aiWakeups.create(c.req.param("conversationId"), c.req.valid("json"), subject, getLocale(c))), 201);
  })
  .post("/:conversationId/wakeups/:wakeupId/catch-up", v("param", z.object({ conversationId: z.string(), wakeupId: z.uuid() })),
    v("json", z.strictObject({ revision: z.number().int().nonnegative() })), async (c) => {
      const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
      if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
      return respond(c, ok(await catchUpAiWakeup(c.req.param("conversationId"), c.req.param("wakeupId"), c.req.valid("json").revision, subject, getLocale(c))));
    })
  .patch("/:conversationId/wakeups/:wakeupId", v("param", z.object({ conversationId: z.string(), wakeupId: z.uuid() })), v("json", AiWakeupPatchSchema), async (c) => {
    const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
    if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
    return respond(c, ok(await aiWakeups.update(c.req.param("conversationId"), c.req.param("wakeupId"), c.req.valid("json"), subject, getLocale(c))));
  })
  .delete("/:conversationId/wakeups/:wakeupId", v("param", z.object({ conversationId: z.string(), wakeupId: z.uuid() })),
    v("json", z.strictObject({ revision: z.number().int().nonnegative() })), async (c) => {
      const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
      if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
      return respond(c, ok(await aiWakeups.remove(c.req.param("conversationId"), c.req.param("wakeupId"), c.req.valid("json").revision, subject, getLocale(c))));
    });
