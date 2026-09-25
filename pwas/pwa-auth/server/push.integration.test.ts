import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { sendPinnedWebPush } from "@k2b/cloud/services/notifications/web-push-transport";
import { createSync, type Sync } from "@k2b/sync";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { SQL } from "bun";
import webpush from "web-push";
import { createDisposableDatabase, natsServers, suiteFor } from "../../../scripts/fixtures/test-infra";
import { createPushService, migrate, type PushMessage, type PushService } from "./push";
import { createPushRoutes } from "./routes";

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

/** An independent RFC 8291 decryption, so the test checks what a browser would read. */
const decrypt = (body: Buffer, browser: ReturnType<typeof createECDH>, auth: Buffer): PushMessage => {
  const salt = body.subarray(0, 16);
  const idLength = body[20]!;
  const server = body.subarray(21, 21 + idLength);
  const secret = browser.computeSecret(server);
  const ikm = hmac(hmac(auth, secret), Buffer.concat([Buffer.from("WebPush: info\0"), browser.getPublicKey(), server, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const key = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const record = body.subarray(21 + idLength);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce);
  decipher.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
};

type Received = { path: string; headers: Headers; body: Buffer };
const suite = suiteFor("database", "nats");

suite("Cloud Login push service", () => {
  let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let db: SQL;
  let connection: NatsConnection;
  let sync: Sync;
  let service: PushService;
  let fake: ReturnType<typeof Bun.serve>;
  const received: Received[] = [];
  const statuses = new Map<string, number[]>();
  const abort = new AbortController();
  const namespace = `cloud-login-test-${crypto.randomUUID()}`;
  const vapid = { subject: "mailto:ops@example.test", ...webpush.generateVAPIDKeys() };

  beforeAll(async () => {
    database = await createDisposableDatabase("cloud_login_push");
    db = new SQL(database.url);
    await migrate(db);
    await migrate(db);
    fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        received.push({ path, headers: request.headers, body: Buffer.from(await request.arrayBuffer()) });
        return new Response(null, { status: statuses.get(path)?.shift() ?? 201 });
      },
    });
    connection = await connect({ servers: natsServers() });
    sync = createSync({ connection, namespace, application: "cloud-login", defaults: { replicas: 1 } });
    service = createPushService({
      sync,
      vapid,
      db,
      limits: { notificationsPerToken: 3, requestsPerCaller: 4 },
      queue: { delivery: { maxAttempts: 2, backoffMs: [200], ackWaitMs: 5_000, maxInFlight: 16 } },
      // The real pinned transport, pointed at the local fake instead of a public push service.
      send: (subscription, payload, options) =>
        sendPinnedWebPush(subscription, payload, options, {
          resolve: async () => [{ address: "127.0.0.1", family: 4 }],
          request: (target, callback) => httpRequest({ ...target, protocol: "http:", port: fake.port }, callback),
        }),
    });
    await sync.ready();
    await service.start(abort.signal);
  }, 30_000);

  afterAll(async () => {
    abort.abort();
    await sync?.drain({ timeoutMs: 5_000 });
    if (connection) {
      const manager = await jetstreamManager(connection);
      for await (const stream of manager.streams.list())
        if (stream.config.metadata?.["sync.namespace"] === namespace) await manager.streams.delete(stream.config.name);
      await connection.close();
    }
    fake?.stop(true);
    await db?.close();
    await database?.drop();
  });

  const routes = () => createPushRoutes(service);
  const subscribe = async () => {
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = randomBytes(16);
    const path = `/push/${crypto.randomUUID()}`;
    const response = await routes().request("/push/subscriptions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" },
      body: JSON.stringify({
        endpoint: `https://push.example.test${path}`,
        expirationTime: null,
        keys: { p256dh: browser.getPublicKey("base64url"), auth: auth.toString("base64url") },
      }),
    });
    expect(response.status).toBe(201);
    const { token } = (await response.json()) as { token: string };
    return { token, path, browser, auth };
  };
  const notify = (body: unknown, caller = "203.0.113.1") =>
    routes().request("/push/notify", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": caller },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const deliveries = (path: string) => received.filter((item) => item.path === path);
  const until = async (check: () => boolean | Promise<boolean>, timeout = 10_000) => {
    const end = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > end) throw new Error("Timed out");
      await Bun.sleep(50);
    }
  };

  test("stores only a token hash and sends one encrypted wake-up per sign-in request", async () => {
    const phone = await subscribe();
    expect(phone.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db`SELECT token_hash FROM cloud_login.push_subscriptions`;
    expect(JSON.stringify(rows)).not.toContain(phone.token);

    const request = { token: phone.token, cloudOrigin: "https://cloud.example.test", requestRef: crypto.randomUUID() };
    expect((await notify(request)).status).toBe(202);
    expect((await notify(request, "203.0.113.2")).status).toBe(202);
    await until(() => deliveries(phone.path).length === 1);
    const [push] = deliveries(phone.path);
    expect(push!.headers.get("content-encoding")).toBe("aes128gcm");
    expect(push!.headers.get("ttl")).toBe("300");
    expect(push!.headers.get("urgency")).toBe("high");
    expect(push!.headers.get("authorization")).toStartWith("vapid t=");
    expect(decrypt(push!.body, phone.browser, phone.auth)).toEqual({
      v: 1,
      type: "login",
      cloud: request.cloudOrigin,
      ref: request.requestRef,
    });
    await until(async () => (await db`SELECT 1 FROM cloud_login.push_subscriptions WHERE last_success_at IS NOT NULL`).length > 0);
    await Bun.sleep(500);
    expect(deliveries(phone.path)).toHaveLength(1);
  });

  test("a push service 410 deletes the subscription and later notifications answer 410", async () => {
    const phone = await subscribe();
    statuses.set(phone.path, [410]);
    expect((await notify({ token: phone.token, cloudOrigin: "https://cloud.example.test", requestRef: "a" }, "203.0.113.3")).status).toBe(
      202,
    );
    await until(
      async () =>
        (await notify({ token: phone.token, cloudOrigin: "https://cloud.example.test", requestRef: "b" }, "203.0.113.4")).status === 410,
    );
    expect((await routes().request("/push/test", { method: "POST", body: JSON.stringify({ token: phone.token }) })).status).toBe(410);
  });

  test("transient failures retry, then land in the dead-letter queue", async () => {
    const retried = await subscribe();
    statuses.set(retried.path, [500]);
    expect((await notify({ token: retried.token, cloudOrigin: "https://cloud.example.test", requestRef: "r" }, "203.0.113.5")).status).toBe(
      202,
    );
    await until(() => deliveries(retried.path).length === 2);

    const failing = await subscribe();
    statuses.set(failing.path, [503, 503]);
    expect((await notify({ token: failing.token, cloudOrigin: "https://cloud.example.test", requestRef: "d" }, "203.0.113.6")).status).toBe(
      202,
    );
    await until(async () => (await service.queue.deadLetters.list()).length === 1);
    const [row] = await db<
      { failure_count: number }[]
    >`SELECT failure_count FROM cloud_login.push_subscriptions WHERE token_hash IS NOT NULL ORDER BY failure_count DESC LIMIT 1`;
    expect(row?.failure_count).toBe(1);
  });

  test("rate limits apply per token and per caller", async () => {
    const phone = await subscribe();
    const statusesSeen: number[] = [];
    for (const ref of ["1", "2", "3", "4"]) {
      statusesSeen.push(
        (await notify({ token: phone.token, cloudOrigin: "https://cloud.example.test", requestRef: ref }, `192.0.2.${ref}`)).status,
      );
    }
    expect(statusesSeen).toEqual([202, 202, 202, 429]);

    const other = await subscribe();
    const seen: Response[] = [];
    for (const ref of ["1", "2", "3", "4", "5"])
      seen.push(await notify({ token: other.token, cloudOrigin: "https://a.example.test", requestRef: ref }, "192.0.2.99"));
    expect(seen.map((response) => response.status)).toEqual([202, 202, 202, 429, 429]);
    expect(Number(seen[4]!.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("rejects oversized, malformed and unknown requests", async () => {
    expect((await notify("x".repeat(2_000), "198.51.100.10")).status).toBe(413);
    expect((await notify({ token: "short", cloudOrigin: "https://cloud.example.test", requestRef: "r" }, "198.51.100.11")).status).toBe(
      400,
    );
    expect((await notify({ token: "A".repeat(43), cloudOrigin: "javascript:alert(1)", requestRef: "r" }, "198.51.100.12")).status).toBe(
      400,
    );
    expect(
      (await notify({ token: "A".repeat(43), cloudOrigin: "https://cloud.example.test", requestRef: "r", extra: 1 }, "198.51.100.13"))
        .status,
    ).toBe(400);
    expect(
      (await notify({ token: "A".repeat(43), cloudOrigin: "https://cloud.example.test", requestRef: "r" }, "198.51.100.14")).status,
    ).toBe(410);
    const privateEndpoint = await routes().request("/push/subscriptions", {
      method: "POST",
      body: JSON.stringify({ endpoint: "https://127.0.0.1/push", keys: { p256dh: "p".repeat(87), auth: "a".repeat(22) } }),
    });
    expect(privateEndpoint.status).toBe(400);
  });

  test("unsubscribing removes the token", async () => {
    const phone = await subscribe();
    expect((await routes().request(`/push/subscriptions/${phone.token}`, { method: "DELETE" })).status).toBe(204);
    expect((await notify({ token: phone.token, cloudOrigin: "https://cloud.example.test", requestRef: "x" }, "198.51.100.20")).status).toBe(
      410,
    );
  });
});

test("push routes answer 404 when the operator has not configured VAPID", async () => {
  const response = await createPushRoutes(undefined).request("/push/config");
  expect(response.status).toBe(404);
});
