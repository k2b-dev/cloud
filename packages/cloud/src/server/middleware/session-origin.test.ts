import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { jwtVerify } from "jose";
import { deriveAppPublicKey, importAppPublicKey } from "../../app-key";
import { BOOTSTRAP_BODY, BOOTSTRAP_PATH, BOOTSTRAP_TYPE, signBootstrapProof } from "../../runtime/bootstrap-protocol";
import { oauthTokens } from "../../services/oauth-tokens";
import { serviceAccountCredentials } from "../../services/service-account-credentials";
import { session } from "../../services/session";
import { buildProjectedUser } from "../../services/session/user";
import { type AuthContext, auth } from "./auth";
import { hasRefusedSessionOrigin, sessionOriginGuard } from "./session-origin";

const origin = "https://cloud.example.test";
const guard = () => sessionOriginGuard([], async () => `${origin}/configured/path`);
const cookie = "session_token=web-fixture; pwa_session=app-fixture";

describe("mandatory session origin boundary", () => {
  for (const path of ["/api/auth/logout", "/api/me/sign-ins/sign-out-others", "/api/pulse/bases/base/clear-data", "/app/example/action"]) {
    for (const [label, headers] of [
      ["foreign same-site", { Origin: "https://evil.example.test", "Sec-Fetch-Site": "same-site" }],
      ["cross-site", { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" }],
      ["null", { Origin: "null" }],
      ["missing", {}],
      ["same-site despite canonical Origin", { Origin: origin, "Sec-Fetch-Site": "same-site" }],
      ["cross-site despite canonical Origin", { Origin: origin, "Sec-Fetch-Site": "cross-site" }],
    ] satisfies [string, Record<string, string>][]) {
      test(`${path}: rejects ${label} before handler dispatch`, async () => {
        let writes = 0;
        const app = new Hono().use("*", guard()).post(path, (c) => {
          writes++;
          return c.body(null, 204);
        });
        const response = await app.request(`http://internal-app${path}`, { method: "POST", headers: { Cookie: cookie, ...headers } });
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("INVALID_ORIGIN");
        expect(writes).toBe(0);
      });
    }
  }

  // A no-referrer page posts its own forms with Origin: null; the browser still marks them same-origin.
  for (const [label, headers, status] of [
    ["same-origin with Origin: null", { Origin: "null", "Sec-Fetch-Site": "same-origin" }, 204],
    ["same-origin without Origin", { "Sec-Fetch-Site": "same-origin" }, 204],
    ["same-origin with the public origin", { Origin: origin, "Sec-Fetch-Site": "same-origin" }, 204],
    ["same-origin with another Origin", { Origin: "https://evil.test", "Sec-Fetch-Site": "same-origin" }, 403],
    ["cross-site with Origin: null", { Origin: "null", "Sec-Fetch-Site": "cross-site" }, 403],
    ["same-site with Origin: null", { Origin: "null", "Sec-Fetch-Site": "same-site" }, 403],
    ["a user-started request with Origin: null", { Origin: "null", "Sec-Fetch-Site": "none" }, 403],
    ["neither Origin nor Sec-Fetch-Site", {}, 403],
  ] satisfies [string, Record<string, string>, number][]) {
    test(`a cookie-authenticated POST: ${label} gives ${status}`, async () => {
      const app = new Hono().use(guard()).post("/action", (c) => c.body(null, 204));
      const response = await app.request("http://internal-app/action", { method: "POST", headers: { Cookie: cookie, ...headers } });
      expect(response.status).toBe(status);
    });
  }

  for (const name of ["session_token", "pwa_session"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      test(`${name}: ${method} requires the canonical origin, never internal or forwarded hosts`, async () => {
        const app = new Hono().use(guard()).all("/action", (c) => c.body(null, 204));
        for (const value of [undefined, "null", "http://internal-app", `${origin}/`, "https://forwarded.test"]) {
          const headers = new Headers({ Cookie: `${name}=fixture`, "X-Forwarded-Host": "forwarded.test" });
          if (value) headers.set("Origin", value);
          expect((await app.request("http://internal-app/action", { method, headers })).status).toBe(403);
        }
        expect(
          (await app.request("http://internal-app/action", { method, headers: { Cookie: `${name}=fixture`, Origin: origin } })).status,
        ).toBe(204);
      });
    }
  }

  for (const bodyType of ["text/plain", "multipart/form-data", "application/x-www-form-urlencoded", "application/json", "bodyless"]) {
    test(`checks ${bodyType} before reading the body`, async () => {
      const app = new Hono().use(guard()).post("/write", (c) => c.json({ body: true }));
      const body = bodyType === "bodyless" ? undefined : bodyType === "multipart/form-data" ? new FormData() : '{"value":1}';
      const headers = new Headers({ Cookie: cookie, Origin: "https://evil.example.test", "Sec-Fetch-Site": "same-site" });
      if (bodyType !== "bodyless" && bodyType !== "multipart/form-data") headers.set("Content-Type", bodyType);
      const request = new Request("http://internal-app/write", { method: "POST", headers, body });
      expect((await app.fetch(request)).status).toBe(403);
      expect(request.bodyUsed).toBe(false);
      headers.set("Origin", origin);
      headers.set("Sec-Fetch-Site", "same-origin");
      expect((await app.request("http://internal-app/write", { method: "POST", headers, body })).status).toBe(200);
    });
  }

  test("direct req.json() cannot turn a foreign text/plain POST into a write", async () => {
    let writes = 0;
    const app = new Hono().use(guard()).post("/write", async (c) => {
      const value: unknown = await c.req.json();
      writes++;
      return c.json(value);
    });
    const options = {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "text/plain", Origin: "https://evil.example.test" },
      body: '{"value":1}',
    };
    expect((await app.request("/write", options)).status).toBe(403);
    expect(writes).toBe(0);
    expect((await app.request("/write", { ...options, headers: { ...options.headers, Origin: origin } })).status).toBe(200);
    expect(writes).toBe(1);
  });

  for (const name of ["session_token", "pwa_session"]) {
    test(`${name}: websocket upgrades lose session authority for every refused Origin`, async () => {
      const handler = new Hono().get("/socket", (c) =>
        c.json({ cookie: c.req.header("Cookie") ?? null, refused: hasRefusedSessionOrigin(c.req.raw) }),
      );
      const app = new Hono().use(guard()).all("*", (c) => handler.fetch(c.req.raw));
      const rejectedHeaders: Record<string, string>[] = [
        {},
        { Origin: "null" },
        { Origin: "https://evil.example.test", "Sec-Fetch-Site": "same-site" },
        { Origin: "https://evil.test", "Sec-Fetch-Site": "cross-site" },
        { Origin: origin, "Sec-Fetch-Site": "same-site" },
      ];
      for (const headers of rejectedHeaders) {
        const response = await app.request("/socket", { headers: { Cookie: `${name}=fixture`, Upgrade: "WebSocket", ...headers } });
        expect(await response.json()).toEqual({ cookie: null, refused: true });
      }
      const response = await app.request("/socket", { headers: { Cookie: `${name}=fixture`, Upgrade: "websocket", Origin: origin } });
      expect(await response.json()).toEqual({ cookie: `${name}=fixture`, refused: false });
      const bearer = await app.request("/socket", {
        headers: { Cookie: `${name}=fixture`, Upgrade: "websocket", Authorization: "Bearer own-token" },
      });
      expect(await bearer.json()).toEqual({ cookie: null, refused: false });
    });
  }

  test("read methods and requests without Cloud cookies retain their contract", async () => {
    const app = new Hono().use(guard()).all("/action", (c) => c.body(null, 204));
    for (const method of ["GET", "HEAD", "OPTIONS"])
      expect((await app.request("/action", { method, headers: { Cookie: cookie } })).status).toBe(204);
    expect((await app.request("/action", { method: "POST", headers: { Cookie: "theme=dark" } })).status).toBe(204);
  });

  test("sessionless routes strip both session cookies on all methods and keep protocol cookies", async () => {
    const app = new Hono<AuthContext>()
      .use(sessionOriginGuard(["/wopi/files/:id/contents", "/hooks/:token/*"], async () => origin))
      .use(auth.requireRole("*"))
      .all("*", (c) => c.json({ token: session.getToken(c), cookie: c.req.header("Cookie"), actor: c.get("actor") ?? null }));
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/wopi/files/file/contents?access_token=own-token", "/hooks/own-token/event"]) {
        const response = await app.request(path, {
          method,
          headers: { Cookie: `theme=dark; ${cookie}; grant=own-grant`, Origin: "https://external.test" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ token: null, cookie: "theme=dark; grant=own-grant", actor: null });
      }
    }
    expect((await app.request("/wopi/files/file/contents/other", { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
    expect((await app.request("/hooks-admin", { method: "POST", headers: { Cookie: cookie } })).status).toBe(403);
  });

  test("OAuth Basic credentials and signed device commands retain their own transport with attached cookies", async () => {
    const app = new Hono()
      .use(sessionOriginGuard(["/oauth/token", "/api/auth/app-approval/v1/device"], async () => origin))
      .post("/oauth/token", (c) => c.json({ credential: c.req.header("Authorization"), session: session.getToken(c) }))
      .post("/api/auth/app-approval/v1/device", (c) => c.json({ origin: c.req.header("Origin"), session: session.getToken(c) }));
    const oauth = await app.request("/oauth/token", {
      method: "POST",
      headers: { Cookie: cookie, Authorization: "Basic own-client-proof" },
    });
    expect(oauth.status).toBe(200);
    expect(await oauth.json()).toEqual({ credential: "Basic own-client-proof", session: null });
    const device = await app.request("/api/auth/app-approval/v1/device", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://login.example.test", "Sec-Fetch-Site": "same-site" },
    });
    expect(device.status).toBe(200);
    expect(await device.json()).toEqual({ origin: "https://login.example.test", session: null });
  });

  test("real bearer authentication works without Origin while an invalid bearer never falls back to cookies", async () => {
    const user = buildProjectedUser({ id: "11111111-1111-4111-8111-111111111111", uid: "test", provider: "local", profile: "user" });
    const verify = spyOn(oauthTokens, "verifyAccessToken").mockImplementation(async (token) =>
      token === "valid-bearer" ? { kind: "user", user, scopes: ["write"], payload: {} } : null,
    );
    try {
      const app = new Hono<AuthContext>()
        .use(guard())
        .use(auth.requireRole("authenticated"))
        .post("/write", (c) => c.json({ credential: c.get("credentialKind"), token: session.getWebToken(c) }));
      for (const bearer of ["valid-bearer", "invalid-bearer"]) {
        const response = await app.request("/write", { method: "POST", headers: { Cookie: cookie, Authorization: `Bearer ${bearer}` } });
        expect(response.status).toBe(bearer === "valid-bearer" ? 200 : 401);
        if (bearer === "valid-bearer") expect(await response.json()).toEqual({ credential: "oauth", token: null });
      }
      for (const header of ["Basic abc", "Bearer", "Bearer bad token"]) {
        expect((await app.request("/write", { method: "POST", headers: { Cookie: cookie, Authorization: header } })).status).toBe(403);
      }
    } finally {
      verify.mockRestore();
    }
  });

  test("a signed app-key bootstrap proof uses only its own credential with attached session cookies", async () => {
    const now = new Date("2026-10-30T12:00:00Z");
    const key = {
      installationId: "11111111-1111-4111-8111-111111111111",
      appId: "inventory",
      keyId: "22222222-2222-4222-8222-222222222222",
      seed: Buffer.alloc(32, 7).toString("base64url"),
    };
    const proof = await signBootstrapProof(key, now.getTime());
    const publicKey = await importAppPublicKey(await deriveAppPublicKey(key.seed));
    const app = new Hono().use(guard()).post(BOOTSTRAP_PATH, async (c) => {
      try {
        const { payload } = await jwtVerify(session.getBearerToken(c) ?? "", publicKey, {
          algorithms: ["EdDSA"],
          typ: BOOTSTRAP_TYPE,
          issuer: key.appId,
          audience: `cloud-core:${key.installationId}`,
          currentDate: now,
        });
        return c.json({ appId: payload.sub, cookie: c.req.header("Cookie") ?? null });
      } catch {
        return c.body(null, 401);
      }
    });
    for (const token of [proof, "invalid-app-proof"]) {
      const response = await app.request(BOOTSTRAP_PATH, {
        method: "POST",
        headers: { Cookie: cookie, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: BOOTSTRAP_BODY,
      });
      expect(response.status).toBe(token === proof ? 200 : 401);
      if (token === proof) expect(await response.json()).toEqual({ appId: key.appId, cookie: null });
    }
  });

  test("a resource API key stays the sole authority with an attached session cookie", async () => {
    const accountId = "22222222-2222-4222-8222-222222222222";
    const lookup = spyOn(serviceAccountCredentials, "authenticateApiToken").mockResolvedValue({
      serviceAccount: {
        id: accountId,
        name: "Source",
        kind: "resource_bound",
        status: "active",
        delegatedUserId: null,
        appId: "pulse",
        resourceType: "source",
        resourceId: "source",
        createdBy: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      delegatedUser: null,
      credential: {
        id: "credential",
        serviceAccountId: accountId,
        name: "Ingest",
        kind: "api_token",
        status: "active",
        tokenPrefix: "0123456789abcdef01234567",
        scopes: [],
        expiresAt: null,
        lastUsedAt: null,
        createdBy: null,
        createdAt: "2026-01-01T00:00:00Z",
        revokedAt: null,
        revokedBy: null,
      },
    });
    try {
      const app = new Hono<AuthContext>()
        .use(guard())
        .use(auth.requireRole("authenticated"))
        .post("/ingest", (c) => c.json({ kind: c.get("credentialKind"), subject: c.get("accessSubject"), cookie: session.getWebToken(c) }));
      const response = await app.request("/ingest", {
        method: "POST",
        headers: { Cookie: cookie, Authorization: `Bearer cld_0123456789abcdef01234567_${"0".repeat(64)}` },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        kind: "api_key",
        subject: { type: "service_account", serviceAccountId: accountId },
        cookie: null,
      });
      lookup.mockResolvedValue(null);
      expect(
        (
          await app.request("/ingest", {
            method: "POST",
            headers: { Cookie: cookie, Authorization: `Bearer cld_0123456789abcdef01234567_${"0".repeat(64)}` },
          })
        ).status,
      ).toBe(401);
    } finally {
      lookup.mockRestore();
    }
  });
});
