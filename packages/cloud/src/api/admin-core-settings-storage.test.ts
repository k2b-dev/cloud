import { afterEach, expect, spyOn, test } from "bun:test";
import * as storageConfig from "../_internal/object-store-config";
import { audit } from "../services/audit";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import routes from "./admin-core-settings";

const restores: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
});
const authenticate = (admin: boolean) => {
  restores.push(spyOn(audit, "record").mockResolvedValue());
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000003",
    provider: "local",
    profile: "user",
    effective_admin: admin,
  });
  restores.push(
    spyOn(session, "authenticateRequest").mockResolvedValue({
      user,
      data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00.000Z" },
    }),
  );
};
const check = (signedIn = true) =>
  routes.request("/test-storage", { method: "POST", headers: signedIn ? { Cookie: "session_token=test" } : {} });
test("connection checks require an administrator before touching storage", async () => {
  const connect = spyOn(storageConfig, "testObjectStoreConnection").mockResolvedValue();
  restores.push(connect);
  restores.push(spyOn(session, "authenticateRequest").mockResolvedValue(null));
  expect((await check(false)).status).toBe(401);
  restores.pop()?.mockRestore();
  authenticate(false);
  expect((await check()).status).toBe(403);
  expect(connect).not.toHaveBeenCalled();
});
test("administrator checks use saved configuration and return no credentials", async () => {
  authenticate(true);
  const connect = spyOn(storageConfig, "testObjectStoreConnection").mockResolvedValue();
  restores.push(connect);
  const response = await check();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ ok: true });
  expect(connect).toHaveBeenCalledTimes(1);
  expect(audit.record).toHaveBeenCalledWith(
    expect.objectContaining({ action: "settings.test.storage", actor: { userId: "00000000-0000-4000-8000-000000000003" } }),
  );
});
test("backend failures leave actionable feedback without transport errors or secrets", async () => {
  authenticate(true);
  restores.push(spyOn(storageConfig, "testObjectStoreConnection").mockRejectedValue(new Error("secret-access-key")));
  const response = await check();
  expect(response.status).toBe(502);
  const text = await response.text();
  expect(text).toContain("Check the saved settings");
  expect(text).not.toContain("secret-access-key");
});

test("owned cleanup failures retain the recovery instruction", async () => {
  authenticate(true);
  const message = "Storage test failed at delete; cleanup failed. Remove cloud-connection-test/ objects after fixing the connection.";
  restores.push(spyOn(storageConfig, "testObjectStoreConnection").mockRejectedValue(new storageConfig.ObjectStoreConnectionError(message)));
  const response = await check();
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ message });
});
