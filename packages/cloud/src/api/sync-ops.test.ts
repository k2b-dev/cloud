import { describe, expect, test } from "bun:test";
import { sql } from "bun";
import { Hono, type MiddlewareHandler } from "hono";
import { generateKeyPair } from "jose";
import { UserSchema } from "../contracts/shared";
import type { AuthContext } from "../server";
import { syncInvocationOperation } from "../services/identity/invocation-operations";
import { signInvocationToken } from "../services/identity/invocation-token";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import { createSyncOpsProxyRoutes } from "./sync-ops";

const user = UserSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "admin",
  roles: ["admin"],
  provider: "local",
  profile: "user",
  givenname: "Admin",
  sn: "Test",
  displayName: "Admin Test",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const authenticate =
  (scopes?: string[]): MiddlewareHandler<AuthContext> =>
  async (c, next) => {
    c.set("actor", { kind: "user", user });
    c.set("user", user);
    c.set("accessSubject", { type: "user", userId: user.id });
    c.set("credentialKind", scopes ? "oauth" : "session");
    c.set("credentialScopes", scopes ?? []);
    if (scopes) c.set("oauthScopes", scopes);
    await next();
  };
let key: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  key ??= (await generateKeyPair("RS256")).privateKey;
  return callback(
    { kid: "33333333-3333-4333-8333-333333333333", key, issuer: "https://cloud.test", signUntil: new Date(Date.now() + 60_000) },
    sql,
  );
};
const mount = (dependencies: Parameters<typeof createSyncOpsProxyRoutes>[0] = {}) =>
  new Hono().route(
    "/api/admin/sync",
    createSyncOpsProxyRoutes({
      authenticate: authenticate(),
      withActiveSigner,
      getApp: async (id) => ({ id, name: id, description: "", icon: "ti ti-box", baseUrl: "http://app-mail:3000", routes: [] }),
      ...dependencies,
    }),
  );

describe("Core Sync operations broker", () => {
  test("requires authentication and OAuth admin scope before lookup or issuance", async () => {
    const anonymous = new Hono().route("/api/admin/sync", createSyncOpsProxyRoutes());
    expect((await anonymous.request("/api/admin/sync/mail/resources")).status).toBe(401);
    for (const scopes of [[], ["read"], ["write"], ["admin"]]) {
      let lookups = 0;
      const routes = mount({
        authenticate: authenticate(scopes),
        getApp: async () => {
          lookups++;
          return null;
        },
      });
      expect((await routes.request("/api/admin/sync/mail/resources")).status).toBe(scopes.includes("admin") ? 404 : 403);
      expect(lookups).toBe(scopes.includes("admin") ? 1 : 0);
    }
  });

  test("lists the full authenticated administrative fleet including Core and OAuth", async () => {
    const apps = ["core", "oauth", "mail"].map((id) => ({
      id,
      name: id,
      description: "",
      icon: "ti ti-box",
      baseUrl: `http://app-${id}:3000`,
      routes: [],
    }));
    const routes = mount({ listApps: async () => apps });
    const response = await routes.request("/api/admin/sync");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ apps });
    let reads = 0;
    const denied = mount({
      authenticate: authenticate(["read"]),
      listApps: async () => {
        reads++;
        return apps;
      },
    });
    expect((await denied.request("/api/admin/sync")).status).toBe(403);
    expect(reads).toBe(0);
  });

  test("forwards only a method and route bound invocation to the registry target", async () => {
    let forwarded = false;
    const path = "/schedules/mail/mail%3Async-due/run-now";
    const routes = mount({
      signInvocation: async (params) => {
        expect(params.targetAppId).toBe("mail");
        expect(params.callingAppId).toBe("core");
        expect(params.operation).toBe(syncInvocationOperation("POST", path));
        expect(params.operation).not.toBe(syncInvocationOperation("GET", path));
        expect(params.authority.credential_kind).toBe("session");
        return signInvocationToken(params);
      },
      fetch: async (input, init) => {
        forwarded = true;
        expect(String(input)).toBe(`http://app-mail:3000/_internal/sync${path}?audit=1`);
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toStartWith("Bearer ey");
        expect(headers.get("cookie")).toBeNull();
        expect(headers.get("x-untrusted")).toBeNull();
        expect(headers.get("x-request-id")).toBe("request-1");
        expect(init?.redirect).toBe("manual");
        expect(init?.body).toBe(JSON.stringify({ requestId: "run-1" }));
        return Response.json({ runId: "run-1" });
      },
    });
    const response = await routes.request(`/api/admin/sync/mail${path}?audit=1`, {
      method: "POST",
      headers: { cookie: "session_token=source", authorization: "Bearer source", "x-untrusted": "ignore", "x-request-id": "request-1" },
      body: JSON.stringify({ requestId: "run-1" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(forwarded).toBeTrue();
  });

  test("binds dead-letter invocations to their queue or job kind", async () => {
    const operations: string[] = [];
    const forwarded: string[] = [];
    const routes = mount({
      signInvocation: async (params) => {
        operations.push(params.operation);
        return signInvocationToken(params);
      },
      fetch: async (input) => {
        forwarded.push(String(input));
        return Response.json({ deleted: true });
      },
    });
    for (const kind of ["queue", "job"]) {
      const path = `/dead-letters/${kind}/same/message`;
      expect((await routes.request(`/api/admin/sync/mail${path}`, { method: "DELETE" })).status).toBe(200);
      expect(operations.at(-1)).toBe(syncInvocationOperation("DELETE", path));
      expect(forwarded.at(-1)).toBe(`http://app-mail:3000/_internal/sync${path}`);
    }
    expect(operations[0]).not.toBe(operations[1]);
  });

  test("rejects routes outside the operations allowlist before registry lookup", async () => {
    let lookups = 0;
    const routes = mount({
      getApp: async () => {
        lookups++;
        return null;
      },
    });
    for (const [path, method] of [
      ["/resources", "POST"],
      ["/secrets", "GET"],
      ["/dead-letters/a/b", "PATCH"],
      ["/dead-letters/mail/requeue", "POST"],
      ["/dead-letters/mail/message", "DELETE"],
      ["/dead-letters/topic/mail/requeue", "POST"],
    ]) {
      expect((await routes.request(`/api/admin/sync/mail${path}`, { method })).status).toBe(404);
    }
    expect(lookups).toBe(0);
  });

  test("rejects oversized request bodies before signing or dispatch", async () => {
    let signed = false;
    const routes = mount({
      signInvocation: async (params) => {
        signed = true;
        return signInvocationToken(params);
      },
    });
    const response = await routes.request("/api/admin/sync/mail/dead-letters/queue/mail/requeue", {
      method: "POST",
      body: JSON.stringify({ messageId: "x".repeat(16_384) }),
    });
    expect(response.status).toBe(400);
    expect(signed).toBeFalse();
  });

  test("does not follow redirects or relay malformed target responses", async () => {
    for (const upstream of [
      new Response("bad json"),
      new Response(null, { status: 302, headers: { location: "https://elsewhere.test" } }),
    ]) {
      const routes = mount({ fetch: async () => upstream });
      expect((await routes.request("/api/admin/sync/mail/resources")).status).toBe(502);
    }
  });
});
