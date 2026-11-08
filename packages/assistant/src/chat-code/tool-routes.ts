import { CODE_CAPABILITY_TOKEN_HEADER } from "@k2b/cloud/ai";
import { type AuthContext, auth, getLocale, getTimeZone, requireInvocation } from "@k2b/cloud/server";
import { appAccessAuthority } from "@k2b/cloud/services";
import { ImageMetadataError } from "@k2b/cloud/services/image-metadata";
import { readThemeFromCookieHeader } from "@k2b/cloud/shared";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { ChatReference, requireToolChat } from "./chat-access";
import type { CodeToolContext } from "./context";
import { LIMITS } from "./contracts";
import { ArtifactError } from "./identity";

export const createCodeToolRoutes = () =>
  new Hono<AuthContext>().use("*", bodyLimit({ maxSize: LIMITS.rpcBytes })).onError((error, c) => {
    if (error instanceof ImageMetadataError) return c.json({ ok: false, error: { code: error.code, message: error.message } }, 422);
    if (error instanceof z.ZodError)
      return c.json({ ok: false, error: { code: "INVALID_INPUT", message: "Invalid code tool input." } }, 400);
    console.error("Assistant code tool failed", error);
    return c.json(
      { ok: false, error: { code: "REQUEST_FAILED", message: "Code tool failed. Inspect resource state before retrying a write." } },
      500,
    );
  });
export function registerCodeTool<S extends z.ZodType>(
  codeToolRoutes: Hono<AuthContext>,
  name: string,
  schema: S,
  run: (input: z.output<S>, context: CodeToolContext) => Promise<unknown>,
) {
  codeToolRoutes.post(
    `/${name}`,
    [
      "code_files",
      "code_file_stat",
      "code_manage_read",
      "code_database_read",
      "code_storage_list",
      "code_versions",
      "code_list",
      "code_read",
      "code_history",
    ].includes(name)
      ? auth.readOnly
      : auth.requireOAuthScope("write", "admin"),
    requireInvocation(() => ({ targetAppId: "assistant", operation: `tool:${name}`, schemaHash: null })),
    async (c) => {
      const envelope = z
        .object({ input: z.unknown(), conversationId: ChatReference, review: z.boolean().optional() })
        .strict()
        .parse(await c.req.json());
      const input = schema.parse(envelope.input);
      const actor = c.get("actor");
      if (actor.kind !== "user") return c.json({ ok: false, error: { code: "ACCESS_DENIED", message: "A user is required." } }, 403);
      const conversation = await requireToolChat(envelope.conversationId, { actor, accessSubject: c.get("accessSubject") }, name).catch(
        (error: unknown) => {
          if (error instanceof ArtifactError && error.code === "ACCESS_DENIED") return null;
          throw error;
        },
      );
      if (!conversation) return c.json({ ok: false, error: { code: "ACCESS_DENIED", message: "Conversation access denied." } }, 403);
      return Response.json(
        await run(input, {
          authority: appAccessAuthority(c),
          actor,
          accessSubject: c.get("accessSubject"),
          conversationId: conversation.id,
          locale: getLocale(c),
          timeZone: getTimeZone(c),
          theme: readThemeFromCookieHeader(c.req.header("cookie")),
          review: envelope.review,
          signal: c.req.raw.signal,
          capabilityToken: c.req.header(CODE_CAPABILITY_TOKEN_HEADER),
        }),
      );
    },
  );
}
