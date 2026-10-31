import { afterEach, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { runNotificationAttempt } from "../../../chat/src/service/notification-delivery";
import { createSpaceEventOnce } from "../../../mail/src/service/app-integrations";
import { bindProcessApplicationId, clearProcessApplicationId } from "../_internal/process-identity";
import * as registry from "../_internal/registry";
import { formatAppKey } from "../app-key";
import { readResourcePrincipals } from "../capabilities/resource-readers";
import { compileCapabilityManifest } from "../capabilities/testing";
import { env } from "../config/env";
import * as proofs from "../services/app-bootstrap";
import { authenticateSignedAppRequest } from "./authenticate-app-request";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const keyDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_APP_KEY")!;
const originDescriptor = Object.getOwnPropertyDescriptor(env, "CLOUD_CORE_INTERNAL_ORIGIN")!;
beforeEach(() => {
  setSystemTime(NOW);
  bindProcessApplicationId("consumer");
  Object.defineProperty(env, "CLOUD_APP_KEY", {
    value: formatAppKey({
      appId: "consumer",
      installationId: "11111111-1111-4111-8111-111111111111",
      keyId: "22222222-2222-4222-8222-222222222222",
      seed: APP_KEY_FIXTURES[0].seed,
    }),
    configurable: true,
  });
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", { value: "http://core.test", configurable: true });
});
afterEach(() => {
  Object.defineProperty(env, "CLOUD_APP_KEY", keyDescriptor);
  Object.defineProperty(env, "CLOUD_CORE_INTERNAL_ORIGIN", originDescriptor);
  clearProcessApplicationId();
  setSystemTime();
});

test("Core admission passes through the capability reader into Chat's bounded notification deferral", async () => {
  const lookup = spyOn(registry, "getCapability").mockResolvedValue({
    appId: "inventory",
    appName: "Inventory",
    appIcon: "box",
    appDescription: "Inventory",
    endpoint: "http://provider.test",
    manifest: compileCapabilityManifest("inventory", {
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item.", access: { readable: () => [] } } },
    }),
  });
  const routes = new Hono().post("/api/_internal/identity/v1/invoke", async (c) => {
    const result = await authenticateSignedAppRequest(c, "identity:invoke", {
      ingress: async () => ({ limited: true, remaining: 0, resetIn: 1500 }),
    });
    return result instanceof Response ? result : c.json({ unexpected: true });
  });
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        if (!(input instanceof Request)) throw new Error("Expected final Request");
        return routes.request(input);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );
  try {
    const continuations: Array<{ delayMs: number; input: { deferrals?: number; retryUntil?: number } }> = [];
    await runNotificationAttempt({ input: {}, resubmit: (options) => continuations.push(options) }, async () => {
      await readResourcePrincipals({
        ref: { type: "inventory.item", id: "item-1" },
        principals: [{ type: "user", userId: "33333333-3333-4333-8333-333333333333" }],
      });
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(continuations).toEqual([{ delayMs: 2000, input: { deferrals: 1, retryUntil: NOW + 5 * 60_000 } }]);
  } finally {
    transport.mockRestore();
    lookup.mockRestore();
  }
});

test("Core authentication refusals stay permanent in Mail after capability response parsing", async () => {
  for (const code of ["invalid_proof", "wrong_app"] as const) {
    const authenticate = spyOn(proofs, "authenticateAppProof").mockRejectedValue(new proofs.BootstrapProofError(code));
    const routes = new Hono().post("/api/_internal/identity/v1/invoke", async (c) => {
      const result = await authenticateSignedAppRequest(c, "identity:invoke", {
        ingress: async () => ({ limited: false, remaining: 1, resetIn: 1000 }),
      });
      return result instanceof Response ? result : c.json({ unexpected: true });
    });
    const transport = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: Parameters<typeof fetch>[0]) => {
          if (!(input instanceof Request)) throw new Error("Expected final Request");
          return routes.request(input);
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );
    try {
      const result = await createSpaceEventOnce({ spaceId: "Space1" }, "effect-1", {
        mandate: { id: "33333333-3333-4333-8333-333333333333", revision: 1, callingAppId: "consumer" },
      });
      expect(transport).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ ok: false, code, status: code === "invalid_proof" ? 401 : 403 });
    } finally {
      transport.mockRestore();
      authenticate.mockRestore();
    }
  }
});
