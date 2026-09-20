import { agentHost, AgentHostRequest } from "./agent-host";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AuthContext, requireInvocation, getLocale } from "@k2b/cloud/server";
import { CODE_SOURCE_TOOLS, aiConversations } from "@k2b/cloud/ai";
import { artifactCodeHandlers, type CodeToolContext } from "./code-tools";
import { LIMITS } from "./contracts";

export const codeToolRoutes = new Hono<AuthContext>().use("*", bodyLimit({ maxSize: LIMITS.rpcBytes })).onError((error, c) => {
  if (error instanceof z.ZodError) return c.json({ ok: false, error: { code: "INVALID_INPUT", message: "Invalid code tool input." } }, 400);
  console.error("Assistant code tool failed", error);
  return c.json(
    { ok: false, error: { code: "REQUEST_FAILED", message: "Code tool failed. Inspect resource state before retrying a write." } },
    500,
  );
});

function register<S extends z.ZodType>(name: string, schema: S, run: (input: z.output<S>, context: CodeToolContext) => Promise<unknown>) {
  codeToolRoutes.post(
    `/${name}`,
    requireInvocation(() => ({ targetAppId: "assistant", operation: `tool:${name}`, schemaHash: null })),
    async (c) => {
      const envelope = z
        .object({ input: z.unknown(), conversationId: z.uuid(), review: z.boolean().optional() })
        .strict()
        .parse(await c.req.json());
      const input = schema.parse(envelope.input);
      const actor = c.get("actor");
      if (actor.kind !== "user") return c.json({ ok: false, error: { code: "ACCESS_DENIED", message: "A user is required." } }, 403);
      const conversation = await aiConversations.getConversation({ conversationId: envelope.conversationId, ownerUserId: actor.user.id });
      if (!conversation || conversation.archivedAt || (conversation.allowedTools && !conversation.allowedTools.includes(name))) {
        return c.json({ ok: false, error: { code: "ACCESS_DENIED", message: "Conversation access denied." } }, 403);
      }
      return Response.json(
        await run(input, {
          actor,
          accessSubject: c.get("accessSubject"),
          conversationId: conversation.id,
          locale: getLocale(c),
          review: envelope.review,
          signal: c.req.raw.signal,
        }),
      );
    },
  );
}

register("code_files", CODE_SOURCE_TOOLS.code_files.input, artifactCodeHandlers.code_files);
register("code_file_stat", CODE_SOURCE_TOOLS.code_file_stat.input, artifactCodeHandlers.code_file_stat);
register("code_file_copy", CODE_SOURCE_TOOLS.code_file_copy.input, artifactCodeHandlers.code_file_copy);
register("code_database_export", CODE_SOURCE_TOOLS.code_database_export.input, artifactCodeHandlers.code_database_export);
register("code_manage_read", CODE_SOURCE_TOOLS.code_manage_read.input, artifactCodeHandlers.code_manage_read);
register("code_delete", CODE_SOURCE_TOOLS.code_delete.input, artifactCodeHandlers.code_delete);
register("code_database_read", CODE_SOURCE_TOOLS.code_database_read.input, artifactCodeHandlers.code_database_read);
register("code_database_clear", CODE_SOURCE_TOOLS.code_database_clear.input, artifactCodeHandlers.code_database_clear);
register("code_database_reset", CODE_SOURCE_TOOLS.code_database_reset.input, artifactCodeHandlers.code_database_reset);
register("code_storage_list", CODE_SOURCE_TOOLS.code_storage_list.input, artifactCodeHandlers.code_storage_list);
register("code_storage_delete", CODE_SOURCE_TOOLS.code_storage_delete.input, artifactCodeHandlers.code_storage_delete);
register("code_access_read", CODE_SOURCE_TOOLS.code_access_read.input, artifactCodeHandlers.code_access_read);
register("code_access_change", CODE_SOURCE_TOOLS.code_access_change.input, artifactCodeHandlers.code_access_change);
register("code_actions", CODE_SOURCE_TOOLS.code_actions.input, artifactCodeHandlers.code_actions);
register("code_sql", CODE_SOURCE_TOOLS.code_sql.input, artifactCodeHandlers.code_sql);
register("code_versions", CODE_SOURCE_TOOLS.code_versions.input, artifactCodeHandlers.code_versions);
register("code_list", CODE_SOURCE_TOOLS.code_list.input, artifactCodeHandlers.code_list);
register("code_read", CODE_SOURCE_TOOLS.code_read.input, artifactCodeHandlers.code_read);
register("code_history", CODE_SOURCE_TOOLS.code_history.input, artifactCodeHandlers.code_history);
register("code_fork", CODE_SOURCE_TOOLS.code_fork.input, artifactCodeHandlers.code_fork);
register("code_publish", CODE_SOURCE_TOOLS.code_publish.input, artifactCodeHandlers.code_publish);
register("code_unpublish", CODE_SOURCE_TOOLS.code_unpublish.input, artifactCodeHandlers.code_unpublish);
register("code_restore", CODE_SOURCE_TOOLS.code_restore.input, artifactCodeHandlers.code_restore);
register("code_update", CODE_SOURCE_TOOLS.code_update.input, artifactCodeHandlers.code_update);
register("code_create", CODE_SOURCE_TOOLS.code_create.input, artifactCodeHandlers.code_create);
register("code_write", CODE_SOURCE_TOOLS.code_write.input, artifactCodeHandlers.code_write);
register("code_remove", CODE_SOURCE_TOOLS.code_remove.input, artifactCodeHandlers.code_remove);

for (const name of ["code_run","code_action","code_inspect","code_interact","code_stop","code_export","code_present"] as const) {
  register(name,AgentHostRequest.refine(input=>input.name===name),async(input,context)=>ok(await agentHost.call(input,context)));
}
