import { aiConversations, isCloudAiFirecrawlConfigured, isConversationResourceCursor, readWebPageForPerson } from "@k2b/cloud/ai";
import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import {
  type AuthContext,
  auth,
  err,
  fail,
  getLocale,
  getTimeZone,
  ok,
  REQUEST_IDLE_TIMEOUT_SECONDS,
  rateLimit,
  respond,
  setRequestTimeout,
  v,
} from "@k2b/cloud/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { chatCodeApi } from "../chat-code/api";
import { loadAssistantChatContextSnapshot, loadAssistantChatSources } from "../chat-context";
import { SaveChatWorkspaceSchema } from "../chat-workspace";
import { loadAssistantChatWorkspace, saveAssistantChatWorkspace } from "../chat-workspace-service";
import { loadCodeChatGroup } from "../code-chat-group";
import { catalogPerApp } from "../code-place";
import { loadAssistantProjectContextSnapshot } from "../project-context";
import { loadAssistantSidebarSnapshot, openQuestionsCaller, placeAppsFromCatalog } from "../sidebar";
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
  .route("/chat-code", chatCodeApi)
  .get("/workspace/sidebar", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    return respond(
      c,
      ok(
        await loadAssistantSidebarSnapshot(
          { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
          { locale: getLocale(c), timeZone: getTimeZone(c), caller: openQuestionsCaller(c) },
          placeAppsFromCatalog(catalogPerApp(getLocale(c), auth.getAuthority(c))),
        ),
      ),
    );
  })
  .get("/workspace/conversations/:conversationId/preview", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const preview = await loadAssistantSidebarPreview(
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      c.req.param("conversationId"),
    );
    return preview ? respond(c, ok(preview)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/conversations/:conversationId/context", async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const snapshot = await loadAssistantChatContextSnapshot(
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      c.req.param("conversationId")!,
      {
        timeZone: getTimeZone(c),
        locale: getLocale(c),
        // Gustav reads the chat's Code through Core's public query with the person's own credentials.
        groups: [
          (conversation) =>
            loadCodeChatGroup(
              (invocation, schema) =>
                invokeCapabilityWithDataSchema(invocation, schema, { ...openQuestionsCaller(c), signal: c.req.raw.signal }),
              conversation.id,
              getLocale(c),
            ),
        ],
      },
    );
    return snapshot ? respond(c, ok(snapshot)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/conversations/:conversationId/tabs", async (c) => {
    const workspace = await loadAssistantChatWorkspace(auth.getAuthority(c), c.req.param("conversationId"));
    return workspace ? respond(c, ok(workspace)) : respond(c, fail(err.notFound("Conversation")));
  })
  .put("/workspace/conversations/:conversationId/tabs", v("json", SaveChatWorkspaceSchema), async (c) => {
    const result = await saveAssistantChatWorkspace(auth.getAuthority(c), c.req.param("conversationId")!, c.req.valid("json"));
    return result ? respond(c, ok(result)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/conversations/:conversationId/sources", v("query", ChatSourcesQuery), async (c) => {
    const user = actorUser(c);
    if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
    const query = c.req.valid("query");
    const page = await loadAssistantChatSources(
      { actor: c.get("actor"), accessSubject: c.get("accessSubject") },
      c.req.param("conversationId")!,
      {
        q: query.q,
        cursor: query.cursor,
        limit: query.limit,
        kinds: query.kind,
        observed: query.observed === "true",
      },
    );
    return page ? respond(c, ok(page)) : respond(c, fail(err.notFound("Conversation")));
  })
  .get("/workspace/web-reader", async (c) => respond(c, ok({ available: await isCloudAiFirecrawlConfigured() })))
  .post(
    "/workspace/conversations/:conversationId/web-reader",
    auth.readOnly,
    v("json", z.object({ url: z.string().min(1).max(2_048), confirmed: z.boolean().optional() }).strict()),
    async (c) => {
      const user = actorUser(c);
      if (!user) return respond(c, fail(err.forbidden("Assistant requires a user-backed actor")));
      const conversation = await aiConversations.getConversationByShortId({
        shortId: c.req.param("conversationId")!,
        ownerUserId: user.id,
      });
      if (!conversation) return respond(c, fail(err.notFound("Conversation")));
      setRequestTimeout(c, 120);
      try {
        const result = await readWebPageForPerson({
          actor: c.get("actor"),
          conversationId: conversation.id,
          ...c.req.valid("json"),
          signal: c.req.raw.signal,
        });
        return respond(c, ok(result));
      } finally {
        setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
      }
    },
  )
  .get("/workspace/projects/:projectId/context", async (c) => {
    const snapshot = await loadAssistantProjectContextSnapshot(auth.getAuthority(c), c.req.param("projectId")!);
    return snapshot ? respond(c, ok(snapshot)) : respond(c, fail(err.notFound("Project")));
  });

export default app;
export type ApiType = typeof app;
