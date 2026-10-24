import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import type { AuthContext } from "@k2b/cloud/server";
import { requireAppAccess } from "@k2b/cloud/server/middleware/app-access";
import { type AuthenticatedServiceAccountCredential, serviceAccountCredentials } from "@k2b/cloud/services/service-account-credentials";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { app as pulse } from "../config";
import { migrate } from "../migrate";
import { pulseService } from "../service";
import { type IngestFailure, ingestByApiKey } from "../service/ingest-writer";
import { fixtureBase } from "../store/base-store.test-fixture";
import ingestRoutes from "./routes/ingest";

const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const accountId = "11111111-1111-4111-8111-111111111111";
const createdAt = "2026-10-17T12:00:00.000Z";
// Same ingest-only credential as ingest-retry.test.ts: no generic write scope.
const credential = (): AuthenticatedServiceAccountCredential => ({
  serviceAccount: {
    id: accountId,
    name: "Ingest",
    kind: "resource_bound",
    status: "active",
    delegatedUserId: null,
    appId: "pulse",
    resourceType: "pulse_source",
    resourceId: "Src001",
    createdBy: null,
    createdAt,
  },
  credential: {
    id: accountId,
    serviceAccountId: accountId,
    name: "Ingest",
    kind: "api_token",
    status: "active",
    tokenPrefix: "0123456789abcdef01234567",
    scopes: ["pulse:ingest"],
    expiresAt: null,
    lastUsedAt: null,
    createdBy: null,
    createdAt,
    revokedAt: null,
    revokedBy: null,
  },
  delegatedUser: null,
});
const router = new Hono<AuthContext>()
  .use(
    "*",
    requireAppAccess(pulse.meta, async () => new Response("Pulse denied", { status: 403 })),
  )
  .route("/api/pulse", ingestRoutes);
const body = ' { "metrics": [{"name":"ä", "value":1}] } ';
const ingest = (path = "/api/pulse/ingest", authenticated = true) =>
  router.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
      "Idempotency-Key": "app-access-batch",
    },
    body,
  });

suiteFor("database", "valkey")("app-access Pulse ingest-only protocol", () => {
  let current: AuthenticatedServiceAccountCredential;
  const spies: { mockRestore(): void }[] = [];
  beforeAll(async () => {
    for (const name of ["auth", "settings"]) {
      const migration = `../../../core/src/migrate/core/${name}.ts`;
      await (await import(migration)).migrate();
    }
    await migrate();
  });
  beforeEach(() => {
    setSystemTime(new Date(createdAt));
    current = credential();
    // Persisted credential lookup is the canonical auth fixture. The real
    // ordinary resolver, app gate, ingest router and service checks still run.
    spies.push(spyOn(serviceAccountCredentials, "authenticateApiToken").mockImplementation(async () => current));
  });
  afterEach(() => {
    for (const spy of spies.splice(0).reverse()) spy.mockRestore();
    setSystemTime();
  });

  test("app-access leaves missing credentials and private Pulse neighbors gated", async () => {
    const call = spyOn(pulseService.ingest, "byApiKey");
    spies.push(call);
    expect((await ingest("/api/pulse/ingest", false)).status).toBe(401);
    for (const path of ["/api/pulse/bases", "/admin/pulse", "/api/pulse/ingest/private"]) {
      const rejected = await ingest(path);
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ code: "app_access_denied", app: "pulse" });
    }
    expect(call).not.toHaveBeenCalled();
  });

  test("app-access reaches the original ingest permission and exact source-binding checks", async () => {
    const call = spyOn(pulseService.ingest, "byApiKey").mockImplementation(ingestByApiKey);
    spies.push(call);
    current.credential.scopes = ["read"];
    let rejected = await ingest();
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({ message: "API key cannot ingest Pulse data" });
    current.credential.scopes = ["pulse:ingest"];
    for (const binding of [
      { kind: "standalone" as const, appId: null, resourceType: null, resourceId: null },
      { appId: "notebooks" },
      { resourceType: "other" },
      { resourceId: null },
    ]) {
      current.serviceAccount = { ...credential().serviceAccount, ...binding };
      rejected = await ingest();
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({ message: "API key is not bound to a Pulse ingest source" });
    }
    expect(call).toHaveBeenCalledTimes(5);
  });

  test("app-access ingest-only keys retain disabled-source and write-block recovery errors from the real domain service", async () => {
    // Canonical Postgres base fixture; no ClickHouse store is provisioned or
    // queried: both refusals precede any external write or quota reservation.
    const base = await fixtureBase();
    const sourceId = crypto.randomUUID();
    const sourceShortId = sourceId.replaceAll("-", "").slice(0, 6);
    current.serviceAccount.resourceId = sourceShortId;
    try {
      await sql`UPDATE pulse.base_stores SET state='active',write_block_reason='checkpoint_mismatch' WHERE base_id=${base.id}::uuid`;
      await sql`INSERT INTO pulse.sources(id,short_id,base_id,kind,name,enabled)
        VALUES(${sourceId}::uuid,${sourceShortId},${base.id}::uuid,'http_ingest','Protocol source',false)`;
      const disabled = await ingest();
      expect(disabled.status).toBe(404);
      expect(await disabled.json()).toMatchObject({ message: "Ingest source not found" });
      await sql`UPDATE pulse.sources SET enabled=true WHERE id=${sourceId}::uuid`;
      const blocked = await ingest();
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({
        code: "PULSE_BASE_WRITE_BLOCKED",
        message: "Pulse base writes are blocked. A Cloud admin must recheck or recreate its data store.",
      });
    } finally {
      await sql`DELETE FROM pulse.bases WHERE id=${base.id}::uuid`;
    }
  });

  const failures: IngestFailure[] = [
    { code: "PULSE_BASE_THROTTLED", status: 429, message: "Throttled", retryAfter: 17 },
    { code: "PULSE_QUOTA_UNAVAILABLE", status: 503, message: "Quota unavailable", retryAfter: 30 },
    { code: "PULSE_STORE_UNAVAILABLE", status: 503, message: "Store unavailable", retryAfter: 30 },
    { code: "PULSE_STORE_DISK_LOW", status: 503, message: "Disk low", retryAfter: 300 },
  ];
  test.each(failures)("app-access preserves ingest-only domain Retry-After for $code", async (error) => {
    const call = spyOn(pulseService.ingest, "byApiKey").mockResolvedValue({ ok: false, error });
    spies.push(call);
    const response = await ingest();
    expect(response.status).toBe(error.status);
    expect(response.headers.get("Retry-After")).toBe(String("retryAfter" in error ? error.retryAfter : 0));
    expect(await response.json()).toEqual({ code: error.code, message: error.message });
    expect(call).toHaveBeenCalledWith({
      serviceAccount: current.serviceAccount,
      scopes: ["pulse:ingest"],
      batch: { metrics: [{ name: "ä", value: 1 }] },
      idempotencyKey: "app-access-batch",
      requestBytes: new TextEncoder().encode(body).byteLength,
      locale: "en",
    });
  });
});
