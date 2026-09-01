import { describe, expect, test } from "bun:test";
import type { AuthContext } from "../server";
import type { MiddlewareHandler } from "hono";
import { createAdminIdentityRoutes } from "./admin-identity";

const pass: MiddlewareHandler<AuthContext> = async (_c, next) => next();

describe("identity key administration", () => {
  test("requires an administrator by default", async () => {
    expect((await createAdminIdentityRoutes().request("/keys")).status).toBe(401);
  });

  test("returns only operational key metadata", async () => {
    const routes = createAdminIdentityRoutes(pass, {
      status: async () => [
        {
          purpose: "session",
          state: "active",
          kid: "00000000-0000-4000-8000-000000000000",
          alg: "RS256",
          encryptionKeyId: "0123456789abcdef",
          createdAt: "2026-09-01T00:00:00.000Z",
          activateAt: "2026-09-01T00:00:00.000Z",
          signUntil: "2026-10-01T00:00:00.000Z",
          verifyUntil: "2026-10-02T00:00:00.000Z",
          revokedAt: null,
        },
      ],
      rewrap: async () => 0,
      revoke: async () => false,
    });
    const body = await (await routes.request("/keys")).json();
    expect(body.keys[0]).toEqual(expect.objectContaining({ purpose: "session", state: "active", alg: "RS256" }));
    expect(JSON.stringify(body)).not.toContain("private");
  });

  test("rewraps and revokes through bounded commands", async () => {
    const revoked: Array<{ kid: string; reason: string }> = [];
    const routes = createAdminIdentityRoutes(pass, {
      status: async () => [],
      rewrap: async () => 3,
      revoke: async (input) => {
        revoked.push(input);
        return true;
      },
    });

    expect(await (await routes.request("/keys/rewrap", { method: "POST" })).json()).toEqual({ rewrapped: 3 });
    const response = await routes.request("/keys/00000000-0000-4000-8000-000000000000/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "suspected exposure" }),
    });
    expect(response.status).toBe(200);
    expect(revoked).toEqual([{ kid: "00000000-0000-4000-8000-000000000000", reason: "suspected exposure" }]);
  });
});
