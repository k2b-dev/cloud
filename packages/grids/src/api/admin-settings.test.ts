import { afterAll, expect, spyOn, test } from "bun:test";
import { settingsService, SettingUnreadableError } from "@k2b/cloud/services";
import { session } from "@k2b/cloud/services/session";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { ok } from "@k2b/stdlib";
import router from "./admin-settings";

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
const headers = { "Content-Type": "application/json", Cookie: "session_token=test" };

afterAll(() => {
  for (const spy of [update, authenticate, clock]) spy.mockRestore();
});

test("Grids forwards explicit unreadable replacement and preserves the default 409", async () => {
  const key = "grids.workflow_concurrency";
  const error = new SettingUnreadableError(key);
  update.mockRejectedValue(error);
  const response = await router.request(`/${key}`, { method: "PUT", headers, body: JSON.stringify({ value: 10 }) });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "setting_unreadable", message: error.message });
  expect(update).toHaveBeenLastCalledWith({ key, value: 10, replaceUnreadable: undefined });

  update.mockResolvedValue(ok(undefined));
  const replaced = await router.request(`/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value: 10, replaceUnreadable: true }),
  });
  expect(replaced.status).toBe(200);
  expect(update).toHaveBeenLastCalledWith({ key, value: 10, replaceUnreadable: true });

  update.mockClear();
  const invalid = await router.request(`/${key}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ value: 10, replaceUnreadable: "true" }),
  });
  expect(invalid.status).toBe(400);
  expect(update).not.toHaveBeenCalled();
});
