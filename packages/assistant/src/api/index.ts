import { isConversationResourceCursor } from "@k2b/cloud/ai";
import { type AuthContext, auth, err, fail, getTimeZone, ok, rateLimit, respond, v } from "@k2b/cloud/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { artifactApi } from "../artifacts/api";
import { loadAssistantChatContextSnapshot, loadAssistantChatSources } from "../chat-context";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import { loadAssistantSidebarPreview } from "../sidebar-preview";

const actorUser = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

/** The platform's sources query: `kind` lists kinds separated by commas, `observed=true` leaves out Project context. */
const ChatSourcesQuery = z.object({
  q: z.string().trim().max(500).optional(),
  cursor: z
    .string()
    .min(1)
    .max(2_048)
    .refine((value) => isConversationResourceCursor(value, "conversation"), "Invalid source cursor")
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  kind: z
    .string()
    .max(64)
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(["result", "web", "file", "resource", "activity"])).min(1))
    .optional(),
  observed: z.enum(["true", "false"]).optional(),
});

const app = new Hono<AuthContext>()
  .use(rateLimit())
  .use("*", auth.requireRole("authenticated"))
  .use("*", auth.requireUser())
  .route("/artifacts", artifactApi)
  .get("/workspace/sidebar", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    return respond(c, ok(await loadAssistantSidebarSnapshot(user.id)));
  })
  .get("/workspace/conversations/:conversationId/preview", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const preview = await loadAssistantSidebarPreview(user.id, c.req.param("conversationId"));
    return preview ? respond(c, ok(preview)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/conversations/:conversationId/context", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const snapshot = await loadAssistantChatContextSnapshot(user.id, c.req.param("conversationId")!, { timeZone: getTimeZone(c) });
    return snapshot ? respond(c, ok(snapshot)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/conversations/:conversationId/sources", v("query", ChatSourcesQuery), async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const query = c.req.valid("query");
    const page = await loadAssistantChatSources(user.id, c.req.param("conversationId")!, {
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
      kinds: query.kind,
      observed: query.observed === "true",
    });
    return page ? respond(c, ok(page)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/projects/:projectId/context", async (c) => {
    const snapshot = await loadAssistantProjectContextSnapshot(
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      c.req.param("projectId")!,
    );
    return snapshot ? respond(c, ok(snapshot)) : respond(c, fail(err.notFound("Project")));
  });

export default app;
export type ApiType = typeof app;
