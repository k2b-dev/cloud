import { authorizeCodeExecution, createAiConversationArtifact, listAiConversationFiles, readAiConversationFile } from "@k2b/cloud/ai";
import { env } from "@k2b/cloud/config";
import { type AuthContext, LOCALE_HEADER, TIMEZONE_COOKIE } from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { createAgentHost, type Session } from "../chat-code/agent-host";
import { hostFetch as chatHostFetch } from "../chat-code/host-fetch";
import { createArtifactServiceRoutes } from "./api";
import type { CodeToolContext } from "./code-tools";
import { appChecks } from "./html/check-service";
import { httpService } from "./http-service";
import { createManagedCodeHost } from "./managed-code-host";

export { AgentHostRequest } from "../chat-code/agent-host";

const keyOf = (turnId: string, callId: string) => `${turnId}:${callId}`;

export async function hostFetch(context: CodeToolContext, session: Session, path: string, init?: RequestInit): Promise<Response> {
  if (context.actor.kind !== "user" || !context.conversationId) throw new Error("User required");
  const url = new URL(path, "http://localhost");
  if (url.pathname.startsWith("/api/assistant/chat-code/")) return chatHostFetch(context, session, path, init);
  if (url.pathname === "/api/assistant/artifacts/runtime/check/discard" && init?.method === "POST") {
    const { id } = z
      .object({ id: z.string() })
      .strict()
      .parse(await new Request(url, init).json());
    if (session.checkScopes.has(id)) {
      // Cancellation revokes execution authority, not cleanup of this host's
      // own disposable copies. The service still checks scratch/admin access.
      await appChecks.discard(id, context);
      session.checkScopes.delete(id);
      return Response.json({ discarded: true });
    }
  }
  await authorizeCodeExecution(context.conversationId, session.turnId, context.actor.user.id);
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
  if (!url.pathname.startsWith("/api/assistant/artifacts/")) throw new Error("Code host request is outside its API boundary");
  const headers = new Headers(init?.headers);
  headers.set(LOCALE_HEADER, context.locale);
  headers.set("cookie", `${TIMEZONE_COOKIE}=${encodeURIComponent(context.timeZone)}; theme=${context.theme ?? "light"}`);
  const request = new Request(url, { ...init, headers });
  const router = new Hono<AuthContext>()
    .onError((error) =>
      Response.json(
        {
          code: "CODE_HOST_REQUEST_FAILED",
          message: error.message,
        },
        { status: 403 },
      ),
    )
    .use("*", async (c, next) => {
      if (context.authority) {
        c.set("credentialKind", context.authority.credentialKind);
        c.set("credentialScopes", context.authority.scopes);
      }
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      await next();
    })
    .route(
      "/api/assistant/artifacts",
      createArtifactServiceRoutes(() => ({
        transport: session.capabilityTransport,
        origin: "assistant",
        locale: context.locale,
        signal: init?.signal ?? undefined,
      })),
    );
  const checking = session.lastCall ? session.checks.get(keyOf(session.lastCall.turnId, session.lastCall.callId))?.controller : undefined;
  const response = await router.fetch(request);
  if (url.pathname === "/api/assistant/artifacts/runtime/check/start" && response.ok) {
    const { scopeId } = z.object({ scopeId: z.string() }).parse(await response.clone().json());
    // A cancelled caller may never receive this scope ID. Do not retain it
    // until host shutdown when creation completed after cancellation.
    if (checking?.signal.aborted || init?.signal?.aborted) await appChecks.discard(scopeId, context);
    else session.checkScopes.add(scopeId);
  }
  return response;
}

export const agentHost = createAgentHost({
  createHost: (options) =>
    createManagedCodeHost(
      options,
      env.NODE_ENV === "production" ? { entry: new URL("./assistant-code-host-process.js", import.meta.url).pathname } : undefined,
    ),
  fetch: hostFetch,
  website: (id, context) => httpService.website(id, context),
  discard: (id, context) => appChecks.discard(id, context),
});
