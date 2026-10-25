import { expect, test } from "bun:test";
import { assertAdminMutationsRejectReadOAuth, withAdminOAuth } from "../../../../scripts/fixtures/admin-oauth";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { cloudMcpResourceUri, createMcpRoutes } from "./mcp";
import "../../../../scripts/fixtures/authorization-preload";
import { createAppAccessRoutes, createOwnedAppAccessRoutes } from "./app-access";
import { createCoreApiRouter } from "./index";

const unexpectedNotification = async (): Promise<never> => {
  throw new Error("Unexpected notification");
};
const { api: routes } = createCoreApiRouter({
  notifications: {
    sendNewBrowserSignIn: unexpectedNotification,
    sendMagicLink: unexpectedNotification,
    sendIpaLoginHint: unexpectedNotification,
    sendPasswordReset: unexpectedNotification,
  },
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("cloud resource OAuth ceiling", () => {
  test("every protected mutation rejects a real read-only user OAuth token", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      await assertAdminMutationsRejectReadOAuth(routes, readHeaders, (path) =>
        ["/me/", "/ai/", "/approvals/", "/announcements/"].some((prefix) => path.startsWith(prefix)),
      );
    }));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Capability protocol OAuth ceilings", () => {
  test("read tokens can reach queries and reviews but never invoke actions", () =>
    withAdminOAuth(
      async ({ readHeaders }) => {
        for (const path of ["/capabilities/v1/queries/example/read", "/capabilities/v1/actions/example/write/review"]) {
          const response = await routes.request(path, {
            method: "POST",
            headers: { ...readHeaders, "content-type": "application/json" },
            body: "{}",
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toMatchObject({ code: "VALIDATION_FAILED" });
        }
        const response = await routes.request("/capabilities/v1/actions/example/write", {
          method: "POST",
          headers: { ...readHeaders, "content-type": "application/json" },
          body: JSON.stringify({ input: {} }),
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
      },
      { admin: false },
    ));
  test("a read-only resource-audience token can initialize MCP", () =>
    withAdminOAuth(
      async ({ oauthHeaders }) => {
        const appUrl = "https://cloud.example";
        const mcp = createMcpRoutes({ getAppUrl: async () => appUrl });
        const response = await mcp.request("/mcp/v1", {
          method: "POST",
          headers: {
            ...(await oauthHeaders("read", cloudMcpResourceUri(appUrl))),
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "scope-test", version: "1" } },
          }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
      },
      { admin: false },
    ));
});

suiteFor(
  "database",
  "nats",
  "valkey",
)("Framework app-access OAuth ceilings", () => {
  test("read-only OAuth cannot repair or change an application's access list", () =>
    withAdminOAuth(async ({ readHeaders }) => {
      const owner = createOwnedAppAccessRoutes({
        id: "scope-fixture",
        name: "Scope fixture",
        icon: "ti ti-test-pipe",
        description: "Test application",
        routes: ["/api/scope-fixture"],
        access: { kind: "grants" },
      });
      for (const [router, path] of [
        [createAppAccessRoutes(), "/scope-fixture?repair=1"],
        [owner, "/"],
      ] as const) {
        const response = await router.request(path, { method: "POST", headers: readHeaders });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ code: "FORBIDDEN" });
      }
    }));
});
