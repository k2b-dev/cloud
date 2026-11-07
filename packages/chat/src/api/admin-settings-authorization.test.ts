import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { redis } from "@k2b/cloud";
import { settingsService } from "@k2b/cloud/services";
import { ok } from "@k2b/stdlib";
import { assertAdminWriteAuthorization } from "../../../../scripts/fixtures/admin-read";
import { stubRouterInfrastructure } from "../../../../scripts/fixtures/no-transform";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import routes from ".";

useUnitClients();
afterEach(() => mock.restore());
test("Chat configuration requires ordinary write plus a live admin and supplies audit attribution", async () => {
  stubRouterInfrastructure();
  spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
  const write = spyOn(settingsService.entry, "update").mockResolvedValue(ok(undefined));
  await assertAdminWriteAuthorization(
    (headers) =>
      routes.request("/admin/settings/chat.probe", {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: '{"value":true}',
      }),
    () => write.mock.calls.length,
  );
  expect(write).toHaveBeenCalledWith(
    expect.objectContaining({
      key: "chat.probe",
      audit: expect.objectContaining({
        action: "settings.update",
        actor: { userId: "11111111-1111-4111-8111-111111111111" },
      }),
    }),
  );
});
