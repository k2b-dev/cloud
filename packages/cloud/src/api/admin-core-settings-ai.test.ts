import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import routes from "./admin-core-settings";

afterEach(() => mock.restore());
test("removed model settings cannot be written through generic settings", async () => {
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00.000Z" },
  });
  for (const key of [
    "ai.model_profiles_json",
    "ai.default_model_id",
    "ai.background_model_id",
    "ai.workflow_model_id",
    "ai.vision_model_id",
    "ai.audio_model_id",
  ]) {
    const response = await routes.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
      body: JSON.stringify({ updates: { [key]: "old" } }),
    });
    expect(response.status).toBe(400);
  }
});
