import { afterEach, beforeEach, expect } from "bun:test";
import { testFor } from "../../../scripts/fixtures/test-infra";
import type { GatewayHealth } from "./health";

let originalTargets: string | undefined;
beforeEach(() => {
  originalTargets = process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS;
  process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS = "127.0.0.1";
});
afterEach(() => {
  if (originalTargets === undefined) delete process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS;
  else process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS = originalTargets;
});
const dbTest = testFor("database");

const health: GatewayHealth = {
  status: "error",
  checkedAt: "2026-10-16T12:00:00.000Z",
  sync: { status: "error", signals: ["Sync topic telemetry has 1 dead letters"], checkedAt: "2026-10-16T12:00:00.000Z", complete: true },
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

dbTest("internal health webhook refusal is recorded and an operator allowlist enables delivery", async () => {
  const { createHealthWebhook, deleteHealthWebhook, deliverHealthWebhook, getHealthWebhook } = await import("./health-webhooks");
  let received = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      received++;
      return new Response(null, { status: 204 });
    },
  });
  let webhook: Awaited<ReturnType<typeof createHealthWebhook>> | undefined;
  try {
    webhook = await createHealthWebhook({
      name: "Internal webhook guard",
      url: `http://127.0.0.1:${server.port}/hook`,
      method: "GET",
      enabled: true,
      scopeKind: "all",
      scopeAppIds: [],
      sendOn: ["error"],
      minStatus: "error",
      repeatIntervalMs: 60_000,
      timeoutMs: 1000,
    });
    delete process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS;
    await expect(deliverHealthWebhook(webhook, health, "test")).rejects.toMatchObject({
      name: "HealthWebhookDeliveryError",
      message: expect.stringContaining("GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS"),
    });
    expect(received).toBe(0);
    expect(await getHealthWebhook(webhook.id)).toMatchObject({
      failureCount: 1,
      deliveryCount: 1,
      lastError: expect.stringContaining("GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS"),
    });
    process.env.GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS = "127.0.0.1";
    await deliverHealthWebhook(webhook, health, "test");
    expect(received).toBe(1);
    expect(await getHealthWebhook(webhook.id)).toMatchObject({ failureCount: 0, deliveryCount: 2, lastError: null });
  } finally {
    if (webhook) await deleteHealthWebhook(webhook.id);
    await server.stop(true);
  }
});
