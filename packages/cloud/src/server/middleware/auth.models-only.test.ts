import { describe, expect, spyOn, test } from "bun:test";
import { redis } from "bun";
import { Hono } from "hono";
import * as assistantModels from "../../ai/assistant-models";
import { aiRoutes } from "../../ai/routes";
import meRoutes from "../../api/me";
import { AI_INFERENCE_SCOPE } from "../../contracts/shared";
import { authenticateModelsOnlyCredential } from "../../services/identity/models-only-auth";
import { authenticateWorkloadCredential } from "../../services/identity/workload-auth";
import { type AuthenticatedServiceAccountCredential, serviceAccountCredentials } from "../../services/service-account-credentials";
import { buildProjectedUser } from "../../services/session/user";
import * as settings from "../../services/settings";
import { coreSettings } from "../../services/settings/api";
import { type AuthContext, auth } from "./auth";

const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", uid: "models-user", provider: "local", profile: "user" });
const token = "cld_0123456789abcdef01234567_0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const authenticated: AuthenticatedServiceAccountCredential = {
  serviceAccount: {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Personal",
    kind: "user_delegated",
    status: "active",
    delegatedUserId: user.id,
    appId: null,
    resourceId: null,
    resourceType: null,
    createdAt: "2026-10-11T00:00:00Z",
    createdBy: user.id,
  },
  credential: {
    id: "33333333-3333-4333-8333-333333333333",
    serviceAccountId: "22222222-2222-4222-8222-222222222222",
    name: "Models",
    kind: "api_token",
    status: "active",
    scopes: [AI_INFERENCE_SCOPE],
    tokenPrefix: "0123456789abcdef01234567",
    expiresAt: null,
    lastUsedAt: null,
    createdBy: user.id,
    createdAt: "2026-10-11T00:00:00Z",
    revokedAt: null,
    revokedBy: null,
  },
  delegatedUser: user,
};
describe("models-only credential boundary", () => {
  for (const guard of [auth.requireRole("authenticated"), auth.requireUser()]) {
    test("models-only user keys fail normal auth while unscoped keys keep access", async () => {
      const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(authenticated);
      try {
        const app = new Hono<AuthContext>()
          .use(auth.requireRole("authenticated"))
          .use(guard)
          .get("/", (c) => c.text("ok"));
        expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
        lookup.mockResolvedValue({ ...authenticated, credential: { ...authenticated.credential, scopes: [] } });
        expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
      } finally {
        lookup.mockRestore();
      }
    });
  }
  test("models-only keys fail before the real direct-user guards on personal-key mutation routes", async () => {
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(authenticated);
    const readSettings = spyOn(settings, "get").mockResolvedValue(1000);
    const valkey = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
    try {
      for (const [method, path] of [
        ["POST", "/api-keys"],
        ["DELETE", `/api-keys/${authenticated.credential.id}`],
      ] as const) {
        const response = await meRoutes.request(path, {
          method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: method === "POST" ? JSON.stringify({ name: "nested" }) : undefined,
        });
        expect(response.status).toBe(401);
      }
      lookup.mockResolvedValue({ ...authenticated, credential: { ...authenticated.credential, scopes: [] } });
      expect((await meRoutes.request("/api-keys", { method: "POST", headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    } finally {
      lookup.mockRestore();
      readSettings.mockRestore();
      valkey.mockRestore();
    }
  });
  test("the normal AI status response includes the operator switch", async () => {
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      ...authenticated,
      credential: { ...authenticated.credential, scopes: [] },
    });
    const readSettings = spyOn(settings, "get").mockResolvedValue(1000);
    const apiEnabled = spyOn(coreSettings, "get").mockResolvedValue(false);
    const valkey = spyOn(redis, "send").mockResolvedValue([1, 0, "1"]);
    const state = spyOn(assistantModels, "assistantAiSettingsState").mockResolvedValue({
      ok: true,
      enabled: true,
      defaultModelId: "",
      visionModelConfigured: false,
      audioModelConfigured: false,
      error: null,
      firecrawlConfigured: false,
      models: [],
    });
    try {
      const headers = { authorization: `Bearer ${token}` };
      const response = await aiRoutes.request("/status", { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).openaiApi).toEqual({ enabled: false });
      apiEnabled.mockResolvedValue(true);
      expect((await (await aiRoutes.request("/status", { headers })).json()).openaiApi).toEqual({ enabled: true });
    } finally {
      lookup.mockRestore();
      readSettings.mockRestore();
      apiEnabled.mockRestore();
      valkey.mockRestore();
      state.mockRestore();
    }
  });
  test("rejects ai:inference regardless of the service account kind", async () => {
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      ...authenticated,
      serviceAccount: { ...authenticated.serviceAccount, kind: "resource_bound", delegatedUserId: null },
      delegatedUser: null,
    });
    try {
      const app = new Hono<AuthContext>().use(auth.requireRole("authenticated")).get("/", (c) => c.text("ok"));
      expect((await app.request("/", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    } finally {
      lookup.mockRestore();
    }
  });
  test("models-only personal keys never authenticate as an identity workload", async () => {
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(authenticated);
    try {
      expect(await authenticateWorkloadCredential({ token, appId: "core", scope: "identity:invoke" })).toBeNull();
      lookup.mockResolvedValue({
        ...authenticated,
        credential: { ...authenticated.credential, scopes: [AI_INFERENCE_SCOPE, "identity:invoke"] },
      });
      expect(await authenticateWorkloadCredential({ token, appId: "core", scope: "identity:invoke" })).toBeNull();
    } finally {
      lookup.mockRestore();
    }
  });
  test("the dedicated authenticator accepts only the exact active delegated identity", async () => {
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue(authenticated);
    try {
      expect(await authenticateModelsOnlyCredential(token)).toEqual({ user, credentialId: authenticated.credential.id });
      for (const invalid of [
        null,
        { ...authenticated, credential: { ...authenticated.credential, scopes: [] } },
        { ...authenticated, credential: { ...authenticated.credential, status: "revoked" as const } },
        { ...authenticated, credential: { ...authenticated.credential, serviceAccountId: user.id } },
        { ...authenticated, serviceAccount: { ...authenticated.serviceAccount, status: "disabled" as const } },
        { ...authenticated, serviceAccount: { ...authenticated.serviceAccount, kind: "resource_bound" as const } },
        { ...authenticated, serviceAccount: { ...authenticated.serviceAccount, kind: "standalone" as const } },
        { ...authenticated, serviceAccount: { ...authenticated.serviceAccount, delegatedUserId: "another-user" } },
        { ...authenticated, delegatedUser: null },
        { ...authenticated, delegatedUser: { ...user, accountExpires: "2000-01-01T00:00:00Z" } },
      ]) {
        lookup.mockResolvedValue(invalid);
        expect(await authenticateModelsOnlyCredential(token)).toBeNull();
      }
      lookup.mockClear();
      for (const invalid of [null, "session-token", "ey.invalid.oauth"]) expect(await authenticateModelsOnlyCredential(invalid)).toBeNull();
      expect(lookup).not.toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });
});
