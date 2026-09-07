import type { Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { logger, trace } from "@valentinkolb/cloud/services";
import { sql } from "bun";
import { buildGatewayHealth, type GatewayHealth, type GatewayHealthStatus, scopeGatewayHealth } from "./health";

const log = logger("gateway:webhooks");
const MAX_REPEAT_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HealthWebhook = {
  id: string;
  name: string;
  url: string;
  method: "GET" | "POST";
  enabled: boolean;
  scopeKind: "all" | "include" | "exclude";
  scopeAppIds: string[];
  sendOn: ("ok" | "warn" | "error" | "recovery" | "every_check")[];
  minStatus: GatewayHealthStatus;
  repeatIntervalMs: number;
  timeoutMs: number;
  lastStatus: GatewayHealthStatus | null;
  lastSentAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  deliveryCount: number;
  failureCount: number;
};

type DbWebhook = {
  id: string;
  name: string;
  url: string;
  method: string;
  enabled: boolean;
  scope_kind: string;
  scope_app_ids: unknown;
  send_on: unknown;
  min_status: string;
  repeat_interval_ms: number;
  timeout_ms: number;
  last_status: string | null;
  last_sent_at: Date | string | null;
  last_success_at: Date | string | null;
  last_error_at: Date | string | null;
  last_error: string | null;
  delivery_count: number;
  failure_count: number;
};

export type HealthWebhookInput = Omit<
  HealthWebhook,
  "id" | "lastStatus" | "lastSentAt" | "lastSuccessAt" | "lastErrorAt" | "lastError" | "deliveryCount" | "failureCount"
>;

const asIso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export const isHealthWebhookId = (id: string): boolean => UUID_RE.test(id);

export class HealthWebhookInputError extends Error {
  constructor(readonly code: "url_protocol" | "name_required") {
    super(code);
    this.name = "HealthWebhookInputError";
  }
}

const mapWebhook = (row: DbWebhook): HealthWebhook => ({
  id: row.id,
  name: row.name,
  url: row.url,
  method: row.method === "POST" ? "POST" : "GET",
  enabled: row.enabled,
  scopeKind: row.scope_kind === "include" || row.scope_kind === "exclude" ? row.scope_kind : "all",
  scopeAppIds: asStringArray(row.scope_app_ids),
  sendOn: asStringArray(row.send_on).filter((item): item is HealthWebhook["sendOn"][number] =>
    ["ok", "warn", "error", "recovery", "every_check"].includes(item),
  ),
  minStatus: row.min_status === "warn" || row.min_status === "error" ? row.min_status : "ok",
  repeatIntervalMs: row.repeat_interval_ms,
  timeoutMs: row.timeout_ms,
  lastStatus: row.last_status === "ok" || row.last_status === "warn" || row.last_status === "error" ? row.last_status : null,
  lastSentAt: asIso(row.last_sent_at),
  lastSuccessAt: asIso(row.last_success_at),
  lastErrorAt: asIso(row.last_error_at),
  lastError: row.last_error,
  deliveryCount: row.delivery_count,
  failureCount: row.failure_count,
});

export const normalizeHealthWebhookInput = (input: HealthWebhookInput): HealthWebhookInput => {
  const url = new URL(input.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HealthWebhookInputError("url_protocol");
  const name = input.name.trim();
  if (!name) throw new HealthWebhookInputError("name_required");
  const repeatIntervalMs = Number.isFinite(input.repeatIntervalMs)
    ? Math.max(60_000, Math.min(MAX_REPEAT_INTERVAL_MS, Math.trunc(input.repeatIntervalMs)))
    : 1_800_000;
  const timeoutMs = Number.isFinite(input.timeoutMs) ? Math.max(1000, Math.min(30_000, Math.trunc(input.timeoutMs))) : 5000;
  return {
    ...input,
    name,
    url: url.toString(),
    method: input.method === "POST" ? "POST" : "GET",
    scopeKind: input.scopeKind === "include" || input.scopeKind === "exclude" ? input.scopeKind : "all",
    scopeAppIds: Array.from(new Set(input.scopeAppIds.map((id) => id.trim()).filter(Boolean))),
    sendOn: input.sendOn.length > 0 ? input.sendOn : ["error", "recovery"],
    minStatus: input.minStatus,
    repeatIntervalMs,
    timeoutMs,
  };
};

export const listHealthWebhooks = async (): Promise<HealthWebhook[]> => {
  const rows = await sql<DbWebhook[]>`
    SELECT *
    FROM gateway.health_webhooks
    ORDER BY name ASC, created_at ASC
  `;
  return rows.map(mapWebhook);
};

export const getHealthWebhook = async (id: string): Promise<HealthWebhook | null> => {
  if (!isHealthWebhookId(id)) return null;
  const [row] = await sql<DbWebhook[]>`SELECT * FROM gateway.health_webhooks WHERE id = ${id}::uuid`;
  return row ? mapWebhook(row) : null;
};

export const createHealthWebhook = async (raw: HealthWebhookInput): Promise<HealthWebhook> => {
  const input = normalizeHealthWebhookInput(raw);
  const [row] = await sql<DbWebhook[]>`
    INSERT INTO gateway.health_webhooks (
      name, url, method, enabled, scope_kind, scope_app_ids, send_on,
      min_status, repeat_interval_ms, timeout_ms
    )
    VALUES (
      ${input.name}, ${input.url}, ${input.method}, ${input.enabled},
      ${input.scopeKind}, ${JSON.stringify(input.scopeAppIds)}::jsonb,
      ${JSON.stringify(input.sendOn)}::jsonb, ${input.minStatus},
      ${input.repeatIntervalMs}, ${input.timeoutMs}
    )
    RETURNING *
  `;
  return mapWebhook(row!);
};

export const updateHealthWebhook = async (id: string, raw: HealthWebhookInput): Promise<HealthWebhook | null> => {
  if (!isHealthWebhookId(id)) return null;
  const input = normalizeHealthWebhookInput(raw);
  const [row] = await sql<DbWebhook[]>`
    UPDATE gateway.health_webhooks
    SET
      name = ${input.name},
      url = ${input.url},
      method = ${input.method},
      enabled = ${input.enabled},
      scope_kind = ${input.scopeKind},
      scope_app_ids = ${JSON.stringify(input.scopeAppIds)}::jsonb,
      send_on = ${JSON.stringify(input.sendOn)}::jsonb,
      min_status = ${input.minStatus},
      repeat_interval_ms = ${input.repeatIntervalMs},
      timeout_ms = ${input.timeoutMs},
      updated_at = now()
    WHERE id = ${id}::uuid
    RETURNING *
  `;
  return row ? mapWebhook(row) : null;
};

export const deleteHealthWebhook = async (id: string): Promise<boolean> => {
  if (!isHealthWebhookId(id)) return false;
  const result = await sql`DELETE FROM gateway.health_webhooks WHERE id = ${id}::uuid`;
  return result.count > 0;
};

const scopedHealth = async (webhook: HealthWebhook, baseHealth?: GatewayHealth): Promise<GatewayHealth> => {
  if (webhook.scopeKind === "all" && !baseHealth) return buildGatewayHealth();
  const all = baseHealth ?? (await buildGatewayHealth());
  if (webhook.scopeKind === "all") return all;
  const ids = new Set(webhook.scopeAppIds);
  const scopeIds = webhook.scopeKind === "include" ? webhook.scopeAppIds : all.apps.filter((app) => !ids.has(app.id)).map((app) => app.id);
  return scopeGatewayHealth(all, scopeIds);
};

const statusRank = { ok: 0, warn: 1, error: 2 } satisfies Record<GatewayHealthStatus, number>;

const shouldSend = (webhook: HealthWebhook, status: GatewayHealthStatus, now: number): boolean => {
  if (!webhook.enabled) return false;
  if (webhook.sendOn.includes("every_check")) return true;
  const previous = webhook.lastStatus;
  const changed = previous !== status;
  const recovered = previous && previous !== "ok" && status === "ok";
  const repeated = webhook.lastSentAt ? now - new Date(webhook.lastSentAt).getTime() >= webhook.repeatIntervalMs : true;
  if (recovered && webhook.sendOn.includes("recovery")) return true;
  if (statusRank[status] < statusRank[webhook.minStatus]) return false;
  if (changed && webhook.sendOn.includes(status)) return true;
  return status !== "ok" && webhook.sendOn.includes(status) && repeated;
};

const markResult = async (webhook: HealthWebhook, health: GatewayHealth, ok: boolean, error?: string) => {
  await sql`
    UPDATE gateway.health_webhooks
    SET
      last_status = ${health.status},
      last_sent_at = now(),
      last_success_at = CASE WHEN ${ok} THEN now() ELSE last_success_at END,
      last_error_at = CASE WHEN ${ok} THEN last_error_at ELSE now() END,
      last_error = ${ok ? null : (error ?? "Webhook delivery failed")},
      delivery_count = delivery_count + 1,
      failure_count = CASE WHEN ${ok} THEN 0 ELSE failure_count + 1 END,
      updated_at = now()
    WHERE id = ${webhook.id}::uuid
  `;
};

const sendWebhook = async (webhook: HealthWebhook, health: GatewayHealth, mode: "scheduled" | "test") => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), webhook.timeoutMs);
  try {
    const init: RequestInit =
      webhook.method === "POST"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode, health }),
            signal: controller.signal,
          }
        : { method: "GET", signal: controller.signal };
    const response = await fetch(webhook.url, init);
    if (!response.ok) throw new Error(`Webhook returned HTTP ${response.status}`);
    await markResult(webhook, health, true);
    log.info("Health webhook delivered", { webhookId: webhook.id, name: webhook.name, mode, status: health.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markResult(webhook, health, false, message);
    log.error("Health webhook failed", { webhookId: webhook.id, name: webhook.name, mode, status: health.status, error: message });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

export const healthWebhookDeliveryJob = lazySync((sync) => {
  const job = sync.job<{ webhookId: string; mode?: "scheduled" | "test" }>({
    id: "gateway:health-webhook-delivery",
    delivery: { ackWaitMs: 60_000, maxAttempts: 3, backoffMs: [1_000, 2_000] },
  });

  return job;
});

let deliveryWorker: Worker | undefined;
export const startHealthWebhookDelivery = async (): Promise<void> => {
  deliveryWorker ??= await healthWebhookDeliveryJob().process({}, async (context) => {
    await trace.withSpan(
      {
        name: "Gateway health webhook delivery",
        source: "gateway:health-webhook-delivery",
        appId: "gateway-ops",
        category: "job",
        attributes: {
          "cloud.gateway.webhook_id": context.input.webhookId,
          "cloud.gateway.webhook_mode": context.input.mode ?? "scheduled",
        },
      },
      async () => {
        const webhook = await getHealthWebhook(context.input.webhookId);
        if (!webhook) return;
        await sendWebhook(webhook, await scopedHealth(webhook), context.input.mode ?? "scheduled");
      },
    );
  });
};
export const stopHealthWebhookDelivery = async (): Promise<void> => {
  await deliveryWorker?.drain();
  deliveryWorker = undefined;
};

export const runHealthWebhookCheck = async (): Promise<{ checked: number; submitted: number }> => {
  const webhooks = await listHealthWebhooks();
  const baseHealth = await buildGatewayHealth();
  const now = Date.now();
  let submitted = 0;
  for (const webhook of webhooks) {
    const health = await scopedHealth(webhook, baseHealth);
    await sql`UPDATE gateway.health_webhooks SET last_status = ${health.status}, updated_at = now() WHERE id = ${webhook.id}::uuid`;
    if (!shouldSend(webhook, health.status, now)) continue;
    await healthWebhookDeliveryJob().submit({
      key: `${webhook.id}:${health.status}:${Math.floor(now / 60_000)}`,
      input: { webhookId: webhook.id },
    });
    submitted += 1;
  }
  log.info("Health webhook check completed", { checked: webhooks.length, submitted });
  return { checked: webhooks.length, submitted };
};

export const testHealthWebhook = async (id: string): Promise<string> =>
  (await healthWebhookDeliveryJob().submit({ key: `test:${id}:${Date.now()}`, input: { webhookId: id, mode: "test" } })).jobId;
