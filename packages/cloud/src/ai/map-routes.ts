import { Hono } from "hono";
import { z } from "zod";
import { withCapabilityRequestTimeout } from "../_internal/capability-timeout";
import type { CapabilityCaller } from "../capabilities/server";
import type { AuthContext } from "../server";
import { auth, getLocale, v } from "../server";
import { noTransform } from "../server/middleware/no-transform";
import { AiMapActionSchema } from "./map-contracts";
import { executeStoredAiMap } from "./map-execution";
import { aiMapNotebookContent } from "./map-notebook";
import { AiMapConflict, aiMaps } from "./map-store";
import { mapWebSourceWasRead } from "./map-tool";
import { resolveAiChatRequestContext } from "./request-context";
import { aiConversations } from "./store";

export const aiMapRoutes = new Hono<AuthContext>()
  .use("*", noTransform())
  .use("*", auth.requireRole("authenticated"))
  .use("*", auth.requireOAuthScope("read", "write", "admin"))
  .onError((error, c) =>
    c.json(
      { code: error instanceof AiMapConflict ? "MAP_REVISION_CONFLICT" : "MAP_ACTION_FAILED" },
      error instanceof AiMapConflict ? 409 : 400,
    ),
  )

  .get("/:conversationId/maps/:mapId", async (c) => {
    const ctx = await resolveAiChatRequestContext(c);
    if (ctx instanceof Response) return ctx;
    const params = z.object({ conversationId: z.string().min(1), mapId: z.uuid() }).safeParse(c.req.param());
    if (!params.success) return c.notFound();
    const conversation = await aiConversations.getConversationByShortId({
      shortId: params.data.conversationId,
      ownerUserId: ctx.ownerUserId,
    });
    if (!conversation) return c.notFound();
    const value = await aiMaps.read(conversation.id, params.data.mapId);
    c.header("Cache-Control", "private, no-store");
    return value ? c.json({ map: value.map, canAdmin: ctx.actor.kind === "user" && ctx.actor.user.roles.includes("admin") }) : c.notFound();
  })
  .get("/:conversationId/maps/:mapId/export", async (c) => {
    const ctx = await resolveAiChatRequestContext(c);
    if (ctx instanceof Response) return ctx;
    const params = z.object({ conversationId: z.string().min(1), mapId: z.uuid() }).safeParse(c.req.param());
    if (!params.success) return c.notFound();
    const conversation = await aiConversations.getConversationByShortId({
      shortId: params.data.conversationId,
      ownerUserId: ctx.ownerUserId,
    });
    if (!conversation) return c.notFound();
    const value = await aiMaps.read(conversation.id, params.data.mapId);
    if (!value) return c.notFound();
    c.header("Cache-Control", "private, no-store");
    return c.json({ content: aiMapNotebookContent(value.map), revision: value.map.revision, ownerUserId: ctx.ownerUserId });
  })
  .post("/:conversationId/maps/:mapId/action", auth.requireOAuthScope("write", "admin"), v("json", AiMapActionSchema), async (c) => {
    const ctx = await resolveAiChatRequestContext(c);
    if (ctx instanceof Response) return ctx;
    const params = z.object({ conversationId: z.string().min(1), mapId: z.uuid() }).safeParse(c.req.param());
    if (!params.success) return c.notFound();
    const conversation = await aiConversations.getConversationByShortId({
      shortId: params.data.conversationId,
      ownerUserId: ctx.ownerUserId,
    });
    if (!conversation) return c.notFound();
    const before = await aiMaps.read(conversation.id, params.data.mapId);
    const input = c.req.valid("json");
    if (!before || before.map.revision !== input.revision) throw new AiMapConflict();
    const caller: CapabilityCaller = {
      authority: auth.getAuthority(c),
      locale: getLocale(c),
      signal: c.req.raw.signal,
      origin: "assistant",
    };
    const next = await withCapabilityRequestTimeout(c, "query", () =>
      executeStoredAiMap(conversation.id, ctx.ownerUserId, before, input.command, {
        caller,
        allowCostOverrunRetry: ctx.signedInSession,
        verifyWeb: (url) => mapWebSourceWasRead(conversation.id, url),
      }),
    );
    c.header("Cache-Control", "private, no-store");
    return c.json({ map: next.map });
  });
