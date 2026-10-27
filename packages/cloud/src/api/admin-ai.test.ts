import { expect, spyOn, test } from "bun:test";
import { aiModelCatalog } from "../ai/model-catalog";
import { ConfigConflict } from "../services/config-conflict";
import { buildProjectedUser } from "../services/session/user";
import { createAdminAiRoutes } from "./admin-ai";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });
const app = () =>
  createAdminAiRoutes(async (c, next) => {
    c.set("user", user);
    await next();
  });
test("stale AI revisions return the full current GET object and editor metadata", async () => {
  const current = { id: "chat", label: "Changed", revision: 3, variants: [], access: { entries: [], revision: 1 } };
  const changedBy = { id: user.id, name: "Editor" };
  const update = spyOn(aiModelCatalog, "updateModel").mockRejectedValue(new ConfigConflict(current, changedBy, "2026-10-16T12:00:00.000Z"));
  try {
    const response = await app().request("/models/chat", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 2, label: "Mine" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "conflict", current, changedBy, changedAt: "2026-10-16T12:00:00.000Z" });
    expect(update).toHaveBeenCalledWith("chat", { label: "Mine" }, 2, user.id, undefined);
  } finally {
    update.mockRestore();
  }
});
test("PATCH requires revision and rejects removed connection/profile fields", async () => {
  for (const input of [{ label: "Missing revision" }, { revision: 1, provider: "openai" }, { revision: 1, modelProfileId: "old" }]) {
    const response = await app().request("/models/chat", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(response.status).toBe(400);
  }
});
