import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { CompiledCapabilities } from "../_internal/capabilities";
import { AppEventEnvelopeSchema, appEventSubscriptionId } from "../contracts/app-events";
import { deliverAppEvent } from "../events/app-events";
import { REQUEST_IDLE_TIMEOUT_SECONDS, setRequestTimeout } from "../server/request-timeout";
import { verifyAppEventInvocation } from "../services/identity/invocation-token";

const DeliveryInput = z
  .object({ envelope: AppEventEnvelopeSchema, subscriptionId: z.string().max(400), attempt: z.number().int().min(1).max(8) })
  .strict();
export const createAppEventDeliveryRoutes = (compiled: CompiledCapabilities, verify = verifyAppEventInvocation) =>
  new Hono().use(bodyLimit({ maxSize: 8192 })).post("/deliver", async (c) => {
    const payload: unknown = await c.req.json().catch(() => null);
    const parsed = DeliveryInput.safeParse(payload);
    if (!parsed.success) return c.json({ code: "schema_mismatch" }, 422);
    const { envelope, subscriptionId, attempt } = parsed.data;
    const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
    if (!token || !(await verify(token, { appId: compiled.manifest.appId, subscriptionId, eventId: envelope.id, payload })))
      return c.json({ code: "unauthorized" }, 401);
    const sub = compiled.subscribes.get(envelope.type);
    if (
      !sub ||
      sub.manifest.version !== envelope.version ||
      subscriptionId !== appEventSubscriptionId(compiled.manifest.appId, envelope.type, envelope.version)
    )
      return c.json({ code: "subscription_removed" }, 410);
    if (envelope.place) return c.json({ code: "resource_events_unsupported" }, 410);
    if (!sub.definition.schema.safeParse(envelope.data).success) return c.json({ code: "schema_mismatch" }, 422);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30000)]);
    let onAbort: () => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    setRequestTimeout(c, 40);
    try {
      await Promise.race([
        deliverAppEvent({ compiled, subscriptionId, envelope, context: { subscriptionId, eventId: envelope.id, attempt, signal } }),
        aborted,
      ]);
      return c.json({ done: true });
    } catch {
      return c.json({ code: signal.aborted && signal.reason?.name === "TimeoutError" ? "handler_timeout" : "handler_failed" }, 503);
    } finally {
      signal.removeEventListener("abort", onAbort);
      setRequestTimeout(c, REQUEST_IDLE_TIMEOUT_SECONDS);
    }
  });
