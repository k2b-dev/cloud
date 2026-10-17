import { expect, spyOn, test } from "bun:test";
import { SettingUnreadableError } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { SQL, sql } from "bun";
import { app } from "../config";
import { weatherSettingsRouter } from "./settings";

test("Weather preserves the store's unreadable conflict instead of returning invalid input", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-02T03:04:05Z"));
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000001",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2026-01-03T03:04:05.000Z" },
  });
  const key = "weather.default_lat";
  const error = new SettingUnreadableError(key);
  const write = spyOn(app.settings, "set").mockRejectedValue(error);
  const tx = Object.assign(new SQL("postgres://localhost/unused_test"), {
    savepoint: () => {
      throw new Error("Unexpected savepoint");
    },
  });
  const begin = spyOn(sql, "begin").mockImplementation(async (run) => {
    if (typeof run !== "function") throw new Error("Expected transaction callback");
    await run(tx);
  });
  try {
    const response = await weatherSettingsRouter.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
      body: JSON.stringify({ [key]: 52 }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
    expect(write).toHaveBeenCalledWith(key, 52);
  } finally {
    for (const spy of [begin, write, authenticate, clock]) spy.mockRestore();
    await tx.close();
  }
});
