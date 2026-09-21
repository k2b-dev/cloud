import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "./client";
import { getServiceSession, login } from "./session";
import { TEST_CA_CERT, TEST_SERVER_CERT, TEST_SERVER_KEY } from "./test-certificates.test-fixture";
import { setFreeIpaTlsResolver } from "./tls";

let server: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  setFreeIpaTlsResolver(async () => ({ ca: TEST_CA_CERT, rejectUnauthorized: true }));
});

afterEach(() => {
  server?.stop(true);
  server = null;
  setFreeIpaTlsResolver(null);
});

const startServer = (fetch: (request: Request) => Response | Promise<Response>) => {
  server = Bun.serve({
    port: 0,
    tls: { cert: TEST_SERVER_CERT, key: TEST_SERVER_KEY },
    fetch,
  });
  return new URL(server.url).host;
};

describe("FreeIPA login failure mapping", () => {
  test("keeps authentication rejection separate from upstream failure", async () => {
    const authHost = startServer(() => new Response("rejected", { status: 401 }));
    await expect(login({ url: authHost, username: "alice", password: "wrong" })).resolves.toEqual({ status: "failed" });
    server?.stop(true);

    const upstreamHost = startServer(() => new Response("unavailable", { status: 503 }));
    await expect(login({ url: upstreamHost, username: "alice", password: "secret" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "upstream",
      status: 503,
    });
    server?.stop(true);

    const throttledHost = startServer(() => new Response("retry later", { status: 429 }));
    await expect(login({ url: throttledHost, username: "alice", password: "secret" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "upstream",
      status: 429,
    });
  });

  test("preserves password-expired and successful session outcomes", async () => {
    let expired = true;
    const host = startServer(() =>
      expired
        ? new Response("", { status: 401, headers: { "X-IPA-Rejection-Reason": "password-expired" } })
        : new Response("", { status: 200, headers: { "Set-Cookie": "ipa_session=session-value; Secure; HttpOnly" } }),
    );

    await expect(login({ url: host, username: "alice", password: "old" })).resolves.toEqual({ status: "password_expired" });
    expired = false;
    await expect(login({ url: host, username: "alice", password: "new" })).resolves.toEqual({
      status: "success",
      session: "session-value",
    });
  });

  test("reopens the cached service session after password rotation", async () => {
    const loginPasswords: string[] = [];
    const host = startServer(async (request) => {
      if (new URL(request.url).pathname.endsWith("/login_password")) {
        const password = new URLSearchParams(await request.text()).get("password") ?? "";
        loginPasswords.push(password);
        return new Response("", { headers: { "Set-Cookie": `ipa_session=${password}; Secure; HttpOnly` } });
      }
      return Response.json({
        result: { result: {}, count: 0, truncated: false, summary: null },
        error: null,
        id: 0,
      });
    });

    await expect(getServiceSession({ url: host, serviceUser: "svc", servicePassword: "old" })).resolves.toBe("old");
    await expect(getServiceSession({ url: host, serviceUser: "svc", servicePassword: "new" })).resolves.toBe("new");
    expect(loginPasswords).toEqual(["old", "new"]);
  });

  test("reuses the cached service session after FreeIPA ping", async () => {
    let loginCount = 0;
    let pingCount = 0;
    const host = startServer((request) => {
      if (new URL(request.url).pathname.endsWith("/login_password")) {
        loginCount += 1;
        return new Response("", { headers: { "Set-Cookie": "ipa_session=session; Secure; HttpOnly" } });
      }
      pingCount += 1;
      return Response.json({ result: { summary: "IPA server is running" }, error: null, id: 0 });
    });

    await expect(getServiceSession({ url: host, serviceUser: "svc", servicePassword: "secret" })).resolves.toBe("session");
    await expect(getServiceSession({ url: host, serviceUser: "svc", servicePassword: "secret" })).resolves.toBe("session");
    expect({ loginCount, pingCount }).toEqual({ loginCount: 1, pingCount: 1 });
  });
});

describe("FreeIPA RPC response validation", () => {
  test("rejects invalid JSON and incomplete RPC envelopes", async () => {
    let responseBody = "{broken";
    const host = startServer(
      () =>
        new Response(responseBody, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
    responseBody = "{}";
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
    responseBody = '{"result":null,"error":null,"id":0}';
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
    responseBody = '{"result":{"result":{}},"id":0}';
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
    responseBody = '{"result":[],"error":null,"id":0}';
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
    responseBody = '{"result":{"summary":"IPA server is running"},"error":null,"id":0}';
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).resolves.toMatchObject({
      result: { summary: "IPA server is running" },
      error: null,
      id: 0,
    });
    responseBody = "null";
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
  });

  test("rejects successful login responses without a session cookie", async () => {
    const host = startServer(() => new Response("", { status: 200 }));
    await expect(login({ url: host, username: "alice", password: "secret" })).rejects.toMatchObject({
      name: "FreeIpaTransportError",
      kind: "invalid_response",
    });
  });

  test("classifies non-JSON upstream failures", async () => {
    const host = startServer(() => new Response("unavailable", { status: 503 }));
    await expect(call({ url: host, ipaSession: "session", method: "ping" })).resolves.toMatchObject({
      result: null,
      error: { code: 503, kind: "upstream" },
    });
  });
});
