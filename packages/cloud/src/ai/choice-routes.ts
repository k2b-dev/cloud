import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CAPABILITY_MAX_RESULT_BYTES } from "../contracts/capability-limits";
import { type AuthContext, err, fail, respond, v } from "../server";
import { AiChoiceConflict, type AiChoiceTarget } from "./choices";
import { AiChoiceInputSchema, toAiErrorResponse } from "./http";
import type { AiChatRequestContext } from "./request-context";

/** Mounted inside the authenticated conversation API. Admission owns the transaction and all stored-view checks. */
export function createAiChoiceRoutes(dependencies: {
  resolveContext: (c: import("hono").Context<AuthContext>) => Promise<AiChatRequestContext | Response>;
  submit: (c: import("hono").Context<AuthContext>, context: AiChatRequestContext, target: AiChoiceTarget) => Promise<Response>;
}) {
  return new Hono<AuthContext>().post(
    "/:conversationId/choices",
    bodyLimit({ maxSize: CAPABILITY_MAX_RESULT_BYTES }),
    v("json", AiChoiceInputSchema),
    async (c) => {
      const context = await dependencies.resolveContext(c);
      if (context instanceof Response) return context;
      if (context.actor.kind !== "user" || !context.signedInSession)
        return respond(c, fail(err.forbidden("Choices require a signed-in browser session.")));
      try {
        return await dependencies.submit(c, context, c.req.valid("json"));
      } catch (error) {
        if (error instanceof AiChoiceConflict) return c.json({ code: error.code, message: error.message }, 409);
        return toAiErrorResponse(c, error);
      }
    },
  );
}
