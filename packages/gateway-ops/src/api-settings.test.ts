import { expect, spyOn, test } from "bun:test";
import * as server from "@k2b/cloud/server";
import { SettingUnreadableError, settingsService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { ok } from "@k2b/stdlib";

test("Gateway Ops forwards explicit replacement and preserves unreadable conflicts", async () => {
  const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
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
  const update = spyOn(settingsService.entry, "update");
  try {
    const { apiRoutes } = await import("./api");
    const key = "gateway.probe";
    const request = (replaceUnreadable?: boolean) =>
      apiRoutes.request(`/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Cookie: "session_token=test" },
        body: JSON.stringify({ value: "new", replaceUnreadable }),
      });
    const error = new SettingUnreadableError(key);
    update.mockRejectedValue(error);
    const response = await request();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
    expect(update).toHaveBeenLastCalledWith({ key, value: "new", replaceUnreadable: undefined });

    update.mockResolvedValue(ok(undefined));
    expect((await request(true)).status).toBe(200);
    expect(update).toHaveBeenLastCalledWith({ key, value: "new", replaceUnreadable: true });
  } finally {
    for (const spy of [update, authenticate, clock, limit]) spy.mockRestore();
  }
});
