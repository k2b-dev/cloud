import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as credentials from "../ai/credentials";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import * as settings from "../services/settings";
import routes from "./admin-core-settings";

// Every setting read and credential lookup is injected; nothing touches the shared settings store.
const profile = (id: string, label: string) => ({
  id,
  label,
  provider: "ollama",
  model: id,
  enabled: true,
  capabilities: ["streaming", "vision"],
});
const stored: Record<string, unknown> = {
  "ai.enabled": true,
  "ai.default_model_id": "cortecs",
  "ai.background_model_id": "",
  "ai.vision_model_id": "tensorx",
  "ai.audio_model_id": "",
  "ai.workflow_model_id": "",
  "ai.model_profiles_json": JSON.stringify([profile("tensorx", "TensorX Standard"), profile("cortecs", "Cortecs")]),
};

const restores: Array<{ mockRestore: () => void }> = [];
beforeEach(() => {
  const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: true });
  restores.push(
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, expiresAt: new Date(Date.now() + 60000).toISOString() },
    }),
    spyOn(settings, "get").mockImplementation((async (key: string) => stored[key]) as typeof settings.get),
    spyOn(settings, "set").mockRejectedValue(new Error("test must not write settings")),
    spyOn(credentials, "listAiCredentialProfileIds").mockResolvedValue([]),
  );
});
afterEach(() => {
  for (const spy of restores.splice(0)) spy.mockRestore();
});

const removeTensorX = (language: string) =>
  routes.request("/", {
    method: "PUT",
    headers: { Accept: "application/json", "Content-Type": "application/json", "Accept-Language": language, Cookie: "session_token=test" },
    body: JSON.stringify({ "ai.model_profiles_json": JSON.stringify([profile("cortecs", "Cortecs")]) }),
  });

test("removing a profile the Vision model still uses returns a coded, localized, field-level error", async () => {
  const response = await removeTensorX("en");

  expect(response.status).toBe(400);
  const message =
    "The Vision tool model still references “TensorX Standard”. Select another Vision tool model or disable the view_image fallback before removing this profile.";
  expect(await response.json()).toEqual({
    message: "The AI settings were not saved. Resolve the problems below and save again.",
    errors: { "ai.vision_model_id": message },
    issues: [{ code: "model_profile_missing", setting: "ai.vision_model_id", profileId: "tensorx", message }],
  });
});

test("the same rejection follows the request locale", async () => {
  const body = (await (await removeTensorX("de-DE")).json()) as { message: string; errors: Record<string, string> };

  expect(body.message).toStartWith("Die KI-Einstellungen wurden nicht gespeichert.");
  expect(body.errors["ai.vision_model_id"]).toStartWith("Das Modell für das Bildwerkzeug verweist noch auf „TensorX Standard“.");
});
