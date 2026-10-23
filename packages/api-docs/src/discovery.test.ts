import { expect, spyOn, test } from "bun:test";
import type { RuntimeAppMeta } from "@k2b/cloud/contracts/app";
import type { AuthContext, RequestAuthority } from "@k2b/cloud/server";
import * as limiting from "@k2b/cloud/server/middleware/rate-limit";
import { Hono } from "hono";

// Only the unrelated distributed limiter is replaced; the actual catalog decision runs.
const limiter = spyOn(limiting, "rateLimit").mockImplementation(() => async (_c, next) => next());
const { apiRoutes } = await import("./api");
limiter.mockRestore();
const { default: pages } = await import("./frontend");
const apps: RuntimeAppMeta[] = [
  { id: "legacy", name: "Legacy", description: "Legacy app", icon: "ti ti-apps", routes: ["/legacy"], openapi: "/legacy/openapi.json" },
  {
    id: "allowed",
    name: "Allowed",
    description: "Allowed app",
    icon: "ti ti-apps",
    routes: ["/allowed"],
    access: { kind: "signedIn" },
    openapi: "/allowed/openapi.json",
  },
  {
    id: "denied",
    name: "Undisclosed",
    description: "Undisclosed app",
    icon: "ti ti-apps",
    routes: ["/denied"],
    access: { kind: "roles", roles: ["admin"] },
    openapi: "/denied/openapi.json",
  },
];
const id = "22222222-2222-4222-8222-222222222222";
const authority: RequestAuthority = {
  actor: {
    kind: "service_account",
    delegatedUser: null,
    scopes: ["read"],
    serviceAccount: {
      id,
      name: "Fictional agent",
      kind: "agent",
      status: "active",
      delegatedUserId: null,
      appId: null,
      resourceType: null,
      resourceId: null,
      createdBy: null,
      createdAt: "2026-10-01T00:00:00Z",
    },
  },
  accessSubject: { type: "service_account", serviceAccountId: id },
  credentialKind: "api_key",
  scopes: ["read"],
};

test("JSON and Scalar hide denied apps while public visitors retain only legacy sources", async () => {
  for (const resolved of [authority, null]) {
    const router = new Hono<AuthContext & { Variables: { runtime: { apps: RuntimeAppMeta[] } } }>()
      .use(async (c, next) => {
        c.set("runtime", { apps });
        if (resolved) {
          c.set("actor", resolved.actor);
          c.set("accessSubject", resolved.accessSubject);
          c.set("credentialKind", resolved.credentialKind);
          c.set("credentialScopes", resolved.scopes);
        }
        await next();
      })
      .route("/api", apiRoutes)
      .route("/page", pages);
    const json = await router.request("/api/sources");
    expect(json.status).toBe(200);
    const body = await json.text();
    expect(body).toContain("Legacy");
    expect(body.includes("Allowed")).toBe(resolved !== null);
    expect(body).not.toContain("Undisclosed");
    expect(body).not.toContain("/denied/");
    const page = await router.request("/page");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Legacy");
    expect(html.includes('"Allowed"')).toBe(resolved !== null);
    expect(html).not.toContain("Undisclosed");
    expect(html).not.toContain("/denied/");
  }
});
