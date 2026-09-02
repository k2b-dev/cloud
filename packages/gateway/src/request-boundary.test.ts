import { afterEach, describe, expect, test } from "bun:test";
import { createProxyStats, proxyRequest } from "./proxy";
import { isInternalPath } from "./request-boundary";
import { buildRouteTable } from "./trie";
import { tryUpgradeWebSocket } from "./ws-proxy";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const privatePaths = [
  "/api/_internal/identity/v1/invoke",
  "/api/_internal/identity/v1/oauth/token",
  "/api/_internal/identity/v1/mandates/id/confirm",
  "/api/_internal/capabilities/v1/queries/read",
  "/_internal",
  "/api/%5Finternal/widgets/v1/current",
  "/api%2f_internal%2fwidgets/v1/current",
  "/api%5c_internal%5cwidgets/v1/current",
  "/api/unused/../_internal/identity/v1/invoke",
  "/api/%invalid",
];

describe("public gateway request boundary", () => {
  test("leaves normal app and public JWKS routes available", () => {
    for (const path of [
      "/api/me",
      "/api/capabilities/v1/queries/read",
      "/api/search",
      "/_cloud/ready",
      "/.well-known/cloud-session-jwks.json",
      "/app/not_internal",
      "/_internal-example",
    ]) {
      expect(isInternalPath(path)).toBe(false);
    }
  });

  test("rejects reserved paths before HTTP forwarding or WebSocket upgrade", async () => {
    const table = buildRouteTable([{ prefix: "/", appId: "core", baseUrl: "http://core.invalid" }]);
    let forwarded = 0;
    globalThis.fetch = Object.assign(
      async () => {
        forwarded += 1;
        throw new Error("Private request escaped gateway");
      },
      { preconnect: originalFetch.preconnect },
    );
    for (const path of privatePaths) {
      const request = new Request(`https://cloud.test${path}`, { headers: { authorization: "Bearer cld_test", upgrade: "websocket" } });
      expect((await proxyRequest(request, table, createProxyStats(), () => undefined)).status).toBe(404);
      let upgraded = false;
      const result = tryUpgradeWebSocket(
        request,
        {
          upgrade: () => {
            upgraded = true;
            return true;
          },
        },
        table,
        () => undefined,
      );
      expect(result?.status).toBe(404);
      expect(upgraded).toBe(false);
    }
    expect(forwarded).toBe(0);
  });
});
