/**
 * Local Compose HTTP acceptance smoke. Run inside the rebuilt app-core:
 * docker compose -f compose.dev.yml exec -T app-core bun packages/core/scripts/sync-dev-smoke.ts
 * Uses a disposable local account and canonical session issuance; no credentials are printed.
 */
import { session } from "@k2b/cloud/services";
import { sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";

const gateway = "http://gateway:3000";
const apiPaths = ["/api/admin/sync", "/api/admin/sync/core/resources", "/api/admin/sync/core/dead-letters", "/api/gateway/sync"];
const adminPaths = ["/admin/gateway/apps", "/admin/observability/sync", "/admin/observability/jobs"];
const database = new URL(process.env.DATABASE_URL ?? "postgresql://invalid/invalid");
if (
  process.env.NODE_ENV !== "development" ||
  process.env.APP_ID !== "core" ||
  database.hostname !== "ipa_postgres" ||
  database.pathname !== "/ipa"
) {
  throw new Error("Run this smoke only inside app-core from the local development Compose stack");
}

const appSchema = z.object({ id: z.string().min(1) });
const resourcesSchema = z.object({
  health: z.object({ state: z.literal("ready"), connection: z.literal("connected") }),
  resources: z.array(z.object({ namespace: z.string().min(1), kind: z.string().min(1), id: z.string().min(1), state: z.literal("ready") })),
});
const scheduleSchema = z.object({
  id: z.string().min(1),
  schedulerId: z.string().min(1),
  handlerAvailable: z.boolean(),
  runNumber: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  lastRunId: z.string().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
});
const schedulesSchema = z.object({ schedules: z.array(scheduleSchema) });
const deadLetterSchema = z.object({
  messageId: z.string().min(1),
  tenantId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  failedAt: z.string().datetime(),
  reason: z.string(),
  error: z.string().nullable(),
  dataPreview: z.string(),
});
const deadLettersSchema = z.object({
  stores: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.enum(["queue", "job"]),
      truncated: z.boolean(),
      entries: z.array(deadLetterSchema),
    }),
  ),
});
const overviewSchema = z.object({
  apps: z.array(z.object({ appId: z.string(), status: z.literal("ok") })),
  resources: z.array(z.unknown()),
  schedules: z.array(scheduleSchema.extend({ appId: z.string().min(1) })),
  deadLetters: z.array(deadLetterSchema.extend({ appId: z.string().min(1), store: z.string().min(1), kind: z.enum(["queue", "job"]) })),
});

let checks = 0;
const request = (path: string, token?: string) =>
  fetch(new URL(path, gateway), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(40_000),
  });
const requireStatus = async (path: string, expected: number, token?: string): Promise<Response> => {
  const response = await request(path, token);
  if (response.status !== expected) throw new Error(`${path}: expected HTTP ${expected}, received ${response.status}`);
  checks++;
  return response;
};
const userId = crypto.randomUUID();
let token: string | undefined;
let created = false;
try {
  for (const path of apiPaths) await requireStatus(path, 401);
  for (const path of adminPaths) {
    const response = await request(path);
    if (![302, 303, 401, 403].includes(response.status)) throw new Error(`${path}: anonymous HTTP ${response.status}`);
    checks++;
  }
  console.log(`Anonymous access: ${checks} routes denied`);

  // Local account authority comes from admin, not IPA-only admin-group matching.
  // Account expiry bounds the fixture even if this process is interrupted.
  await sql`
    INSERT INTO auth.users (id, uid, provider, profile, display_name, admin, account_expires)
    VALUES (${userId}::uuid, ${`sync-dev-smoke-${userId}`}, 'local', 'user', 'Disposable Sync smoke', FALSE, now() + interval '5 minutes')
  `;
  created = true;
  const login = new Hono().post("/fixture", async (c) => {
    token = await session.create(c, userId);
    return c.body(null, 204);
  });
  const issued = await login.request("/fixture", { method: "POST" });
  if (issued.status !== 204 || !token) throw new Error("Canonical session fixture issuance failed");
  await sql`UPDATE auth.session_families SET expires_at = LEAST(expires_at, now() + interval '5 minutes') WHERE user_id = ${userId}::uuid`;

  for (const path of apiPaths) await requireStatus(path, 403, token);
  console.log(`Non-admin access: ${apiPaths.length} routes denied`);
  await sql`UPDATE auth.users SET admin = TRUE WHERE id = ${userId}::uuid`;

  const fleet = z.object({ apps: z.array(appSchema) }).parse(await (await requireStatus("/api/admin/sync", 200, token)).json());
  for (const id of ["core", "oauth", "gateway-ops"]) {
    if (!fleet.apps.some((app) => app.id === id)) throw new Error(`Administrative fleet is missing ${id}`);
  }
  let resources = 0;
  let schedules = 0;
  let stores = 0;
  const discoveredStores = new Set<string>();
  // Small request batches avoid competing with the fleet's own background work.
  for (let offset = 0; offset < fleet.apps.length; offset += 4) {
    await Promise.all(
      fleet.apps.slice(offset, offset + 4).map(async (app) => {
        const prefix = `/api/admin/sync/${encodeURIComponent(app.id)}`;
        const resourceResponse = await requireStatus(`${prefix}/resources`, 200, token);
        const resourceResult = resourcesSchema.safeParse(await resourceResponse.json());
        if (!resourceResult.success) throw new Error(`${app.id}: Sync resources are not ready`);
        resources += resourceResult.data.resources.length;
        const deadLetterResponse = await requireStatus(`${prefix}/dead-letters`, 200, token);
        const deadLetterResult = deadLettersSchema.safeParse(await deadLetterResponse.json());
        if (!deadLetterResult.success) throw new Error(`${app.id}: invalid dead-letter controls response`);
        const storeKeys = new Set(deadLetterResult.data.stores.map((store) => `${store.kind}/${store.name}`));
        if (storeKeys.size !== deadLetterResult.data.stores.length) throw new Error(`${app.id}: duplicate dead-letter control identity`);
        for (const resource of resourceResult.data.resources) {
          if ((resource.kind === "queue" || resource.kind === "job") && !storeKeys.has(`${resource.kind}/${resource.id}`)) {
            throw new Error(`${app.id}: missing ${resource.kind} dead-letter control for ${resource.id}`);
          }
        }
        for (const key of storeKeys) discoveredStores.add(`${app.id}/${key}`);
        stores += storeKeys.size;
        const scheduleResponse = await requireStatus(`${prefix}/schedules`, 200, token);
        const scheduleResult = schedulesSchema.safeParse(await scheduleResponse.json());
        if (!scheduleResult.success) throw new Error(`${app.id}: invalid schedules response`);
        const scheduleKeys = new Set(scheduleResult.data.schedules.map((schedule) => `${schedule.schedulerId}/${schedule.id}`));
        if (scheduleKeys.size !== scheduleResult.data.schedules.length) throw new Error(`${app.id}: duplicate schedule identity`);
        schedules += scheduleResult.data.schedules.length;
      }),
    );
  }
  console.log(
    `Core fleet proxy: ${fleet.apps.length} apps, ${resources} ready resources, ${stores} dead-letter controls, ${schedules} schedules`,
  );
  const overviewResult = overviewSchema.safeParse(await (await requireStatus("/api/gateway/sync", 200, token)).json());
  if (!overviewResult.success) throw new Error("Gateway Ops overview contains unavailable apps or an invalid response");
  const overview = overviewResult.data;
  if (overview.apps.length !== fleet.apps.length) throw new Error("Gateway Ops overview omitted registered apps");
  for (const entry of overview.deadLetters) {
    if (!discoveredStores.has(`${entry.appId}/${entry.kind}/${entry.store}`)) {
      throw new Error("Gateway Ops dead letter does not identify a discovered app/kind/store");
    }
  }
  console.log(
    `Gateway Ops: ${overview.apps.length} healthy apps, ${overview.resources.length} resources, ${overview.schedules.length} schedules`,
  );

  for (const path of adminPaths) {
    const response = await requireStatus(path, 200, token);
    if (!response.headers.get("content-type")?.includes("text/html")) throw new Error(`${path}: expected rendered HTML`);
    await response.arrayBuffer();
  }
  console.log(`Admin SSR: ${adminPaths.length} pages returned HTTP 200`);
} finally {
  try {
    if (token) await session.revoke(token);
  } finally {
    token = undefined;
    try {
      if (created) {
        await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
        const [remaining] = await sql<Array<{ count: number }>>`
          SELECT (SELECT COUNT(*) FROM auth.users WHERE id = ${userId}::uuid)::int
            + (SELECT COUNT(*) FROM auth.session_families WHERE user_id = ${userId}::uuid)::int AS count
        `;
        if (remaining?.count !== 0) throw new Error("Disposable smoke account/session cleanup was incomplete");
        console.log("Fixture cleanup: no account or session remains");
      }
    } finally {
      await sql.close();
    }
  }
}
console.log(`Sync development HTTP smoke passed: ${checks} status checks`);
