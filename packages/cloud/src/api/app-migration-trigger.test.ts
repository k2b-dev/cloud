import { expect, test } from "bun:test";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { formatAppKey } from "../app-key";
import { createAppMigrationTriggerRoutes } from "./app-migration-trigger";

const keyId = "22222222-2222-4222-8222-222222222222";
const value = formatAppKey({
  appId: "acme",
  keyId,
  installationId: "11111111-1111-4111-8111-111111111111",
  seed: APP_KEY_FIXTURES[0].seed,
});
const claims = {
  iss: "https://core.test",
  aud: "app:acme",
  token_use: "app_migration_probe" as const,
  key_id: keyId,
  oauth: true,
  jti: "33333333-3333-4333-8333-333333333333",
  iat: 0,
  nbf: 0,
  exp: 30,
};
const request = { method: "POST", headers: { authorization: "Bearer instruction" } };
test("a valid one-use instruction tests both signed paths with the deployed app identity", async () => {
  const calls: unknown[] = [];
  let consumed = false;
  const routes = createAppMigrationTriggerRoutes("acme", {
    verify: async () => claims,
    key: () => value,
    origin: async () => "https://core.test",
    consume: async () => {
      if (consumed) return false;
      consumed = true;
      return true;
    },
    send: async (request, options) => {
      calls.push({ url: request.url, appId: options.appId, body: await request.json(), redirect: request.redirect });
      return new Response(null, { status: 204 });
    },
  });
  expect((await routes.request("/probe", request)).status).toBe(204);
  expect(calls).toEqual(
    ["identity:invoke", "oauth:issue"].map((scope) => ({
      url: `https://core.test/api/_internal/identity/v1/migration-probe/${scope}`,
      appId: "acme",
      body: { nonce: claims.jti },
      redirect: "follow",
    })),
  );
  expect((await routes.request("/probe", request)).status).toBe(409);
  expect(calls.length).toBe(2);
});
test("unverified instructions, other deployed keys and failed Core probes never pass", async () => {
  const base = { verify: async () => claims, key: () => value, origin: async () => "https://core.test", consume: async () => true };
  expect((await createAppMigrationTriggerRoutes("acme", { ...base, verify: async () => null }).request("/probe", request)).status).toBe(
    401,
  );
  expect((await createAppMigrationTriggerRoutes("other", base).request("/probe", request)).status).toBe(409);
  expect(
    (
      await createAppMigrationTriggerRoutes("acme", { ...base, send: async () => new Response(null, { status: 403 }) }).request(
        "/probe",
        request,
      )
    ).status,
  ).toBe(502);
  expect(
    (
      await createAppMigrationTriggerRoutes("acme", {
        ...base,
        send: async () => {
          throw new Error("offline");
        },
      }).request("/probe", request)
    ).status,
  ).toBe(503);
});
