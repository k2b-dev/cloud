import { expect, test } from "bun:test";
import { announcements } from "../services/announcements";
import { invalidateSettingsCacheForAdmin } from "../services/settings/store";
import { buildProjectedUser } from "../services/session/user";
import { adminAnnouncementRoutes } from "./announcements";
import adminCoreSettingsRoutes from "./admin-core-settings";

const user = buildProjectedUser({ id: crypto.randomUUID(), provider: "local", profile: "user", effective_admin: false });
test("cache services reject missing and non-admin actors before touching Redis", async () => {
  for (const actor of [undefined, user]) {
    await expect(announcements.admin.invalidateCache(actor)).rejects.toMatchObject({ status: 403 });
    await expect(invalidateSettingsCacheForAdmin(actor)).rejects.toMatchObject({ status: 403 });
  }
});
test("cache routes require normal Core authentication", async () => {
  for (const routes of [adminAnnouncementRoutes, adminCoreSettingsRoutes]) {
    const response = await routes.request("/cache", { method: "DELETE", headers: { Accept: "application/json" } });
    expect(response.status).toBe(401);
  }
});
