import { beforeAll, expect, test } from "bun:test";
import type { Provider } from "@k2b/nessi";
import { sql } from "bun";
import { Hono } from "hono";
import { websocket } from "hono/bun";
import { z } from "zod";
import { uniqueCallerAddress } from "../../../../scripts/fixtures/caller-address";
import { databaseSuite } from "../../../../scripts/fixtures/test-infra";
import "../../../../scripts/fixtures/authorization-preload";
import { createCoreApiRouter } from "../api";
import type { AuthContext } from "../server";
import { accounts } from "../services/accounts";
import { serviceAccountCredentials } from "../services/service-account-credentials";
import { session } from "../services/session";
import { coreSettings } from "../services/settings/api";
import { aiLive, aiLiveChannels } from "./live";
import { createAiOpenAiRoutes } from "./openai-api";
import type { AiModelProfile } from "./types";

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
      const models = await serviceAccountCredentials.createUserApiToken({ user, name: "Models only", access: "models" });
      const full = await serviceAccountCredentials.createUserApiToken({ user, name: "Full" });
      if (!models.ok || !full.ok) throw new Error("Key fixtures failed");
      expect(models.data.credential.scopes).toEqual(["ai:inference"]);
      expect(full.data.credential.scopes).toEqual([]);
      const auditRows = await sql<{ access: string }[]>`
        SELECT metadata->>'access' AS access FROM audit.events
        WHERE action='service_account_credential.create' AND target_id=${models.data.credential.id}`;
      expect(auditRows).toEqual([{ access: "models" }]);
      const { api } = createCoreApiRouter({
        notifications: {
          sendMagicLink: unusedNotification,
          sendIpaLoginHint: unusedNotification,
          sendPasswordReset: unusedNotification,
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

      const inference = createAiOpenAiRoutes({ listModels: async () => [profile], resolveModel: async () => ({ profile, provider }) });
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
      },
    });
    const router = new Hono<AuthContext>().post("/issue", async (c) => c.json({ token: await session.create(c, id) })).route("/api", api);
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
