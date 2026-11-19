import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";
import { type AuthContext, err, fail, getLocale, ok, respond, v } from "../server";
import { toAiErrorResponse } from "./http";
import { AiMessageQueueConflict } from "./message-queue";
import { AiQuotaError } from "./quotas";
import { isAiSettingsError } from "./validate";
import { catchUpAiWakeup } from "./wakeup-catch-up";
import { AiWakeupInputSchema, AiWakeupPatchSchema } from "./wakeup-contracts";
import { aiWakeupMessages } from "./wakeup-messages";
import { AiWakeupError, aiWakeups } from "./wakeups";

const chatParams = z.object({ conversationId: z.string().min(1) });
const wakeupParams = chatParams.extend({ wakeupId: z.uuid() });

/** Mounted under the authenticated /api/ai/conversations API; services check owner and Project again. */
export const aiWakeupRoutes = new Hono<AuthContext>()
  .use("/:conversationId/wakeups/*", bodyLimit({ maxSize: CAPABILITY_MAX_RESULT_BYTES }))
  .onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    if (error instanceof AiWakeupError) {
      const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
      return c.json({ code: `wakeup_${error.code}`, message: aiWakeupMessages(getLocale(c))[error.code] }, status);
    }
    if (error instanceof AiMessageQueueConflict)
      return c.json({ code: "wakeup_queue_full", message: aiWakeupMessages(getLocale(c)).queue_full }, 409);
    if (error instanceof AiQuotaError || isAiSettingsError(error)) return toAiErrorResponse(c, error);
    throw error;
  })
  .get("/:conversationId/wakeups", v("param", chatParams), async (c) => {
    const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
    return respond(c, ok(await aiWakeups.list(c.req.valid("param").conversationId, subject, getLocale(c))));
  })
  .post(
    "/:conversationId/wakeups",
    bodyLimit({ maxSize: CAPABILITY_MAX_RESULT_BYTES }),
    v("param", chatParams),
    v("json", AiWakeupInputSchema),
    async (c) => {
      const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
      if (subject.actor.kind !== "user" || subject.actor.delegation || c.get("credentialKind") !== "session")
        return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
      return respond(c, ok(await aiWakeups.create(c.req.valid("param").conversationId, c.req.valid("json"), subject, getLocale(c))), 201);
    },
  )
  .post(
    "/:conversationId/wakeups/:wakeupId/catch-up",
    v("param", wakeupParams),
    v("json", z.strictObject({ revision: z.number().int().nonnegative() })),
    async (c) => {
      const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
      if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
      return respond(
        c,
        ok(
          await catchUpAiWakeup(
            c.req.valid("param").conversationId,
            c.req.valid("param").wakeupId,
            c.req.valid("json").revision,
            subject,
            getLocale(c),
          ),
        ),
      );
    },
  )
  .patch("/:conversationId/wakeups/:wakeupId", v("param", wakeupParams), v("json", AiWakeupPatchSchema), async (c) => {
    const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
    if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
    return respond(
      c,
      ok(
        await aiWakeups.update(
          c.req.valid("param").conversationId,
          c.req.valid("param").wakeupId,
          c.req.valid("json"),
          subject,
          getLocale(c),
        ),
      ),
    );
  })
  .delete(
    "/:conversationId/wakeups/:wakeupId",
    v("param", wakeupParams),
    v("json", z.strictObject({ revision: z.number().int().nonnegative() })),
    async (c) => {
      const subject = { actor: c.get("actor"), accessSubject: c.get("accessSubject") };
      if (c.get("credentialKind") !== "session") return respond(c, fail(err.forbidden(aiWakeupMessages(getLocale(c)).forbidden)));
      return respond(
        c,
        ok(
          await aiWakeups.remove(
            c.req.valid("param").conversationId,
            c.req.valid("param").wakeupId,
            c.req.valid("json").revision,
            subject,
            getLocale(c),
          ),
        ),
      );
    },
  );
