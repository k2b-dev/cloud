import { expect, test } from "bun:test";
import type { GatewayHealth } from "./health";

const dbTest = process.env.GATEWAY_OPS_DB_TEST === "1" ? test : test.skip;

const health: GatewayHealth = {
  status: "error",
  checkedAt: new Date().toISOString(),
  sync: { status: "error", signals: ["Sync topic telemetry has 1 dead letters"], checkedAt: new Date().toISOString(), complete: true },
  summary: { apps: 0, healthy: 0, degraded: 0, offline: 0, routes: 0, requests: 0, errors: 0, unmatchedRequests: 0, gatewayInstances: 0 },
  apps: [],
};

dbTest("a rejecting endpoint is recorded on the webhook and surfaces as HealthWebhookDeliveryError", async () => {
  const { createHealthWebhook, deleteHealthWebhook, deliverHealthWebhook, getHealthWebhook, HealthWebhookDeliveryError } = await import(
    "./health-webhooks"
  );
  const received: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      received.push(await request.json());
      return new Response("busy", { status: 503 });
    },
  });
  const webhook = await createHealthWebhook({
    name: `test-${crypto.randomUUID()}`,
    url: `http://127.0.0.1:${server.port}/hook`,
    method: "POST",
    enabled: true,
    scopeKind: "all",
    scopeAppIds: [],
    sendOn: ["error"],
    minStatus: "error",
    repeatIntervalMs: 60_000,
    timeoutMs: 1_000,
  });
  try {
    await expect(deliverHealthWebhook(webhook, health, "test")).rejects.toBeInstanceOf(HealthWebhookDeliveryError);
    const after = await getHealthWebhook(webhook.id);
    expect(after?.failureCount).toBe(1);
    expect(after?.deliveryCount).toBe(1);
    expect(after?.lastError).toBe("Webhook returned HTTP 503");
    expect(after?.lastStatus).toBe("error");
    expect(received).toEqual([{ mode: "test", health }]);
  } finally {
    await deleteHealthWebhook(webhook.id);
    await server.stop(true);
  }
});
