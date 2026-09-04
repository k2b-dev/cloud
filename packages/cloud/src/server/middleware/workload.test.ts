import { describe, expect, test } from "bun:test";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import type { AuthContext } from "./auth";
import { rejectReservedWorkloadCredential } from "./workload";

const workloadAuthentication =
  (scope: "identity:invoke" | "identity:oauth-issue"): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    const serviceAccountId = "11111111-1111-4111-8111-111111111111";
    c.set("actor", {
      kind: "service_account",
      serviceAccount: {
        id: serviceAccountId,
        name: "App workload",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "assistant",
        resourceType: "cloud.app",
        resourceId: "assistant",
        createdBy: null,
        createdAt: "2026-09-02T00:00:00.000Z",
      },
      delegatedUser: null,
      scopes: [scope],
    });
    c.set("accessSubject", { type: "service_account", serviceAccountId });
    c.set("credentialKind", "api_key");
    c.set("credentialScopes", [scope]);
    await next();
  };

describe("reserved workload credential boundary", () => {
  for (const scope of ["identity:invoke", "identity:oauth-issue"] as const) {
    test(`rejects ${scope} at Core public authority entry points`, async () => {
      let reached = 0;
      const reachedHandler = (c: Context<AuthContext>) => {
        reached += 1;
        return c.json({ ok: true });
      };
      const app = new Hono<AuthContext>()
        .use(workloadAuthentication(scope))
        .use(rejectReservedWorkloadCredential)
        .post("/api/_internal/capabilities/v1/queries/get", reachedHandler)
        .post("/api/_internal/capabilities/v1/actions/update", reachedHandler)
        .get("/api/_internal/widgets/v1/current", reachedHandler);

      for (const [path, method] of [
        ["/api/_internal/capabilities/v1/queries/get", "POST"],
        ["/api/_internal/capabilities/v1/actions/update", "POST"],
        ["/api/_internal/widgets/v1/current", "GET"],
      ] as const) {
        const response = await app.request(path, { method });
        expect(response.status).toBe(403);
      }
      expect(reached).toBe(0);
    });
  }

  test("does not reject ordinary resource-bound API keys", async () => {
    const app = new Hono<AuthContext>()
      .use(workloadAuthentication("identity:invoke"))
      .use(async (c, next) => {
        c.set("credentialScopes", ["read"]);
        await next();
      })
      .use(rejectReservedWorkloadCredential)
      .get("/", (c) => c.text("ok"));
    expect((await app.request("/")).status).toBe(200);
  });
});
