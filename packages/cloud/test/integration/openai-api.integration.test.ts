import { beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Provider } from "@k2b/nessi";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { aiLive, aiLiveChannels } from "../../src/ai/live";
import { createAiOpenAiRoutes } from "../../src/ai/openai-api";
import { aiModelAccess } from "../../src/ai/model-access";
import { acquire } from "../../src/ai/openai-api-slots";
import { aiQuotas } from "../../src/ai/quotas";
import type { Principal } from "../../src/contracts/shared";
import { createAccess } from "../../src/server/services/access";
import { serviceAccounts } from "../../src/services/service-accounts";
import type { AiModelProfile } from "../../src/ai/types";
import { createCoreApiRouter } from "../../src/api";
import type { AuthContext } from "../../src/server";
import { accounts } from "../../src/services/accounts";
import { serviceAccountCredentials } from "../../src/services/service-account-credentials";
import { session } from "../../src/services/session";
import { createTestBrowserSignIn } from "../../src/services/session/session.test-fixture";
import { coreSettings } from "../../src/services/settings/api";

const suite = databaseSuite();
const profile: AiModelProfile = {
  id: "openai-api-integration",
  label: "API fixture",
  provider: "ollama",
  model: "fixture",
  enabled: true,
  capabilities: ["streaming"],
  dataBoundary: "private",
  contextWindow: 1000,
  maxOutputTokens: 20,
};
const provider: Provider = {
  name: "fixture",
  family: "ollama",
  model: "fixture",
  contextWindow: 1000,
  capabilities: { streaming: true, tools: false, thinking: false, images: false, usage: true },
  async complete() {
    throw new Error("The OpenAI-compatible API serves every request through stream()");
  },
  async *stream() {
    yield { type: "block_start", blockId: "text", index: 0, kind: "text" };
    yield { type: "block_delta", blockId: "text", delta: "Completed" };
    yield { type: "block_end", blockId: "text", index: 0, block: { type: "text", text: "Completed" } };
    yield { type: "usage", usage: { input: 10, output: 2, total: 12 }, finishReason: "stop" };
  },
};
// Bun's WebSocket takes handshake headers, which the DOM type does not declare.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
const unusedNotification = async () => {
  throw new Error("No notifications in this fixture");
};

suite("models-only API identity and inference boundaries", () => {
  beforeAll(async () => {
    await coreSettings.set("security.rate_limit_per_second", 1000);
  });
  test("real personal keys fail on Cloud routers, enter only models inference and book usage", async () => {
    const id = crypto.randomUUID();
    const enabled = await coreSettings.get<boolean>("ai.openai_api_enabled");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`models-${id}`},'local','user')`;
    try {
      const user = await accounts.users.get({ id });
      if (!user) throw new Error("User fixture missing");
      await coreSettings.set("ai.openai_api_enabled", true);
      const models = await serviceAccountCredentials.createUserApiToken({
        browserSignIn: await createTestBrowserSignIn(user.id),
        user,
        name: "Models only",
        access: "models",
      });
      const full = await serviceAccountCredentials.createUserApiToken({
        browserSignIn: await createTestBrowserSignIn(user.id),
        user,
        name: "Full",
      });
      if (!models.ok || !full.ok) throw new Error("Key fixtures failed");
      expect(models.data.credential.scopes).toEqual(["ai:inference"]);
      expect(full.data.credential.scopes).toEqual([]);
      for (const key of [models.data, full.data]) {
        const secret = key.token.split("_")[2];
        if (!secret) throw new Error("Key secret missing");
        const [stored] = await sql<{ secret_hash: string }[]>`
          SELECT secret_hash FROM auth.service_account_credentials WHERE id = ${key.credential.id}::uuid`;
        if (!stored) throw new Error("Stored credential missing");
        const oldPlatformHash = `sha256:${createHash("sha256").update(secret).digest("hex")}`;
        expect(stored.secret_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
        if (key === models.data) {
          expect(stored.secret_hash).not.toBe(oldPlatformHash);
          expect(stored.secret_hash).toBe(`sha256:${createHash("sha256").update(`ai:inference:${secret}`).digest("hex")}`);
        } else expect(stored.secret_hash).toBe(oldPlatformHash);
        expect((await serviceAccountCredentials.authenticateApiToken(key.token))?.credential.id).toBe(key.credential.id);
      }
      const auditRows = await sql<{ access: string }[]>`
        SELECT metadata->>'access' AS access FROM audit.events
        WHERE action='service_account_credential.create' AND target_id=${models.data.credential.id}`;
      expect(auditRows).toEqual([{ access: "models" }]);
      const { api } = createCoreApiRouter({
        notifications: {
          sendMagicLink: unusedNotification,
          sendIpaLoginHint: unusedNotification,
          sendPasswordReset: unusedNotification,
          sendNewBrowserSignIn: async () => {},
        },
      });
      const core = new Hono().route("/ai/openai/v1", createAiOpenAiRoutes()).route("/", api);
      const router = new Hono<AuthContext>().route("/api/ai/live", aiLive.routes(aiLiveChannels)).route("/api", core);
      const headers = { authorization: `Bearer ${models.data.token}`, "content-type": "application/json" };
      for (const [method, path] of [
        ["GET", "/api/me"],
        ["POST", "/api/me/api-keys"],
        ["DELETE", `/api/me/api-keys/${models.data.credential.id}`],
        ["GET", "/api/ai/status"],
        ["GET", "/api/ai/approval-preferences"],
        ["POST", "/api/mcp/v1"],
        ["POST", "/api/capabilities/v1/streams/read"],
        ["GET", "/api/search"],
      ] as const) {
        const response = await router.request(path, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify({ name: "nested" }) : undefined,
        });
        expect(response.status).toBe(401);
      }
      expect((await router.request("/api/me", { headers: { authorization: `Bearer ${full.data.token}` } })).status).toBe(200);
      expect((await router.request("/api/ai/openai/v1/models", { headers })).status).toBe(200);
      expect((await router.request("/api/ai/openai/v1/models", { headers: { authorization: `Bearer ${full.data.token}` } })).status).toBe(
        401,
      );

      // Live uses a protocol refusal after upgrade, rather than an HTTP authentication error.
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, websocket, fetch: router.fetch });
      try {
        const socket = new BunWebSocket(`ws://127.0.0.1:${server.port}/api/ai/live`, {
          headers: { authorization: headers.authorization, "x-forwarded-for": uniqueCallerAddress() },
        });
        const refusal = await new Promise<{ frame: unknown; code: number }>((resolve, reject) => {
          let frame: unknown;
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Live refusal timed out"));
          }, 3000);
          socket.onmessage = (event) => {
            frame = JSON.parse(String(event.data));
          };
          socket.onerror = () => {
            clearTimeout(timeout);
            reject(new Error("Live socket failed"));
          };
          socket.onclose = (event) => {
            clearTimeout(timeout);
            resolve({ frame, code: event.code });
          };
        });
        expect(refusal).toEqual({
          frame: { t: "error", code: "login_required", message: "Sign in again to receive live updates." },
          code: 1008,
        });
      } finally {
        await server.stop(true);
      }

      const inference = createAiOpenAiRoutes({
        assertModelAccess: async () => {},
        listModels: async () => [profile],
        resolveModel: async () => ({ profile, provider }),
      });
      const completed = await inference.request("/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({ model: profile.id, messages: [{ role: "user", content: "Hi" }] }),
      });
      expect(completed.status).toBe(200);
      expect((await completed.json()).choices[0].message.content).toBe("Completed");
      const rows = await sql<{ kind: string; task: string; user_id: string; input: number; output: number }[]>`
        SELECT kind,task,user_id,input::int AS input,output::int AS output FROM ai.inference_calls WHERE user_id=${id}::uuid AND task='openai-api'`;
      expect(rows).toEqual([{ kind: "chat", task: "openai-api", user_id: id, input: 10, output: 2 }]);
      await coreSettings.set("ai.openai_api_enabled", false);
      const stopped = await router.request("/api/ai/openai/v1/models", { headers });
      expect(stopped.status).toBe(403);
      expect((await stopped.json()).error.code).toBe("openai_api_disabled");
    } finally {
      await coreSettings.set("ai.openai_api_enabled", enabled);
      await sql`DELETE FROM ai.inference_calls WHERE user_id=${id}::uuid`;
      await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });
  test("personal key creation requires the switch and a direct browser actor", async () => {
    const id = crypto.randomUUID();
    const enabled = await coreSettings.get<boolean>("ai.openai_api_enabled");
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`mint-${id}`},'local','user')`;
    const { api } = createCoreApiRouter({
      notifications: {
        sendMagicLink: unusedNotification,
        sendIpaLoginHint: unusedNotification,
        sendPasswordReset: unusedNotification,
        sendNewBrowserSignIn: async () => {},
      },
    });
    const router = new Hono<AuthContext>()
      .post("/issue", async (c) => c.json({ token: await session.create(c, id, { method: "password", notify: async () => {} }) }))
      .route("/api", api);
    try {
      const sessionBody = z.object({ token: z.string() }).parse(await (await router.request("/issue", { method: "POST" })).json());
      await sql`UPDATE auth.session_families SET legal_pending=false WHERE user_id=${id}::uuid`;
      const create = () =>
        router.request("/api/me/api-keys", {
          method: "POST",
          headers: { cookie: `session_token=${sessionBody.token}`, "content-type": "application/json" },
          body: JSON.stringify({ name: "Models", access: "models" }),
        });
      await coreSettings.set("ai.openai_api_enabled", false);
      const disabled = await create();
      expect(disabled.status).toBe(403);
      expect((await disabled.json()).message).toBe(
        "Models-only API keys are turned off. An administrator can turn on the OpenAI-compatible API in the AI settings.",
      );
      await coreSettings.set("ai.openai_api_enabled", true);
      const allowed = await create();
      expect(allowed.status).toBe(201);
      expect(await allowed.json()).toMatchObject({ credential: { scopes: ["ai:inference"] } });
    } finally {
      await coreSettings.set("ai.openai_api_enabled", enabled);
      await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });
});

for (const kind of ["standalone", "agent"] as const) {
  suite(`${kind} models-only machine tokens`, () => {
    test("real keys enforce grants, purpose, dispatch revalidation, quotas, revoke and disable", async () => {
      const ownerId = crypto.randomUUID();
      const enabled = await coreSettings.get<boolean>("ai.openai_api_enabled");
      const previousQuota = await aiQuotas.config();
      const previousProfiles = await coreSettings.get<string>("ai.model_profiles_json");
      const model = { ...profile, id: `machine-${crypto.randomUUID()}`, pricing: { inputPerMillion: 1, outputPerMillion: 1 } };
      const otherModel = `${model.id}-other`;
      let machineId: string | undefined;
      let dispatches = 0;
      await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${ownerId}::uuid,${`owner-${ownerId}`},'local','user')`;
      try {
        await coreSettings.set("ai.openai_api_enabled", true);
        await sql`UPDATE ai.cost_config SET enabled=false`;
        await coreSettings.set("ai.model_profiles_json", JSON.stringify([model]));
        const actor = await accounts.users.get({ id: ownerId });
        if (!actor) throw new Error("Missing actor fixture");
        const account = await serviceAccounts.createStandalone({ name: `Model worker ${ownerId}`, kind, createdBy: ownerId });
        if (!account.ok) throw new Error("Missing machine fixture");
        machineId = account.data.id;
        const key = await serviceAccountCredentials.createStandaloneApiToken({
          serviceAccountId: machineId,
          actor,
          name: "Models",
          access: "models",
        });
        const second = await serviceAccountCredentials.createStandaloneApiToken({
          serviceAccountId: machineId,
          actor,
          name: "Second model key",
          access: "models",
        });
        const full = await serviceAccountCredentials.createStandaloneApiToken({ serviceAccountId: machineId, actor, name: "Cloud" });
        if (!key.ok || !full.ok || !second.ok) throw new Error("Missing token fixtures");
        const [stored] = await sql<
          { secret_hash: string }[]
        >`SELECT secret_hash FROM auth.service_account_credentials WHERE id=${key.data.credential.id}::uuid`;
        expect(stored?.secret_hash).toBe(
          `sha256:${createHash("sha256")
            .update(`ai:inference:${key.data.token.split("_")[2]}`)
            .digest("hex")}`,
        );
        const [creation] = await sql<
          { access: string }[]
        >`SELECT metadata->>'access' AS access FROM audit.events WHERE action='service_account_credential.create' AND target_id=${key.data.credential.id}`;
        expect(creation?.access).toBe("models");
        const headers = { authorization: `Bearer ${key.data.token}`, "content-type": "application/json" };
        const machineSubject = { type: "service_account", serviceAccountId: machineId } as const;
        const app = (beforeResolve?: () => Promise<void>) =>
          createAiOpenAiRoutes({
            listModels: (subject) => aiModelAccess.filterModels([model], subject),
            resolveModel: async () => {
              await beforeResolve?.();
              return {
                profile: model,
                provider: {
                  ...provider,
                  stream: async function* (request) {
                    dispatches++;
                    yield* provider.stream(request);
                  },
                },
              };
            },
          });
        const call = (routes = app(), token = key.data.token, modelId = model.id, stream = false) =>
          routes.request("/chat/completions", {
            method: "POST",
            headers: { ...headers, authorization: `Bearer ${token}` },
            body: JSON.stringify({ model: modelId, messages: [{ role: "user", content: "Hello" }], stream }),
          });
        await sql`INSERT INTO ai.model_access_resources(profile_id) VALUES(${model.id}),(${otherModel})`;
        const grant = async (id: string, principal: Principal) => {
          const access = await createAccess({ principal, permission: "read" });
          if (!access.ok) throw new Error("Grant fixture failed");
          await sql`INSERT INTO ai.model_access(profile_id,access_id) VALUES(${id},${access.data.id}::uuid)`;
        };
        const clear = () => sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.model_access WHERE profile_id=${model.id})`;
        // The creator's access never supplies the machine's access.
        await grant(model.id, { type: "user", userId: ownerId });
        expect((await call()).status).toBe(404);
        expect(dispatches).toBe(0);
        await grant(otherModel, { type: "service_account", serviceAccountId: machineId });
        expect((await call()).status).toBe(404);
        await grant(model.id, { type: "service_account", serviceAccountId: machineId });
        expect((await call()).status).toBe(200);
        expect(dispatches).toBe(1);
        expect((await call(app(), full.data.token)).status).toBe(401);
        expect((await call(app(), key.data.token, otherModel)).status).toBe(404);
        const { api } = createCoreApiRouter({
          notifications: {
            sendMagicLink: unusedNotification,
            sendIpaLoginHint: unusedNotification,
            sendPasswordReset: unusedNotification,
            sendNewBrowserSignIn: async () => {},
          },
        });
        for (const path of ["/me", "/ai/status", "/search"]) expect((await api.request(path, { headers })).status).toBe(401);
        // Fresh dispatch check must still run after a successful model-list snapshot.
        for (const stream of [false, true]) {
          const response = await call(
            app(async () => {
              await clear();
            }),
            key.data.token,
            model.id,
            stream,
          );
          expect(response.status).toBe(403);
          expect((await response.json()).error.code).toBe("model_access_denied");
          expect(dispatches).toBe(1);
          await grant(model.id, { type: "service_account", serviceAccountId: machineId });
        }
        const ledger = await sql<
          { user_id: string | null; service_account_id: string; credential_id: string; status: string; input: number; reserved: string }[]
        >`
          SELECT user_id,service_account_id,credential_id,status,input::int,reserved::text FROM ai.inference_calls WHERE service_account_id=${machineId}::uuid ORDER BY started_at`;
        expect(ledger).toHaveLength(3);
        expect(ledger[0]).toMatchObject({
          user_id: null,
          service_account_id: machineId,
          credential_id: key.data.credential.id,
          status: "ok",
          input: 10,
        });
        for (const row of ledger.slice(1)) expect(row).toMatchObject({ status: "failed", input: 0, reserved: "0.000000000000" });
        await sql`UPDATE auth.service_account_credentials SET expires_at='2000-01-01T00:00:00Z' WHERE id=${key.data.credential.id}::uuid`;
        expect((await call()).status).toBe(401);
        await sql`UPDATE auth.service_account_credentials SET expires_at=NULL WHERE id=${key.data.credential.id}::uuid`;
        const disabledDuringResolve = await call(
          app(async () => {
            await serviceAccounts.setStatus({ id: machineId!, status: "disabled" });
          }),
        );
        expect(disabledDuringResolve.status).toBe(401);
        expect(dispatches).toBe(1);
        await serviceAccounts.setStatus({ id: machineId, status: "active" });
        // Every key shares the existing account quota and concurrency identity.
        await sql`UPDATE ai.cost_config SET enabled=true,rules=${JSON.stringify([{ scope: "*", hours: 24, anchor: "2020-01-01T00:00:00Z", grants: [] }])}::jsonb`;
        expect((await call()).status).toBe(429);
        expect((await call(app(), second.data.token)).status).toBe(429);
        await sql`UPDATE ai.cost_config SET rules=${JSON.stringify([{ scope: "*", hours: 24, anchor: "2020-01-01T00:00:00Z", grants: [{ principal: machineSubject, limit: 1 }] }])}::jsonb`;
        expect((await call()).status).toBe(200);
        const slot = await acquire({ subject: machineSubject, limit: 1 });
        const previousLimit = await coreSettings.get<number>("ai.openai_api_max_concurrent_requests");
        try {
          await coreSettings.set("ai.openai_api_max_concurrent_requests", 1);
          expect((await call()).status).toBe(429);
          expect((await call(app(), second.data.token)).status).toBe(429);
        } finally {
          await slot?.release();
          await coreSettings.set("ai.openai_api_max_concurrent_requests", previousLimit);
        }
        await clear();
        // An intentionally broad grant counts as explicit access.
        await grant(model.id, { type: "authenticated" });
        expect((await call()).status).toBe(200);
        await serviceAccounts.setStatus({ id: machineId, status: "disabled" });
        expect((await call()).status).toBe(401);
        await serviceAccounts.setStatus({ id: machineId, status: "active" });
        expect((await call()).status).toBe(200);
        await serviceAccountCredentials.revoke({ credentialId: key.data.credential.id, actor });
        expect((await call()).status).toBe(401);
        expect((await app().request("/models", { headers })).status).toBe(401);
      } finally {
        await coreSettings.set("ai.openai_api_enabled", enabled);
        await coreSettings.set("ai.model_profiles_json", previousProfiles);
        await sql`UPDATE ai.cost_config SET enabled=${previousQuota.enabled},rules=${JSON.stringify(previousQuota.rules)}::jsonb`;
        await sql`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM ai.model_access WHERE profile_id IN (${model.id},${otherModel}))`;
        await sql`DELETE FROM ai.model_access_resources WHERE profile_id IN (${model.id},${otherModel})`;
        if (machineId) {
          await sql`DELETE FROM ai.inference_calls WHERE service_account_id=${machineId}::uuid`;
          await sql`DELETE FROM auth.service_accounts WHERE id=${machineId}::uuid`;
        }
        await sql`DELETE FROM auth.users WHERE id=${ownerId}::uuid`;
      }
    }, 20_000);
  });
}
