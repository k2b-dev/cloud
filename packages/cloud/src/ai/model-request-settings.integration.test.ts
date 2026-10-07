import { beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { databaseSuite, testInfra } from "../../../../scripts/fixtures/test-infra";
import routes from "../api/admin-core-settings";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { set as writeSetting } from "../services/settings";
import { decryptValue } from "../services/settings/crypto";
import { migrateCloudAi } from "./migrate";
import { setAiModelPricing } from "./model-pricing";
import { getAiModelRequestSettings, setAiModelRequestSettings } from "./model-request-settings";
import { getAiRequestHeaders, listAiRequestHeaderNames } from "./request-headers";

const suite = databaseSuite();
beforeAll(async () => {
  if (testInfra.database) await migrateCloudAi();
});
suite("model request settings persistence", () => {
  test("encrypts write-only header patches, keeps omitted headers/fields, guards replacements and prunes on deletion", async () => {
    const key = "ai.model_profiles_json";
    const id = `request-${crypto.randomUUID()}`;
    const profile = {
      id,
      label: "Request settings",
      provider: "vllm",
      model: "test",
      enabled: true,
      capabilities: ["streaming"],
      dataBoundary: "private",
      reasoningEffort: "low",
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
    };
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users(uid,provider,profile,display_name) VALUES(${id},'local','user',${id}) RETURNING id`;
    const actor = buildProjectedUser({ id: user!.id, provider: "local", profile: "user", effective_admin: true });
    const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
      user: actor,
      data: { userId: actor.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: new Date(Date.now() + 60000).toISOString() },
    });
    const save = (profiles: unknown[]) =>
      routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
        body: JSON.stringify({ "ai.enabled": false, [key]: JSON.stringify(profiles) }),
      });
    const read = async () => {
      const [row] = await sql<{ value: string }[]>`SELECT value FROM settings.entries WHERE key=${key}`;
      return await decryptValue(row!.value);
    };
    try {
      await writeSetting(key, JSON.stringify([profile]));
      const first = await getAiModelRequestSettings(id);
      const configured = await setAiModelRequestSettings(
        id,
        { expected: first.revision, requestHeaders: { "X-Token": "test-header-secret", "X-Keep": "keep-secret" } },
        actor.id,
      );
      expect(configured.requestHeaderNames).toEqual(["X-Keep", "X-Token"]);
      expect(configured.reasoningEffort).toBe("low");
      const [raw] = await sql<{ secret: string }[]>`SELECT secret FROM ai.model_request_headers WHERE profile_id=${id}`;
      expect(raw!.secret).not.toContain("test-header-secret");
      expect(JSON.stringify(configured)).not.toContain("test-header-secret");
      expect(String(await read())).not.toContain("requestHeaders");
      expect(await getAiRequestHeaders(id)).toEqual({ "X-Token": "test-header-secret", "X-Keep": "keep-secret" });
      await expect(
        setAiModelRequestSettings(id, { expected: first.revision, requestHeaders: { "X-Token": "replacement-secret" } }, actor.id),
      ).rejects.toThrow("changed");
      expect((await save([{ ...profile, label: "Renamed" }])).status).toBe(204);
      expect((await getAiRequestHeaders(id))["X-Token"]).toBe("test-header-secret");
      expect((await save([{ ...profile, requestHeaders: { "x-token": "replacement-secret", "X-Keep": null } }])).status).toBe(204);
      expect(await getAiRequestHeaders(id)).toEqual({ "x-token": "replacement-secret" });
      const prices = { inputPerMillion: 1, outputPerMillion: 2 };
      await setAiModelPricing(id, prices, null, actor.id);
      expect(JSON.parse(String(await read()))[0]).toMatchObject({ reasoningEffort: "low", extraBody: profile.extraBody, pricing: prices });
      const latest = await getAiModelRequestSettings(id);
      const cleared = await setAiModelRequestSettings(
        id,
        { expected: latest.revision, reasoningEffort: null, extraBody: null, clearRequestHeaders: true },
        actor.id,
      );
      expect(cleared).toMatchObject({ reasoningEffort: null, extraBody: null, requestHeaderNames: [] });
      expect(cleared.revision).not.toBe(latest.revision);
      expect((await save([{ ...profile, requestHeaders: { "X-Token": "prune-secret" } }])).status).toBe(204);
      expect((await save([])).status).toBe(204);
      expect(await sql`SELECT profile_id FROM ai.model_request_headers WHERE profile_id=${id}`).toHaveLength(0);
      expect((await listAiRequestHeaderNames())[id]).toBeUndefined();
      const events = await sql<{ metadata: unknown }[]>`SELECT metadata FROM audit.events WHERE actor_user_id=${actor.id}::uuid`;
      expect(JSON.stringify(events)).not.toContain("test-header-secret");
      expect(JSON.stringify(events)).not.toContain("replacement-secret");
    } finally {
      authenticate.mockRestore();
    }
  });
});
