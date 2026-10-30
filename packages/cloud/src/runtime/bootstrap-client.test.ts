import { expect, test } from "bun:test";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { APP_KEY_FIXTURES } from "../../../../scripts/fixtures/app-key-fixtures";
import { type AppKey, importAppPublicKey } from "../app-key";
import { TEST_SERVER_CERT, TEST_SERVER_KEY } from "../server/services/freeipa/test-certificates.test-fixture";
import { bootstrapConnections } from "./bootstrap-client";
import {
  BOOTSTRAP_BODY,
  BOOTSTRAP_PATH,
  BOOTSTRAP_RESPONSE_BYTES,
  BOOTSTRAP_TYPE,
  type BootstrapResponse,
  bootstrapBodyDigest,
  signBootstrapProof,
} from "./bootstrap-protocol";

const NOW = Date.UTC(2030, 0, 2, 3, 4, 5);
const key: AppKey = {
  installationId: "11111111-1111-4111-8111-111111111111",
  appId: "inventory",
  keyId: "22222222-2222-4222-8222-222222222222",
  seed: APP_KEY_FIXTURES[0].seed,
};
const response = (): BootstrapResponse => ({
  identity: { installationId: key.installationId, appId: key.appId, keyId: key.keyId },
  connections: {
    database: { url: "postgres://core/db_test" },
    valkey: { url: "redis://core" },
    nats: { servers: ["nats://core"], namespace: "test", replicas: 1, ignoreClusterUpdates: false },
    appSecret: { current: "test-secret" },
  },
});
const harness = () => {
  let elapsed = 0;
  const waits: number[] = [];
  const logs: unknown[] = [];
  return {
    waits,
    logs,
    now: () => elapsed,
    wallNow: () => NOW + elapsed,
    random: () => 0.5,
    sleep: async (ms: number) => {
      elapsed += ms;
      waits.push(ms);
    },
    log: (entry: unknown) => {
      logs.push(entry);
    },
  };
};

test("proof binds exact bytes, method, canonical path, identity, time and a fresh nonce", async () => {
  const first = await signBootstrapProof(key, NOW);
  const second = await signBootstrapProof(key, NOW);
  const { payload, protectedHeader } = await jwtVerify(first, await importAppPublicKey(APP_KEY_FIXTURES[0].publicKey), {
    currentDate: new Date(NOW),
    algorithms: ["EdDSA"],
    typ: BOOTSTRAP_TYPE,
  });
  expect(protectedHeader).toEqual({ alg: "EdDSA", typ: BOOTSTRAP_TYPE, kid: key.keyId });
  expect(payload).toMatchObject({
    iss: key.appId,
    sub: key.appId,
    aud: `cloud-core:${key.installationId}`,
    iat: NOW / 1000,
    exp: NOW / 1000 + 30,
    htm: "POST",
    htu: BOOTSTRAP_PATH,
    bdh: await bootstrapBodyDigest(new TextEncoder().encode(BOOTSTRAP_BODY)),
  });
  expect(payload.jti!.length).toBeLessThanOrEqual(64);
  expect(decodeJwt(second).jti).not.toBe(payload.jti);
});

test("lost responses, cold/warm Core and 503 retry with fresh proofs, no redirects, safe logs", async () => {
  const state = harness();
  const proofs: string[] = [];
  const result = await bootstrapConnections(key, "http://core.test", {
    ...state,
    fetch: async (url, init) => {
      expect(url.pathname).toBe(BOOTSTRAP_PATH);
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init.headers);
      proofs.push(headers.get("Authorization")!.slice(7));
      if (proofs.length === 1) throw new Error("lost response postgres://user:PRIVATE@core");
      if (proofs.length === 2) return new Response("PRIVATE", { status: 503 });
      return Response.json(response());
    },
  });
  expect(result).toEqual(response());
  expect(new Set(proofs.map((proof) => decodeJwt(proof).jti)).size).toBe(3);
  expect(state.logs).toEqual([
    { appId: "inventory", attempt: 1, errorClass: "transient" },
    { appId: "inventory", attempt: 2, errorClass: "transient" },
  ]);
  expect(JSON.stringify(state.logs)).not.toContain("PRIVATE");
});

test("429 honours numeric and date Retry-After within the total budget", async () => {
  for (const header of ["2", new Date(NOW + 2000).toUTCString()]) {
    const state = harness();
    let attempts = 0;
    await bootstrapConnections(key, "https://core.test", {
      ...state,
      fetch: async () =>
        ++attempts === 1 ? new Response(null, { status: 429, headers: { "Retry-After": header } }) : Response.json(response()),
    });
    expect(state.waits).toEqual([2000]);
  }
  const state = harness();
  let attempts = 0;
  await expect(
    bootstrapConnections(key, "https://core.test", {
      ...state,
      fetch: async () => {
        attempts++;
        return new Response(null, { status: 503, headers: { "Retry-After": "301" } });
      },
    }),
  ).rejects.toThrow("five-minute startup budget exhausted");
  expect(attempts).toBe(1);
  expect(state.waits).toEqual([]);
});

test("network and TLS/CA failures exhaust a bounded budget without leaking diagnostics", async () => {
  const state = harness();
  let attempts = 0;
  await expect(
    bootstrapConnections(key, "https://core.test", {
      ...state,
      fetch: async () => {
        attempts++;
        throw new Error("certificate PRIVATE seed=secret");
      },
    }),
  ).rejects.toThrow("five-minute startup budget exhausted");
  expect(attempts).toBeGreaterThan(1);
  expect(attempts).toBeLessThan(100);
  expect(state.waits.reduce((sum, wait) => sum + wait, 0)).toBeLessThan(300_000);
  expect(JSON.stringify(state.logs)).not.toContain("PRIVATE");
});

test("4xx, redirects, invalid schema, wrong identities and oversized bodies fail permanently once", async () => {
  const factories = [
    ...[400, 401, 403, 404, 413, 302, 500].map((status) => () => new Response("PRIVATE", { status })),
    () => Response.json({ ...response(), identity: { ...response().identity, appId: "other" } }),
    () => Response.json({ ...response(), identity: { ...response().identity, installationId: "33333333-3333-4333-8333-333333333333" } }),
    () => Response.json({ ...response(), identity: { ...response().identity, keyId: "33333333-3333-4333-8333-333333333333" } }),
    () => Response.json({ connections: {} }),
    () => new Response("{"),
    () => new Response(new Uint8Array([0xff])),
    () => new Response("x".repeat(BOOTSTRAP_RESPONSE_BYTES + 1)),
    () => new Response("", { headers: { "Content-Length": String(BOOTSTRAP_RESPONSE_BYTES + 1) } }),
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(BOOTSTRAP_RESPONSE_BYTES + 1));
          },
          cancel: () => new Promise(() => {}),
        }),
      ),
  ];
  for (const make of factories) {
    const state = harness();
    let attempts = 0;
    await expect(
      bootstrapConnections(key, "http://core.test", {
        ...state,
        fetch: async () => {
          attempts++;
          return make();
        },
      }),
    ).rejects.toThrow("Core bootstrap permanent");
    expect(attempts).toBe(1);
    expect(state.waits).toEqual([]);
  }
});

test("a hung fetch or response body aborts after the attempt deadline, then retries with a fresh proof", async () => {
  for (const body of [false, true]) {
    const state = harness();
    const signals: AbortSignal[] = [];
    const proofs: string[] = [];
    const result = await bootstrapConnections(key, "http://core.test", {
      ...state,
      fetch: async (_, init) => {
        signals.push(init.signal!);
        proofs.push(new Headers(init.headers).get("Authorization")!.slice(7));
        if (signals.length > 1) return Response.json(response());
        if (body) return new Response(new ReadableStream({ start() {} }));
        return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      },
    });
    expect(result).toEqual(response());
    expect(signals[0]!.aborted).toBe(true);
    expect(decodeJwt(proofs[0]!).jti).not.toBe(decodeJwt(proofs[1]!).jti);
  }
}, 25_000);

test("origin validation rejects missing, credentialed, query, path and non-HTTP targets before fetch", async () => {
  for (const origin of [
    undefined,
    "postgres://core",
    "http://user:PRIVATE@core",
    "http://core/path",
    "http://core?query",
    "http://core/#hash",
  ]) {
    await expect(
      bootstrapConnections(key, origin, {
        fetch: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow("CLOUD_CORE_INTERNAL_ORIGIN must be a direct http(s) Core origin");
  }
  expect(decodeProtectedHeader(await signBootstrapProof(key, NOW)).alg).toBe("EdDSA");
});

test("an untrusted TLS certificate fails before any proof reaches the Core HTTP handler", async () => {
  let received = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: TEST_SERVER_CERT, key: TEST_SERVER_KEY },
    fetch: () => {
      received++;
      return Response.json(response());
    },
  });
  let elapsed = 0;
  const logs: unknown[] = [];
  try {
    await expect(
      bootstrapConnections(key, `https://127.0.0.1:${server.port}`, {
        now: () => elapsed,
        wallNow: () => NOW,
        random: () => 0.5,
        sleep: async () => {
          elapsed += 150_000;
        },
        log: (entry) => {
          logs.push(entry);
        },
      }),
    ).rejects.toThrow("five-minute startup budget exhausted");
    expect(received).toBe(0);
    expect(logs).toEqual([
      { appId: "inventory", attempt: 1, errorClass: "transient" },
      { appId: "inventory", attempt: 2, errorClass: "transient" },
    ]);
  } finally {
    await server.stop(true);
  }
});

test("a local proof-generation failure is permanent and never reaches HTTP", async () => {
  let attempts = 0;
  await expect(
    bootstrapConnections({ ...key, seed: "invalid" }, "https://core.test", {
      ...harness(),
      fetch: async () => {
        attempts++;
        return Response.json(response());
      },
    }),
  ).rejects.toThrow("Core bootstrap permanent: could not create Ed25519 startup proof");
  expect(attempts).toBe(0);
});

test("a connection lost while reading the response retries with a fresh proof", async () => {
  const state = harness();
  const proofs: string[] = [];
  const result = await bootstrapConnections(key, "http://core.test", {
    ...state,
    fetch: async (_, init) => {
      proofs.push(new Headers(init.headers).get("Authorization")!.slice(7));
      if (proofs.length > 1) return Response.json(response());
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset PRIVATE"));
          },
        }),
      );
    },
  });
  expect(result).toEqual(response());
  expect(proofs.length).toBe(2);
  expect(decodeJwt(proofs[0]!).jti).not.toBe(decodeJwt(proofs[1]!).jti);
  expect(state.logs).toEqual([{ appId: "inventory", attempt: 1, errorClass: "transient" }]);
});

test("connections_not_permitted is a permanent startup error with no retry", async () => {
  const state = harness();
  let attempts = 0;
  await expect(
    bootstrapConnections(key, "http://core.test", {
      ...state,
      fetch: async () => {
        attempts++;
        return Response.json({ code: "connections_not_permitted" }, { status: 403 });
      },
    }),
  ).rejects.toThrow("connections_not_permitted");
  expect(attempts).toBe(1);
  expect(state.waits).toEqual([]);
  expect(state.logs).toEqual([{ appId: "inventory", attempt: 1, errorClass: "permanent" }]);
});
