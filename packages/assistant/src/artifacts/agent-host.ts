import { sql } from "@k2b/cloud";
import {
  AiBackgroundApprovalRequiredError,
  aiChatTasks,
  authorizeCodeExecution,
  createAiConversationArtifact,
  listAiConversationFiles,
  readAiConversationFile,
} from "@k2b/cloud/ai";
import { CodeCheckInput } from "@k2b/cloud/ai/browser";
import { env } from "@k2b/cloud/config";
import { type AuthContext, LOCALE_HEADER, TIMEZONE_COOKIE } from "@k2b/cloud/server";
import { Hono } from "hono";
import { z } from "zod";
import { createAgentHost, type Session } from "../chat-code/agent-host";
import { ChatReference } from "../chat-code/chat-access";
import { hostFetch as chatHostFetch } from "../chat-code/host-fetch";
import { runCodeAi } from "./ai-service";
import { createArtifactServiceRoutes } from "./api";
import { backgroundCodeRouteAllowed, backgroundDatabaseOperation } from "./background-code-policy";
import { RuntimeCapabilityRequest, runtimeCapabilities } from "./capability-runtime";
import type { CodeToolContext } from "./code-tools";
import { DatabaseRequest } from "./database-contracts";
import { FlatDatabaseRequest } from "./database-runtime";
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
  if (!url.pathname.startsWith("/api/assistant/artifacts/")) throw new Error("Code host request is outside its API boundary");
  if (config.background && !backgroundCodeRouteAllowed(url.pathname.slice("/api/assistant/artifacts".length), init?.method ?? "GET"))
    return Response.json(
      {
        code: "BACKGROUND_ACCESS_DENIED",
        message:
          "Background code must use task-approved capabilities for external data and effects. This operation requires an interactive run.",
      },
      { status: 403 },
    );
  if (config.background && url.pathname === "/api/assistant/artifacts/runtime/check/capability")
    return Response.json({ ok: false, code: "unavailable", message: "not executed during code_check" }, { status: 403 });
  // Only this host's own check scopes bypass the task's real-data write grants.
  const scratchId = /^\/api\/assistant\/artifacts\/([^/]+)\/(?:database|storage)/.exec(url.pathname)?.[1];
  const [scratch] = scratchId
    ? await sql`SELECT check_scratch FROM assistant.artifacts
    WHERE short_id=${scratchId} AND check_conversation_id=${context.conversationId}::uuid AND check_scratch`
    : [];
  const headers = new Headers(init?.headers);
  let locale = context.locale,
    timeZone = context.timeZone,
    theme = context.theme ?? "light";
  if (config.background && url.pathname === "/api/assistant/artifacts/runtime/check/start") {
    const { input } = z
      .object({ input: CodeCheckInput, conversationId: ChatReference })
      .strict()
      .parse(await new Request(url, init).json());
    if (input.id) {
      const [connected] = await sql`SELECT d.artifact_id FROM assistant.artifact_databases d
        JOIN assistant.artifacts a ON a.id=d.artifact_id WHERE a.short_id=${input.id} AND d.connected`;
      if (connected) {
        try {
          await aiChatTasks.authorizeRuntime({
            mandate: config.mandate!,
            kind: "database",
            input: { resourceId: input.id, operation: "export" },
          });
        } catch (error) {
          return Response.json(
            { code: "BACKGROUND_ACCESS_DENIED", message: error instanceof Error ? error.message : "Database access denied" },
            { status: 403 },
          );
        }
      }
    }
    // Resolve check preferences here; scheduled turns retain their existing
    // Core behavior and never inherit the latest interactive turn.
    const task = await aiChatTasks.get({ userId: context.actor.user.id, taskId: config.background.taskId });
    if (!task) throw new Error("Scheduled check task is unavailable");
    locale = config.locale ?? context.locale;
    timeZone = config.timeZone ?? task.timezone;
    theme = config.theme ?? "light";
  }
  headers.set(LOCALE_HEADER, locale);
  headers.set("cookie", `${TIMEZONE_COOKIE}=${encodeURIComponent(timeZone)}; theme=${theme}`);
  const request = new Request(url, { ...init, headers });
  const database = /^\/api\/assistant\/artifacts\/([^/]+)\/database(?:\/maintenance)?(\/connect)?$/.exec(url.pathname);
  if (config.background && config.mandate && database && !scratch && request.method === "POST") {
    const input = database[2]
      ? { operation: "connect" }
      : (url.pathname.includes("/maintenance") ? DatabaseRequest : FlatDatabaseRequest).parse(await request.clone().json());
    try {
      await aiChatTasks.authorizeRuntime({
        mandate: config.mandate,
        kind: "database",
        input: {
          resourceId: database[1],
          ...input,
          operation:
            url.pathname.includes("/maintenance") || database[2]
              ? input.operation
              : backgroundDatabaseOperation(FlatDatabaseRequest.parse(input).operation),
          table: "table" in input ? input.table : "name" in input ? input.name : undefined,
        },
      });
    } catch (error) {
      return Response.json(
        { code: "BACKGROUND_ACCESS_DENIED", message: error instanceof Error ? error.message : "Database access denied" },
        { status: 403 },
      );
    }
  }
  const router = new Hono<AuthContext>()
    .onError((error) =>
      Response.json(
        {
          code: error instanceof AiBackgroundApprovalRequiredError ? error.code : "CODE_HOST_REQUEST_FAILED",
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
    .post("/api/assistant/artifacts/runtime/capabilities", async (c, next) => {
      if (!config.background) return next();
      if (!config.mandate) throw new Error("Background capability mandate is missing");
      const input = RuntimeCapabilityRequest.parse(await c.req.json());
      if (input.conversationId !== context.conversationId) throw new Error("Code capability conversation mismatch");
      return c.json(
        await runtimeCapabilities.prepare(
          input,
          context,
          {
            transport: session.capabilityTransport,
            origin: "assistant",
            locale: context.locale,
            signal: c.req.raw.signal,
          },
          { turnId: session.turnId, mandate: config.mandate },
        ),
      );
    })
    .post("/api/assistant/artifacts/runtime/http/:callId", async (c, next) => {
      if (!config.background || !config.mandate) return next();
      const decision = z
        .object({ approved: z.boolean() })
        .strict()
        .parse(await c.req.json());
      return c.json(
        await httpService.execute(c.req.param("callId"), decision.approved, context, c.req.raw.signal, undefined, async (stored) => {
          if (stored.scope.conversationId !== context.conversationId) throw new Error("HTTP conversation mismatch");
          await aiChatTasks.authorizeRuntime({
            mandate: config.mandate!,
            kind: "http",
            input: {
              url: stored.request.url,
              origin: new URL(stored.request.url).origin,
              method: stored.request.method,
            },
          });
        }),
      );
    })
    .post("/api/assistant/artifacts/runtime/ai", async (c, next) => {
      if (!config.background) return next();
      const input = z
        .object({
          request: z.unknown(),
          scope: z.object({ conversationId: z.literal(context.conversationId!), resourceId: z.string().optional() }),
        })
        .parse(await c.req.json());
      return c.json({ output: await runCodeAi(input.request, input.scope, context, c.req.raw.signal, session.turnId) });
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
