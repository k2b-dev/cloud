import { expect, spyOn, test } from "bun:test";
import * as cloud from "@k2b/cloud";
import * as server from "@k2b/cloud/server";
import * as services from "@k2b/cloud/services";
import { SettingUnreadableError, settingsService } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { ok } from "@k2b/stdlib";
import { stubRouterInfrastructure } from "../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../scripts/fixtures/unit-clients";
import * as registeredApps from "./registered-apps";

useUnitClients();

test("Gateway Ops forwards explicit replacement and preserves unreadable conflicts", async () => {
  const limit = spyOn(server, "rateLimit").mockReturnValue(async (_c, next) => next());
  // The compression router guard may have imported ./api first, so the real limiter can still run.
  const infrastructure = stubRouterInfrastructure();
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
  const apps = spyOn(cloud, "listApps").mockResolvedValue([]);
  const legacy = spyOn(services, "settingsDeleteLegacyKeys").mockResolvedValue({ deleted: ["obsolete.setting"] });
  const record = spyOn(services.audit, "record").mockResolvedValue();
  const remove = spyOn(registeredApps, "removeOfflineRegisteredApp").mockResolvedValue(ok({ id: "offline-app" }));
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
    expect(update).toHaveBeenLastCalledWith({
      key,
      value: "new",
      replaceUnreadable: undefined,
      audit: expect.objectContaining({ action: "settings.update", actor: { userId: user.id } }),
    });

    update.mockResolvedValue(ok(undefined));
    expect((await request(true)).status).toBe(200);
    expect(update).toHaveBeenLastCalledWith({
      key,
      value: "new",
      replaceUnreadable: true,
      audit: expect.objectContaining({ action: "settings.update", actor: { userId: user.id } }),
    });
    expect((await apiRoutes.request("/settings/legacy", { method: "DELETE", headers: { Cookie: "session_token=test" } })).status).toBe(200);
    expect(legacy).toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settings.legacy.delete", actor: { userId: user.id }, metadata: { keys: ["obsolete.setting"] } }),
    );
    expect((await apiRoutes.request("/apps/offline-app", { method: "DELETE", headers: { Cookie: "session_token=test" } })).status).toBe(
      200,
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "gateway.app.remove", target: { type: "app", id: "offline-app" } }),
    );
  } finally {
    for (const spy of [remove, apps, legacy, record, update, authenticate, clock, limit, ...infrastructure]) spy.mockRestore();
  }
});
