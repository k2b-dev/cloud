import type { Context } from "hono";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { NotifySchema, type PushService, PushTokenSchema, type RateLimited, SubscriptionSchema, TestSchema } from "./push";

/** Same rule as Cloud's IP rate limit: the trusted ingress sanitizes forwarding headers. */
const caller = (c: Context, fallback?: string) =>
  c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || fallback || "unknown";

const limited = (c: Context, value: RateLimited) => {
  c.header("Retry-After", String(value.retryAfter));
  return c.json({ code: "RATE_LIMITED" }, 429);
};

const parse = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T> | null> => {
  const result = schema.safeParse(await c.req.json().catch(() => undefined));
  return result.success ? result.data : null;
};

/** Push routes of the authenticator. `push` is absent when the operator has not configured VAPID. */
export const createPushRoutes = (push: PushService | undefined, peer: (request: Request) => string | undefined = () => undefined) => {
  const app = new Hono().basePath("/push");
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  if (!push) {
    app.all("*", (c) => c.json({ code: "UNAVAILABLE" }, 404));
    return app;
  }
  app.onError((error, c) => {
    // Never log request bodies: they contain push tokens and endpoints.
    console.error("[push] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ code: "UNAVAILABLE" }, 503);
  });
  const tooLarge = (c: Context) => c.json({ code: "TOO_LARGE" }, 413);
  const answer = (c: Context, result: Awaited<ReturnType<PushService["notify"]>>) =>
    result === "queued" ? c.json({ state: "queued" }, 202) : result === "gone" ? c.json({ code: "GONE" }, 410) : limited(c, result);

  app.get("/config", (c) => c.json({ publicKey: push.publicKey }));
  app.post("/subscriptions", bodyLimit({ maxSize: push.limits.subscriptionBodyBytes, onError: tooLarge }), async (c) => {
    const rate = await push.hit(`subscribe:${caller(c, peer(c.req.raw))}`, push.limits.subscriptionsPerCaller);
    if (rate) return limited(c, rate);
    const input = await parse(c, SubscriptionSchema);
    if (!input) return c.json({ code: "INVALID_REQUEST" }, 400);
    return c.json({ token: await push.subscribe(input) }, 201);
  });
  app.delete("/subscriptions/:token", async (c) => {
    const token = PushTokenSchema.safeParse(c.req.param("token"));
    if (token.success) await push.unsubscribe(token.data);
    return c.body(null, 204);
  });
  app.post("/notify", bodyLimit({ maxSize: push.limits.notifyBodyBytes, onError: tooLarge }), async (c) => {
    const rate = await push.hit(`caller:${caller(c, peer(c.req.raw))}`, push.limits.requestsPerCaller);
    if (rate) return limited(c, rate);
    const input = await parse(c, NotifySchema);
    if (!input) return c.json({ code: "INVALID_REQUEST" }, 400);
    return answer(c, await push.notify(input));
  });
  app.post("/test", bodyLimit({ maxSize: push.limits.notifyBodyBytes, onError: tooLarge }), async (c) => {
    const rate = await push.hit(`caller:${caller(c, peer(c.req.raw))}`, push.limits.requestsPerCaller);
    if (rate) return limited(c, rate);
    const input = await parse(c, TestSchema);
    if (!input) return c.json({ code: "INVALID_REQUEST" }, 400);
    return answer(c, await push.test(input.token));
  });
  return app;
};
