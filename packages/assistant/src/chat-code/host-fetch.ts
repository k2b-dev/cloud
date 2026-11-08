import {
  aiChatTasks,
  authorizeCodeExecution,
  createAiConversationArtifact,
  listAiConversationFiles,
  readAiConversationFile,
} from "@k2b/cloud/ai";
import type { AuthContext } from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import type { Session } from "./agent-host";
import { createChatCodeServiceRoutes } from "./api";
import { RuntimeCapabilityRequest, runtimeCapabilities } from "./capability-runtime";
import type { CodeToolContext } from "./context";
import { backgroundChatCodeRouteAllowed } from "./host-policy";
import { httpService } from "./http-service";
export async function hostFetch(context: CodeToolContext, session: Session, path: string, init?: RequestInit): Promise<Response> {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("User required");
  const url = new URL(path, "http://localhost");
  const { config } = await authorizeCodeExecution(context.conversationId, session.turnId, context.actor.user.id);
  const prefix = `/api/ai/conversations/${context.conversationId}/files`;
  if (url.pathname === prefix && (init?.method ?? "GET") === "GET")
    return Response.json({ files: await listAiConversationFiles(context.conversationId) });
  if (url.pathname === `${prefix}/content` && (init?.method ?? "GET") === "GET") {
    const filePath = url.searchParams.get("path") ?? "";
    const stat = (await listAiConversationFiles(context.conversationId)).find((file) => file.path === filePath);
    const file =
      stat &&
      (await readAiConversationFile({
        conversationId: context.conversationId,
        ownerUserId: context.actor.user.id,
        path: filePath,
        version: url.searchParams.has("version") ? z.coerce.number().int().positive().parse(url.searchParams.get("version")) : stat.version,
      }));
    return file
      ? new Response(new Uint8Array(file.bytes).buffer, { headers: { "content-type": file.mediaType } })
      : new Response(null, { status: 404 });
  }
  if (url.pathname === prefix && init?.method === "POST") {
    const form = await new Request(url, init).formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Missing exported file");
    const producerCallKey = [...session.busy][0];
    if (!producerCallKey || session.busy.size !== 1) throw new Error("Export requires one active code call");
    const hash = new Bun.CryptoHasher("sha256").update(producerCallKey).digest("hex");
    const stored = await createAiConversationArtifact({
      conversationId: context.conversationId,
      ownerUserId: context.actor.user.id,
      path: `/files/${hash}/${file.name}`,
      bytes: new Uint8Array(await file.arrayBuffer()),
      mediaType: file.type || "application/octet-stream",
      producerCallKey,
    });
    return Response.json({ file: stored });
  }

  if (!url.pathname.startsWith("/api/assistant/chat-code/runtime/")) throw new Error("Code host request is outside its API boundary");
  if (config.background && !backgroundChatCodeRouteAllowed(url.pathname.slice("/api/assistant/chat-code".length), init?.method ?? "GET"))
    throw new Error("Background code request is outside its allowed services");
  const router = new Hono<AuthContext>()
    .use("*", async (c, next) => {
      if (context.authority) {
        c.set("credentialKind", context.authority.credentialKind);
        c.set("credentialScopes", context.authority.scopes);
      }
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      await next();
    })
    .post("/api/assistant/chat-code/runtime/capabilities", async (c, next) => {
      if (!config.background) return next();
      if (!config.mandate) throw new Error("Background capability mandate is missing");
      const input = RuntimeCapabilityRequest.parse(await c.req.json());
      if (input.conversationId !== context.conversationId) throw new Error("Code capability conversation mismatch");
      return c.json(
        await runtimeCapabilities.prepare(
          input,
          context,
          { transport: session.capabilityTransport, origin: "assistant", locale: context.locale, signal: c.req.raw.signal },
          { turnId: session.turnId, mandate: config.mandate },
        ),
      );
    })
    .post("/api/assistant/chat-code/runtime/http/:id", async (c, next) => {
      if (!config.background) return next();
      if (!config.mandate) throw new Error("Background HTTP mandate is missing");
      const { approved } = z.strictObject({ approved: z.boolean() }).parse(await c.req.json());
      return c.json(
        await httpService.execute(c.req.param("id"), approved, context, c.req.raw.signal, undefined, async (stored) => {
          if (stored.scope.conversationId !== context.conversationId) throw new Error("HTTP conversation mismatch");
          await aiChatTasks.authorizeRuntime({
            mandate: config.mandate!,
            kind: "http",
            input: { url: stored.request.url, origin: new URL(stored.request.url).origin, method: stored.request.method },
          });
        }),
      );
    })
    .route(
      "/api/assistant/chat-code",
      createChatCodeServiceRoutes(
        () => ({ transport: session.capabilityTransport, origin: "assistant", locale: context.locale, signal: init?.signal ?? undefined }),
        config.background ? session.turnId : undefined,
      ),
    );
  return router.fetch(new Request(url, init));
}
