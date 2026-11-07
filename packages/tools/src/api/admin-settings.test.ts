import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { oauthTokens, settingsService } from "@k2b/cloud/services";
import { buildProjectedUser } from "@k2b/cloud/services/session/user";
import { ok } from "@k2b/stdlib";
import { assertAdminWriteAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { createToolsApiRouter } from ".";

useUnitClients();
afterEach(() => mock.restore());
const routes = createToolsApiRouter();

test("Tools settings require write scope and a current administrator, with audit attribution", async () => {
  stubRouterInfrastructure();
  const update = spyOn(settingsService.entry, "update").mockResolvedValue(ok(undefined));
  for (const [key, value] of [
    ["tools.speedtest_server", "https://speedtest.example.com"],
    ["tools.speedtest_enabled", false],
  ] as const) {
    await assertAdminWriteAuthorization(
      (headers) =>
        routes.request(`/admin/settings/${key}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ value, replaceUnreadable: true }),
        }),
      () => update.mock.calls.length,
    );
    expect(update).toHaveBeenLastCalledWith({
      key,
      value,
      replaceUnreadable: true,
      audit: {
        action: "settings.update",
        outcome: "allowed",
        actor: { userId: "11111111-1111-4111-8111-111111111111" },
        target: { type: "setting", id: key },
      },
    });
  }
});

test("Tools rejects cross-owner keys, malformed input and invalid declared values before persistence", async () => {
  stubRouterInfrastructure();
  const user = buildProjectedUser({
    id: "11111111-1111-4111-8111-111111111111",
    provider: "local",
    profile: "user",
    effective_admin: true,
  });
  spyOn(oauthTokens, "verifyAccessToken").mockResolvedValue({ kind: "user", user, scopes: ["write"], payload: {} });
  const update = spyOn(settingsService.entry, "update");
  const headers = { authorization: "Bearer unchanged-token", "content-type": "application/json" };
  for (const [key, body] of [
    ["mail.contact_directory.app", { value: "tools" }],
    ["tools.speedtest_enabled", {}],
    ["tools.speedtest_enabled", { value: false, replaceUnreadable: "yes" }],
  ]) {
    const response = await routes.request(`/admin/settings/${key}`, { method: "PUT", headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
  }
  expect(update).not.toHaveBeenCalled();
  for (const [key, value] of [
    ["tools.nonexistent", true],
    ["tools.speedtest_enabled", "disabled"],
    ["tools.speedtest_server", "http://speedtest.example.com"],
    ["tools.speedtest_server", "https://user:password@speedtest.example.com"],
  ]) {
    const response = await routes.request(`/admin/settings/${key}`, { method: "PUT", headers, body: JSON.stringify({ value }) });
    expect(response.status).toBe(400);
  }
});
