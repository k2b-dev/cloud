import { expect, spyOn } from "bun:test";
import { oauthTokens } from "../../packages/cloud/src/services/oauth-tokens";
import { buildProjectedUser } from "../../packages/cloud/src/services/session/user";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", provider: "local", profile: "user", effective_admin: true });

/** Exercise the real role/scope middleware; the owner supplies a harmless reader probe. */
async function assertAdminAuthorization(
  request: (headers: Record<string, string>) => Promise<Response> | Response,
  reads: () => number,
  access: "read" | "write",
) {
  const verify = spyOn(oauthTokens, "verifyAccessToken");
  const headers = { authorization: "Bearer unchanged-token" };
  try {
    for (const scopes of [[access], ["read", "write"], ["admin"]]) {
      verify.mockResolvedValue({ kind: "user", user, scopes, payload: {} });
      const before = reads();
      expect([401, 403]).not.toContain((await request(headers)).status);
      expect(reads()).toBeGreaterThan(before);
      // The same token loses access as soon as the authoritative role changes.
      verify.mockResolvedValue({ kind: "user", user: { ...user, roles: ["user"] }, scopes, payload: {} });
      expect((await request(headers)).status).toBe(403);
      expect(reads()).toBe(before + 1);
      verify.mockResolvedValue({
        kind: "service_account",
        oauthClientId: "fixture",
        delegatedUser: null,
        scopes,
        payload: {},
        serviceAccount: {
          id: "22222222-2222-4222-8222-222222222222",
          name: "Fixture client",
          kind: "standalone",
          status: "active",
          delegatedUserId: null,
          appId: null,
          resourceType: null,
          resourceId: null,
          createdAt: "2026-01-01T00:00:00Z",
          createdBy: null,
        },
      });
      expect((await request(headers)).status).toBe(403);
      expect(reads()).toBe(before + 1);
    }
    for (const scopes of [[], [access === "read" ? "write" : "read"]]) {
      verify.mockResolvedValue({ kind: "user", user, scopes, payload: {} });
      expect((await request(headers)).status).toBe(403);
    }
  } finally {
    verify.mockRestore();
  }
}

export const assertAdminReadAuthorization = (
  request: (headers: Record<string, string>) => Promise<Response> | Response,
  reads: () => number,
) => assertAdminAuthorization(request, reads, "read");
export const assertAdminWriteAuthorization = (
  request: (headers: Record<string, string>) => Promise<Response> | Response,
  writes: () => number,
) => assertAdminAuthorization(request, writes, "write");
