import { Hono } from "hono";
import { CloudResourceRefSchema } from "../contracts/capabilities";
import { type AuthContext, ok, respond, v } from "../server";
import { loadPlaceAssistant } from "./place-assistant";
import { resolveAiChatRequestContext } from "./request-context";

export const placeAssistantRoutes = new Hono<AuthContext>().get("/:type/:id", v("param", CloudResourceRefSchema), async (c) => {
  const ctx = await resolveAiChatRequestContext(c);
  if (ctx instanceof Response) return ctx;
  return respond(c, ok(await loadPlaceAssistant(c, c.req.valid("param"))));
});
