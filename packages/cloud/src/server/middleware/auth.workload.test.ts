import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import type { ServiceAccountCredential } from "../../services/service-account-credentials";
import { serviceAccountCredentials } from "../../services/service-account-credentials";
import type { ServiceAccount } from "../../services/service-accounts";
import type { AuthContext } from "./auth";
import { auth } from "./auth";

const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const serviceAccount: ServiceAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Assistant workload",
  kind: "resource_bound",
  status: "active",
  delegatedUserId: null,
  appId: "assistant",
  resourceType: "cloud.app",
  resourceId: "assistant",
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
};
const credential = (scope: string): ServiceAccountCredential => ({
  id: "22222222-2222-4222-8222-222222222222",
  serviceAccountId: serviceAccount.id,
  name: "Assistant workload",
  kind: "api_token",
  status: "active",
  tokenPrefix: "0123456789abcdef01234567",
  scopes: [scope],
  expiresAt: null,
  lastUsedAt: null,
  createdBy: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  revokedAt: null,
  revokedBy: null,
});

describe("ordinary authentication workload boundary", () => {
  for (const scope of ["identity:invoke", "identity:oauth-issue"] as const) {
    test(`does not admit ${scope} through generic authenticated routes`, async () => {
      const authenticate = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
        serviceAccount,
        credential: credential(scope),
        delegatedUser: null,
      });
      try {
        const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/", (c) => c.text("ok"));
        expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
      } finally {
        authenticate.mockRestore();
      }
    });
  }

  test("keeps ordinary resource-bound API keys available to generic authenticated routes", async () => {
    const authenticate = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      serviceAccount,
      credential: credential("read"),
      delegatedUser: null,
    });
    try {
      const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/", (c) => c.text("ok"));
      expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
    } finally {
      authenticate.mockRestore();
    }
  });
});
