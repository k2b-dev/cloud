import { expect, test } from "bun:test";
import { createAppMigrationProbeRoutes } from "./app-migration-probe";

const keyId = "22222222-2222-4222-8222-222222222222";
const nonce = "33333333-3333-4333-8333-333333333333";
test("probe authenticates the exact scope and records only successful signed identities", async () => {
  const calls: unknown[] = [];
  const routes = createAppMigrationProbeRoutes(
    async (_c, scope) => {
      calls.push(scope);
      return { appId: "acme", keyId, credentialId: keyId, serviceAccountId: keyId, scope: "identity:invoke" };
    },
    async (input) => {
      calls.push(input);
    },
  );
  for (const scope of ["identity:invoke", "oauth:issue"]) {
    expect((await routes.request(`/${scope}`, { method: "POST", body: JSON.stringify({ nonce }) })).status).toBe(204);
    expect(calls.at(-2)).toBe(scope);
    expect(calls.at(-1)).toEqual({ keyId, scope, nonce });
  }
  expect((await routes.request("/identity:invoke", { method: "POST", body: "{}" })).status).toBe(400);
  expect(calls.length).toBe(5);
  const rejected = createAppMigrationProbeRoutes(
    async () => new Response(null, { status: 403 }),
    async () => {
      throw new Error("Must not record");
    },
  );
  expect((await rejected.request("/oauth:issue", { method: "POST" })).status).toBe(403);
  expect((await rejected.request("/unknown", { method: "POST" })).status).toBe(404);
});
