import { type AuthContext, auth, err, fail, getLocale, ok, respond, v } from "@k2b/cloud/server";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import { sanitizeHeaders, WebhookSendError, webhookTesterService } from "../service/webhooks";
import { sendErrorMessage, webhookApiMessages } from "./webhooks-messages";

const messages = (c: Context<AuthContext>) => webhookApiMessages.resolve([getLocale(c)]).t;

const HeaderRecordSchema = z.record(z.string(), z.string().max(4_000)).default({});

const CreateEndpointSchema = z.object({
  name: z.string().trim().min(1).max(120),
});

const SendWebhookSchema = z.object({
  url: z.string().trim().url().max(2_000),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  headers: HeaderRecordSchema,
  body: z.string().max(64_000).default(""),
});

const LogFilterSchema = z.object({
  endpointId: z.string().uuid().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  q: z.string().trim().max(200).optional(),
});

const MAX_INCOMING_BODY_BYTES = 64_000;
type ApiResponse = Awaited<ReturnType<typeof respond>>;

const readBody = async (c: Context<AuthContext>): Promise<{ ok: true; body: string | null } | { ok: false; response: ApiResponse }> => {
  const body = c.req.raw.body;
  if (!body) return { ok: true, body: null };

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_INCOMING_BODY_BYTES) {
        await reader.cancel();
        return { ok: false, response: await respond(c, fail(err.badInput(messages(c).bodyTooLarge))) };
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  const text = chunks.join("");
  return { ok: true, body: text || null };
};

const getUserBackedActor = (c: Context<AuthContext>) => {
  const actor = c.get("actor");
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

type UserBackedActorResult = { ok: true; user: AuthContext["Variables"]["user"] } | { ok: false; response: Promise<ApiResponse> };

const requireUserBackedActor = (c: Context<AuthContext>): UserBackedActorResult => {
  const user = getUserBackedActor(c);
  if (!user) return { ok: false, response: respond(c, fail(err.forbidden(messages(c).userBackedActorRequired))) };
  return { ok: true, user };
};

const receiveWebhook = async (c: Context<AuthContext>, token: string): Promise<ApiResponse> => {
  const body = await readBody(c);
  if (!body.ok) return body.response;

  const url = new URL(c.req.url);
  const log = await webhookTesterService.logIncoming({
    token,
    method: c.req.method,
    url: c.req.url,
    path: url.pathname,
    query: url.search,
    headers: sanitizeHeaders(c.req.raw.headers),
    body: body.body,
    contentType: c.req.header("content-type") ?? null,
  });
  if (!log) return respond(c, fail({ ...err.notFound("Webhook endpoint"), message: messages(c).endpointNotFound }));
  return respond(c, ok({ ok: true, logId: log.id }));
};

const app = new Hono<AuthContext>()
  .all("/receive/:token", async (c) => {
    return receiveWebhook(c, c.req.param("token")!);
  })
  .all("/receive/:token/*", async (c) => {
    return receiveWebhook(c, c.req.param("token")!);
  })

  .use(auth.requireRole("authenticated"))

  .get("/endpoints", async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    return respond(c, ok({ items: await webhookTesterService.listEndpoints(user.id) }));
  })
  .post("/endpoints", v("json", CreateEndpointSchema), async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    const endpoint = await webhookTesterService.createEndpoint(user.id, c.req.valid("json").name, messages(c).defaultEndpointName);
    return respond(c, ok(endpoint), 201);
  })
  .delete("/endpoints/:endpointId", async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    const deleted = await webhookTesterService.deleteEndpoint(user.id, c.req.param("endpointId")!);
    if (!deleted) return respond(c, fail({ ...err.notFound("Endpoint"), message: messages(c).endpointNotFoundShort }));
    return c.body(null, 204);
  })
  .get("/endpoints/:endpointId/logs", async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    const filters = LogFilterSchema.omit({ endpointId: true }).parse(c.req.query());
    return respond(
      c,
      ok({
        items: await webhookTesterService.listEndpointLogs(user.id, c.req.param("endpointId")!, {
          method: filters.method,
          query: filters.q,
        }),
      }),
    );
  })
  .get("/incoming-logs", v("query", LogFilterSchema), async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    const filters = c.req.valid("query");
    return respond(
      c,
      ok({
        items: await webhookTesterService.listIncomingLogs(user.id, {
          endpointId: filters.endpointId,
          method: filters.method,
          query: filters.q,
        }),
      }),
    );
  })
  .get("/outgoing-logs", v("query", LogFilterSchema.omit({ endpointId: true })), async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    const filters = c.req.valid("query");
    return respond(
      c,
      ok({
        items: await webhookTesterService.listOutgoingLogs(user.id, {
          method: filters.method,
          query: filters.q,
        }),
      }),
    );
  })
  .post("/send", v("json", SendWebhookSchema), async (c) => {
    const userResult = requireUserBackedActor(c);
    if (!userResult.ok) return userResult.response;
    const user = userResult.user;
    try {
      const log = await webhookTesterService.send(user.id, c.req.valid("json"));
      return respond(c, ok(log));
    } catch (error) {
      if (error instanceof WebhookSendError) {
        return respond(c, fail(err.badInput(sendErrorMessage(messages(c), error.code))));
      }
      return respond(c, fail(err.badInput(error instanceof Error ? error.message : messages(c).requestFailed)));
    }
  });

export default app;
