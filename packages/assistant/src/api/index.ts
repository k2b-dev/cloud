import { type AuthContext, auth, err, fail, getLocale, ok, rateLimit, respond } from "@k2b/cloud/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { artifactApi } from "../artifacts/api";
import { loadAssistantChatContextSnapshot } from "../chat-context";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot } from "../sidebar";
import { loadAssistantSidebarPreview } from "../sidebar-preview";

const actorUser = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

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
    const snapshot = await loadAssistantChatContextSnapshot(user.id, c.req.param("conversationId")!, getLocale(c));
    return snapshot ? respond(c, ok(snapshot)) : respond(c, fail(err.notFound("Conversation")));
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
