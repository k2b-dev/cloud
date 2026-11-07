import {
  AiFileWriteError,
  AiQuotaError,
  AiTaskRequestSchema,
  AiViewInvalidError,
  createAiConversationView,
  isAiSettingsError,
} from "@k2b/cloud/ai";
import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";
import { type AuthContext, auth, getLocale } from "@k2b/cloud/server";
import { appAccessAuthority, GotenbergRenderError, SettingUnreadableError } from "@k2b/cloud/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { runCodeAi } from "./ai-service";
import { RuntimeCapabilityRequest, runtimeCapabilities } from "./capability-runtime";
import { ChatReference, requireToolChat } from "./chat-access";
import { ClientCall, ClientCallResult, clientCalls } from "./client-calls";
import { LIMITS } from "./contracts";
import { HttpPrepare, HttpScope, SecretSave } from "./http-contracts";
import { HttpError, httpService } from "./http-service";
import { ArtifactError } from "./identity";
import { artifactMessages } from "./messages";
import { decodePdfRequest } from "./pdf-contracts";
import { chatPdf } from "./pdf-service";
import { ChunkName, chunkSource } from "./runtime/chunks";
import { CloudError } from "./runtime/errors";

const capabilityCaller = (c: Context<AuthContext>) => ({
  authorization: c.req.header("authorization"),
  cookie: c.req.header("cookie"),
  locale: getLocale(c),
  signal: c.req.raw.signal,
});
const identity = (c: Context<AuthContext>) => ({
  actor: c.get("actor"),
  accessSubject: c.get("accessSubject"),
  credentialKind: c.get("credentialKind"),
  authority: appAccessAuthority(c),
  locale: getLocale(c),
});
const secretCall = <T extends z.infer<typeof ClientCall>>(call: T) => {
  if (call.input.operation !== "secret" || call.input.resourceId) throw new ArtifactError("ACCESS_DENIED");
  return call;
};
/** Chat-only services: no resource resolver, app storage, HTML host or database admission. */
export const createChatCodeServiceRoutes = (
  caller: (c: Context<AuthContext>) => CapabilityCaller = capabilityCaller,
  backgroundTurnId?: string,
) =>
  new Hono<AuthContext>()
    .use(
      "*",
      auth.readOnlyMiddleware((c, next) =>
        c.req.path.endsWith("/runtime/pdf") || /\/runtime\/capabilities\/[^/]+\/stream\/(read|write|status|abort)$/.test(c.req.path)
          ? next()
          : bodyLimit({ maxSize: LIMITS.rpcBytes })(c, next),
      ),
    )
    .use(
      "*",
      auth.readOnlyMiddleware(async (c, next) => {
        c.header("Cache-Control", "private, no-store");
        await next();
      }),
    )
    .onError((error, c) => {
      const reply = (code: string, status: number, message = error.message) => Response.json({ code, message }, { status });
      const t = artifactMessages.resolve([getLocale(c)]).t;
      if (error instanceof AiViewInvalidError) return reply("INVALID_INPUT", 400);
      if (error instanceof AiFileWriteError) return reply(error.code, error.code === "CONFLICT" ? 409 : 400);
      if (error instanceof AiQuotaError) return reply(error.code, 429);
      if (error instanceof SettingUnreadableError) return reply(error.code, 409);
      if (isAiSettingsError(error)) return reply(error.aiError.code, 403, error.aiError.message);
      if (error instanceof GotenbergRenderError) {
        const code =
          error.code === "not_configured"
            ? "PDF_NOT_CONFIGURED"
            : error.code === "timeout"
              ? "PDF_TIMEOUT"
              : error.code === "html_too_large" || error.code === "pdf_too_large"
                ? "PDF_LIMIT"
                : error.code === "bad_input"
                  ? "INVALID_INPUT"
                  : "PDF_FAILED";
        return reply(code, code === "PDF_LIMIT" ? 413 : code === "INVALID_INPUT" ? 400 : 503, t[code]);
      }
      if (error instanceof HttpError) return reply(error.code, error.code === "HTTP_DENIED" ? 403 : 409, t[error.code]);
      if (error instanceof CloudError) return reply(error.code, error.code === "denied" ? 403 : error.code === "not_found" ? 404 : 400);
      if (error instanceof z.ZodError) return reply("INVALID_INPUT", 400, t.INVALID_INPUT);
      if (error instanceof ArtifactError)
        return reply(
          error.code,
          error.code === "NOT_FOUND"
            ? 404
            : error.code === "CONFLICT"
              ? 409
              : error.code === "ACCESS_DENIED"
                ? 403
                : error.code === "TOO_MANY_REQUESTS"
                  ? 429
                  : 400,
          t[error.code],
        );
      console.error("Assistant chat code request failed", error);
      return reply("REQUEST_FAILED", 500, t.REQUEST_FAILED);
    })
    .post("/runtime/views", async (c) => {
      const input = z
        .strictObject({
          conversationId: ChatReference,
          turnId: z.string().min(1).max(80),
          runId: z.string().min(1).max(180),
          index: z.number().int().min(0).max(63),
          view: z.json(),
        })
        .parse(await c.req.json());
      const viewer = identity(c);
      if (viewer.actor.kind !== "user") throw new ArtifactError("ACCESS_DENIED");
      const chat = await requireToolChat(input.conversationId, viewer, "code_run");
      return c.json(await createAiConversationView({ ...input, conversationId: chat.id, ownerUserId: viewer.actor.user.id }));
    })
    .post("/runtime/ai", async (c) => {
      const input = z.strictObject({ scope: HttpScope, request: AiTaskRequestSchema }).parse(await c.req.json());
      return c.json({ output: await runCodeAi(input.request, input.scope, identity(c), c.req.raw.signal, backgroundTurnId) });
    })
    .post(
      "/runtime/pdf",
      auth.readOnly,
      async (c, next) => {
        await chatPdf.authorize({ conversationId: c.req.query("conversationId"), resourceId: c.req.query("resourceId") }, identity(c));
        await next();
      },
      bodyLimit({ maxSize: LIMITS.rpcBytes * 6 + 4096 }),
      async (c) => {
        const result = await chatPdf.execute(decodePdfRequest(await c.req.raw.formData()), c.req.raw.signal);
        return new Response(new Uint8Array(result.pdf), {
          headers: { "Content-Type": "application/pdf", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
        });
      },
    )
    .post("/runtime/secrets/list", auth.readOnly, async (c) =>
      c.json(await httpService.list(HttpScope.parse(await c.req.json()), identity(c))),
    )
    .put("/runtime/secrets", async (c) => {
      const input = z.strictObject({ scope: HttpScope, secret: SecretSave }).parse(await c.req.json());
      return c.json(await httpService.save(input.scope, input.secret, identity(c)));
    })
    .post("/runtime/secrets/remove", async (c) => {
      const input = z.strictObject({ scope: HttpScope, name: z.string(), revision: z.uuid() }).parse(await c.req.json());
      return c.json(await httpService.remove(input.scope, input.name, input.revision, identity(c)));
    })
    .post("/runtime/http", async (c) => c.json(await httpService.prepare(HttpPrepare.parse(await c.req.json()), identity(c))))
    .post("/runtime/http/:id", async (c) => {
      const { approved } = z.strictObject({ approved: z.boolean() }).parse(await c.req.json());
      return c.json(await httpService.execute(z.uuid().parse(c.req.param("id")), approved, identity(c), c.req.raw.signal));
    })
    .post("/runtime/capabilities", async (c) =>
      c.json(await runtimeCapabilities.prepare(RuntimeCapabilityRequest.parse(await c.req.json()), identity(c), caller(c))),
    )
    .post("/runtime/capabilities/:id/resolve", async (c) =>
      c.json(
        await runtimeCapabilities.resolve(
          z.uuid().parse(c.req.param("id")),
          z.strictObject({ approved: z.boolean(), remember: z.literal("always").optional() }).parse(await c.req.json()),
          identity(c),
          caller(c),
        ),
      ),
    )
    .post("/runtime/capabilities/:id/stream/:verb", async (c) =>
      runtimeCapabilities.stream(
        c.req.param("id"),
        z.enum(["read", "write", "status", "abort"]).parse(c.req.param("verb")),
        c.req.raw.body,
        identity(c),
        caller(c),
      ),
    )
    .get("/runtime/chunks/:name", async (c) =>
      c.body(await chunkSource(ChunkName.parse(c.req.param("name"))), 200, { "Content-Type": "text/javascript" }),
    )
    .post("/runtime/claim", async (c) => c.json(await clientCalls.claim(secretCall(ClientCall.parse(await c.req.json())), identity(c))))
    .post("/runtime/complete", async (c) =>
      c.json(await clientCalls.complete(secretCall(ClientCallResult.parse(await c.req.json())), identity(c))),
    );
export const chatCodeApi = createChatCodeServiceRoutes();
