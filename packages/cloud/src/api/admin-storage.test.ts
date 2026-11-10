import { afterEach, expect, spyOn, test } from "bun:test";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { session } from "../services/session";
import { buildProjectedUser } from "../services/session/user";
import { storageBucketStore } from "../services/storage-buckets/store";
import { createAdminStorageRoutes } from "./admin-storage";

useUnitClients();
const restores: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of restores.splice(0).reverse()) spy.mockRestore();
});
const routes = createAdminStorageRoutes();

test("storage administration requires an administrator before reading buckets", async () => {
  const read = spyOn(storageBucketStore, "list").mockResolvedValue([]);
  const authenticate = spyOn(session, "authenticateRequest").mockResolvedValue(null);
  restores.push(read, authenticate);
  expect((await routes.request("/buckets")).status).toBe(401);
  const user = buildProjectedUser({
    id: "00000000-0000-4000-8000-000000000003",
    provider: "local",
    profile: "user",
    effective_admin: false,
  });
  authenticate.mockResolvedValue({
    user,
    data: { userId: user.id, sid: "test", authEpoch: 0, kind: "web", expiresAt: "2099-01-01T00:00:00Z" },
  });
  expect((await routes.request("/buckets", { headers: { Cookie: "session_token=test" } })).status).toBe(403);
  expect(read).not.toHaveBeenCalled();
});

test("validation and unexpected driver failures expose only safe bucket errors", async () => {
  const authorized = createAdminStorageRoutes(async (_c, next) => next());
  const read = spyOn(storageBucketStore, "list").mockRejectedValue(new Error("secret driver credentials"));
  restores.push(read);
  const response = await authorized.request("/buckets");
  expect(response.status).toBe(502);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(await response.text()).not.toContain("secret driver credentials");
  const invalid = await authorized.request("/buckets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ access: "own", secretAccessKey: "secret input" }),
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("secret input");
});
