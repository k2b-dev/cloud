import { expect, test } from "bun:test";
import { createAiOpenAiRoutes, createCoreApiRouter } from "@k2b/cloud/api";
import { accounts, serviceAccountCredentials } from "@k2b/cloud/services";
import { coreSettings } from "@k2b/cloud/services/settings/api";
import { sql } from "bun";
import { Hono } from "hono";
import { databaseSuite } from "../../../scripts/fixtures/test-infra";
import "../../../scripts/fixtures/authorization-preload";
import { aiChatTaskRoutes } from "./ai-chat-task-routes";

databaseSuite()("Core OpenAI API mount order", () => {
  test("the dedicated endpoint precedes the task and generic AI auth middleware", async () => {
    const id = crypto.randomUUID();
    const enabled = await coreSettings.get<boolean>("ai.openai_api_enabled");
    const unused = async () => {
      throw new Error("Unused notification");
    };
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES(${id}::uuid,${`mount-${id}`},'local','user')`;
    try {
      const user = await accounts.users.get({ id });
      if (!user) throw new Error("User fixture missing");
      await coreSettings.set("ai.openai_api_enabled", true);
      const models = await serviceAccountCredentials.createUserApiToken({ user, name: "Models", access: "models" });
      const full = await serviceAccountCredentials.createUserApiToken({ user, name: "Full" });
      if (!models.ok || !full.ok) throw new Error("Key fixtures failed");
      const { api } = createCoreApiRouter({
        notifications: { sendMagicLink: unused, sendIpaLoginHint: unused, sendPasswordReset: unused },
      });
      const coreApi = new Hono().route("/ai/openai/v1", createAiOpenAiRoutes()).route("/ai", aiChatTaskRoutes).route("/", api);
      const router = new Hono().route("/api", coreApi);
      const headers = { authorization: `Bearer ${models.data.token}` };
      expect((await router.request("/api/ai/openai/v1/models", { headers })).status).toBe(200);
      expect((await router.request("/api/ai/openai/v1/unknown", { headers })).status).toBe(404);
      expect((await router.request("/api/ai/status", { headers })).status).toBe(401);
      expect((await router.request("/api/ai/tasks", { headers })).status).toBe(401);
      expect((await router.request("/api/ai/openai/v1/models", { headers: { authorization: `Bearer ${full.data.token}` } })).status).toBe(
        401,
      );
    } finally {
      await coreSettings.set("ai.openai_api_enabled", enabled);
      await sql`DELETE FROM auth.users WHERE id=${id}::uuid`;
    }
  });
});
